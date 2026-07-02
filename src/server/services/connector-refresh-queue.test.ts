import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  ConnectorRefreshQueue,
  FlushResolutionError,
  type ConnectorLogContext,
  type ResolveFlush,
} from './connector-refresh-queue.js';
import { createMockLogger } from '../__tests__/helpers.js';
import { ConnectorRequestError, type ConnectorImportBatch, type ConnectorRefreshResult } from '../../core/connectors/index.js';
import { CONNECTOR_TIMEOUT_MS } from '../../core/utils/constants.js';

// The queue touches connector/adapter/DB state ONLY through the injected
// resolveFlush callback, so these tests drive a FAKE resolver (no db/getById/
// getAdapter mocking) — the connector-specific resolution is exercised on the
// ConnectorService side in connector.service.test.ts.
type Refresh = (batch: ConnectorImportBatch, signal: AbortSignal) => Promise<ConnectorRefreshResult>;

const DEFAULT_CTX: Omit<ConnectorLogContext, 'connectorId'> = {
  connectorType: 'audiobookshelf',
  connectorName: 'Test ABS',
  url: 'http://abs.local:13378',
};

interface ResolverOpts {
  requestCount?: number;
  disabled?: boolean;
  ctx?: Partial<Omit<ConnectorLogContext, 'connectorId'>>;
  // Per-connector-id url (disambiguates same-type connectors on the log).
  url?: (id: number) => string;
}

/**
 * A resolveFlush that mirrors the real one: skip (null) when disabled, otherwise
 * run the provided refresh mock as the provider call, carrying a stub logContext.
 */
function resolver(refresh: Refresh, opts: ResolverOpts = {}): ResolveFlush {
  return async (entry) => {
    if (opts.disabled) return null;
    const batch = { reasons: entry.reasons, items: entry.items };
    return {
      requestCount: Math.max(1, opts.requestCount ?? 1),
      logContext: {
        connectorId: entry.connectorId,
        connectorType: opts.ctx?.connectorType ?? DEFAULT_CTX.connectorType,
        connectorName: opts.ctx?.connectorName ?? DEFAULT_CTX.connectorName,
        url: opts.url ? opts.url(entry.connectorId) : (opts.ctx?.url ?? DEFAULT_CTX.url),
      },
      run: (signal) => refresh(batch, signal),
    };
  };
}

describe('ConnectorRefreshQueue', () => {
  const DEBOUNCE = 1000;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeQueue(resolve: ResolveFlush, opts: ConstructorParameters<typeof ConnectorRefreshQueue>[2] = { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 }): ConnectorRefreshQueue {
    return new ConnectorRefreshQueue(resolve, log as never, opts);
  }

  const ITEM = (bookId: number) => ({ bookId, title: `Book ${bookId}`, libraryPath: `/lib/${bookId}` });

  // ── debounce coalescing ──────────────────────────────────────────────────────
  it('coalesces same-reason enqueues into one batch carrying all items', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
    const batch = refresh.mock.calls[0]![0] as ConnectorImportBatch;
    expect(batch.reasons).toEqual(['import']);
    expect(batch.items.map((i) => i.bookId)).toEqual([1, 2]);
  });

  it('coalesces mixed reasons for one connector into ONE flush carrying both reasons and all items (AC3)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    // Debounce key is the connector id alone → one window, one provider refresh.
    expect(refresh).toHaveBeenCalledTimes(1);
    const batch = refresh.mock.calls[0]![0] as ConnectorImportBatch;
    // Both reasons surface on the batch, deduplicated + first-seen order-stable (AC4).
    expect(batch.reasons).toEqual(['import', 'restored']);
    // The union of items from every coalesced reason — nothing dropped (AC7).
    expect(batch.items.map((i) => i.bookId)).toEqual([1, 2]);
  });

  it('debounces per connector-id, not per host (two ids → two flushes)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const resolve = vi.fn(resolver(refresh));
    const queue = makeQueue(resolve);

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(2, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 1 }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 2 }));
  });

  it('defers the flush past the synchronous enqueue call (fire-and-forget)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const resolve = vi.fn(resolver(refresh));
    const queue = makeQueue(resolve);

    // Simulate a request handler that enqueues and returns synchronously.
    const handleRequest = () => { queue.enqueue(1, 'import', ITEM(1)); return 'returned'; };
    expect(handleRequest()).toBe('returned');
    // Nothing resolved/flushed yet — the work is deferred past the request.
    expect(resolve).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 1 }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // ── retry ────────────────────────────────────────────────────────────────────
  it('retries exactly once when run throws a retryable error then succeeds', async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(new ConnectorRequestError('5xx', { retryable: true }))
      .mockResolvedValueOnce({ success: true });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does NOT retry a non-retryable thrown error', async () => {
    const refresh = vi.fn().mockRejectedValue(new ConnectorRequestError('401', { retryable: false }));
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a resolved { success: false } result', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: false, message: 'rejected' });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  // ── structured-outcome log levels + redacted host ────────────────────────────
  it('logs the returned success message (skip counts) instead of a bare debug dispatch (F7)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 2 paths, skipped 1' });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, message: 'refreshed 2 paths, skipped 1' }),
      'Connector refresh dispatched',
    );
  });

  it('logs a warning (not a successful dispatch) when run resolves { success: false } (F7)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: false, message: 'provider rejected the scan' });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, message: 'provider rejected the scan' }),
      'Connector refresh rejected',
    );
  });

  it('warns (NOT info-dispatch) when the result reports skipped items — fallback OFF', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 0 paths, skipped 2 items', skipped: 2, passthrough: 0, resolvedServerPaths: [] });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, message: 'refreshed 0 paths, skipped 2 items' }),
      'Connector refresh ineffective',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh dispatched');
  });

  it('warns when the result reports passthrough items (silent no-op against a remapped server)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 1 paths (1 passthrough — no mapping matched)', skipped: 0, passthrough: 1, resolvedServerPaths: ['/lib/A'] });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, message: expect.stringContaining('passthrough') }),
      'Connector refresh ineffective',
    );
  });

  it('does NOT warn for a fallback-ON rescued batch (fallbackRefreshed>0, skipped:0, passthrough:0) → info dispatched', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 0 paths, 2 no-derivable-path items via full section refresh', skipped: 0, passthrough: 0, fallbackRefreshed: 2, resolvedServerPaths: [] });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, message: expect.stringContaining('full section refresh') }),
      'Connector refresh dispatched',
    );
  });

  it('does NOT warn when skipped:0, passthrough:0, message undefined — 0 must not coerce to "present" (falsy guard)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, skipped: 0, passthrough: 0, message: undefined });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1 }),
      'Connector refresh dispatched',
    );
  });

  it('emits resolvedServerPaths at debug for a successful flush', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 2 paths', skipped: 0, passthrough: 0, resolvedServerPaths: ['/srv/A', '/srv/B'] });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, resolvedServerPaths: ['/srv/A', '/srv/B'] }),
      'Connector resolved server paths',
    );
  });

  it('carries the redacted host (from logContext) on dispatched, rejected, AND failed branches — two same-type connectors disambiguate', async () => {
    const refresh = vi.fn().mockImplementation(async (batch: ConnectorImportBatch) => {
      const which = batch.items[0]!.bookId;
      if (which === 1) return { success: true, message: 'refreshed 1 paths', resolvedServerPaths: ['/x'] };
      if (which === 2) return { success: false, message: 'rejected' };
      throw new ConnectorRequestError('boom', { retryable: false });
    });
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { url: (id) => `http://plex-${id}.local:32400` }));

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(2, 'import', ITEM(2));
    queue.enqueue(3, 'import', ITEM(3));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, url: 'http://plex-1.local:32400' }),
      'Connector refresh dispatched',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 2, url: 'http://plex-2.local:32400' }),
      'Connector refresh rejected',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 3, url: 'http://plex-3.local:32400' }),
      'Connector refresh failed',
    );
  });

  // ── upper bounds: maxBatchItems / maxBatchWaitMs ─────────────────────────────
  it('flushes immediately at maxBatchItems without waiting for the debounce timer (F8)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 3 });

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'import', ITEM(2));
    queue.enqueue(1, 'import', ITEM(3)); // hits the cap → immediate flush
    // Advance LESS than the debounce window: the flush must already have run.
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
  });

  it('the maxBatchItems === 1 edge flushes on the first item', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 1 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(1); // well under debounce

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items.map((i) => i.bookId)).toEqual([1]);
  });

  it('flushes at the maxBatchWaitMs deadline despite continuous debounce resets (F8)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: 1000, backoffMs: 0, flushTimeoutMs: 0, maxBatchWaitMs: 2500 });

    queue.enqueue(1, 'import', ITEM(1));        // t=0, deadline at 2500
    await vi.advanceTimersByTimeAsync(900);     // t=900
    queue.enqueue(1, 'import', ITEM(2));        // resets debounce (would fire ~1900)
    await vi.advanceTimersByTimeAsync(900);     // t=1800
    queue.enqueue(1, 'import', ITEM(3));        // resets debounce (would fire ~2800)
    expect(refresh).not.toHaveBeenCalled();     // neither bound has fired yet
    await vi.advanceTimersByTimeAsync(700);     // t=2500 → deadline pre-empts debounce

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
  });

  // ── withTimeout budget scaling ───────────────────────────────────────────────
  it('aborts the signal passed into run when the outer flush timeout fires (F10)', async () => {
    let captured: AbortSignal | undefined;
    const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((_resolve, reject) => {
      captured = signal;
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 500 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts run
    await vi.advanceTimersByTimeAsync(500);      // outer timeout fires → signal aborts

    expect(captured?.aborted).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('scales the outer flush timeout by the reported request count so a healthy multi-path batch is NOT aborted (AC1)', async () => {
    const BASE = CONNECTOR_TIMEOUT_MS + 5_000; // single-request budget + margin
    // Reports 3 sequential requests; takes 2.5 per-request timeouts total — over
    // the base budget but under the scaled budget (BASE + 2 * CONNECTOR_TIMEOUT_MS).
    const work = 2.5 * CONNECTOR_TIMEOUT_MS;
    const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((resolve, reject) => {
      const t = setTimeout(() => resolve({ success: true }), work);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new ConnectorRequestError('aborted', { retryable: false })); });
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 3 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts run
    await vi.advanceTimersByTimeAsync(work);     // request completes before the scaled budget fires

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled(); // not aborted, not logged as failed
  });

  it('control: the SAME long work aborts at the base budget when a single request is reported (AC1)', async () => {
    const BASE = CONNECTOR_TIMEOUT_MS + 5_000;
    let captured: AbortSignal | undefined;
    const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((_resolve, reject) => {
      captured = signal;
      // Non-retryable so the abort doesn't trigger the retry path — keeps timing simple.
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 1 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(BASE); // base single-request budget elapses → abort

    expect(captured?.aborted).toBe(true);
  });

  it('flushTimeoutMs === 0 disables the watchdog but still threads a live composed signal', async () => {
    let captured: AbortSignal | undefined;
    const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => {
      captured = signal;
      return Promise.resolve({ success: true } as ConnectorRefreshResult);
    });
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
    // A real signal is threaded (never aborts here since the watchdog is off).
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
  });

  // ── per-connector in-flight serialization ────────────────────────────────────
  // A gated run that records peak concurrency per connector id.
  function gatedRefresh() {
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    const batches: ConnectorImportBatch[] = [];
    const refresh = vi.fn((batch: ConnectorImportBatch) => {
      batches.push(batch);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<{ success: true }>((resolve) => {
        gates.push(() => { inFlight--; resolve({ success: true }); });
      });
    });
    return { refresh, gates, batches, get maxInFlight() { return maxInFlight; } };
  }

  it('the cap counts items coalesced ACROSS reasons; cap-triggered flushes for one connector serialize (mixed reasons)', async () => {
    const g = gatedRefresh();
    const queue = makeQueue(resolver(g.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 2 });

    // Synchronous >maxBatchItems burst of MIXED reasons coalesces into one pending
    // entry per connector, so the cap is evaluated against the COMBINED item count.
    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2)); // coalesced → cap(2) → flush #1
    queue.enqueue(1, 'rename', ITEM(3));
    queue.enqueue(1, 'import', ITEM(4));   // coalesced → cap(2) → flush #2 (chained behind #1)
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(1); // only #1 entered; #2 is chained
    expect(g.maxInFlight).toBe(1);

    g.gates[0]!();                          // release #1
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(2); // #2 now runs — still serial
    expect(g.maxInFlight).toBe(1);
    expect(g.batches.map((b) => b.reasons)).toEqual([['import', 'restored'], ['rename', 'import']]);
    expect(g.batches.map((b) => b.items.map((i) => i.bookId))).toEqual([[1, 2], [3, 4]]);
    g.gates[1]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a mixed-reason burst for one connector produces ONE serialized flush, not one per (id, reason) (F1)', async () => {
    const g = gatedRefresh();
    const queue = makeQueue(resolver(g.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(g.refresh).toHaveBeenCalledTimes(1); // ONE flush, not two
    expect(g.maxInFlight).toBe(1);
    expect(g.batches[0]!.reasons).toEqual(['import', 'restored']);
    expect(g.batches[0]!.items.map((i) => i.bookId)).toEqual([1, 2]);
    g.gates[0]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('different connector ids flush concurrently — serialization is per connector, not a global lock (AC2)', async () => {
    const g = gatedRefresh();
    const queue = makeQueue(resolver(g.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(2, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(g.refresh).toHaveBeenCalledTimes(2); // both connectors run in parallel
    expect(g.maxInFlight).toBe(2);
    g.gates.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
  });

  it('an item enqueued while a flush is in flight is re-coalesced into a fresh batch, never dropped (AC2 boundary)', async () => {
    const g = gatedRefresh();
    const queue = makeQueue(resolver(g.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 1 });

    queue.enqueue(1, 'import', ITEM(1)); // maxBatchItems=1 → immediate flush #1
    await vi.advanceTimersByTimeAsync(0);
    expect(g.refresh).toHaveBeenCalledTimes(1); // #1 in flight (gated)

    // New item arrives during the in-flight window → fresh pending entry, immediate
    // flush (cap=1), chained behind the in-flight #1 rather than lost.
    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(g.refresh).toHaveBeenCalledTimes(1); // still serialized — #2 chained, not entered

    g.gates[0]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(2);
    expect(g.batches.map((b) => b.items.map((i) => i.bookId))).toEqual([[1], [2]]); // item 2 NOT dropped
    g.gates[1]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  // ── resolver-null skip (disabled/not-found at flush time) ─────────────────────
  it('resolver returning null is a no-op skip — no run, no retry, no dispatch/failure log; the draining entry self-prunes', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh, { disabled: true }));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh dispatched');

    // The draining entry self-pruned: a fresh (non-disabled) enqueue flushes cleanly.
    const refresh2 = vi.fn().mockResolvedValue({ success: true });
    const queue2 = makeQueue(resolver(refresh2));
    queue2.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh2).toHaveBeenCalledTimes(1);
  });

  // ── failure log context — the three branches (F5 regression guard) ────────────
  it('run failure logs the FULL logContext fields (connectorType/connectorName/url) + serializeError', async () => {
    const refresh = vi.fn().mockRejectedValue(new ConnectorRequestError('still 5xx', { retryable: true }));
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    // Must not throw despite retry exhaustion (fire-and-forget).
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378', error: expect.anything() }),
      'Connector refresh failed',
    );
    const payload = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('secret-key');
  });

  it('retries the SINGLE coalesced mixed-reason batch (not one per reason) and surfaces all reasons on the failed-flush warn (AC5)', async () => {
    const batches: ConnectorImportBatch[] = [];
    const refresh = vi.fn((batch: ConnectorImportBatch) => {
      batches.push(batch);
      return Promise.reject(new ConnectorRequestError('still 5xx', { retryable: true }));
    });
    const queue = makeQueue(resolver(refresh as unknown as Refresh));

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    // One coalesced batch, attempted twice (initial + single retry) — never split per reason.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(batches.map((b) => b.reasons)).toEqual([['import', 'restored'], ['import', 'restored']]);
    // Terminal failure warn reflects every coalesced reason, not a scalar.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, reasons: ['import', 'restored'], count: 2 }),
      'Connector refresh failed',
    );
  });

  it('a resolver failure WITH context (FlushResolutionError) logs the FULL connector-derived fields + the ORIGINAL error, no crash', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const refresh = vi.fn();
      const zodErr = new z.ZodError([]);
      // Resolver throws after the row was resolved — carries logContext (F5).
      const resolve: ResolveFlush = async (entry) => {
        throw new FlushResolutionError(
          { connectorId: entry.connectorId, connectorType: 'plex', connectorName: 'My Plex', url: 'http://plex.local:32400' },
          zodErr,
        );
      };
      const queue = makeQueue(resolve);

      queue.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await vi.advanceTimersByTimeAsync(0);

      expect(refresh).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, connectorType: 'plex', connectorName: 'My Plex', url: 'http://plex.local:32400', reasons: ['import'], count: 1, error: expect.anything() }),
        'Connector refresh failed',
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a resolver failure WITHOUT context (bare throw) degrades connectorType/connectorName/url to undefined, keeps connectorId/reasons/count', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // getById-rejected shape: no row was ever resolved, so no logContext.
      const resolve: ResolveFlush = async () => { throw new Error('db is down'); };
      const queue = makeQueue(resolve);

      queue.enqueue(7, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await vi.advanceTimersByTimeAsync(0);

      const call = (log.warn as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[1] === 'Connector refresh failed');
      expect(call).toBeDefined();
      const payload = call![0] as Record<string, unknown>;
      expect(payload).toMatchObject({ connectorId: 7, reasons: ['import'], count: 1 });
      expect(payload.connectorType).toBeUndefined();
      expect(payload.connectorName).toBeUndefined();
      expect(payload.url).toBeUndefined();
      expect(payload.error).toBeDefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('removes the pending key after a failing flush so a later enqueue schedules a fresh flush', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const refresh = vi.fn().mockResolvedValue({ success: true });
    // Resolver throws with context on the first (fail) round, resolves on the second.
    const resolve: ResolveFlush = async (entry) => {
      if (mode === 'fail') {
        throw new FlushResolutionError(
          { connectorId: entry.connectorId, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378' },
          new z.ZodError([]),
        );
      }
      const batch = { reasons: entry.reasons, items: entry.items };
      return { requestCount: 1, logContext: { connectorId: entry.connectorId, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378' }, run: (signal: AbortSignal) => refresh(batch, signal) };
    };
    const queue = makeQueue(resolve);

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);

    // The key is gone (no stuck entry): a fresh enqueue + debounce flushes again.
    mode = 'ok';
    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items.map((i) => i.bookId)).toEqual([2]);
  });

  // ── shutdown drain: stop() ───────────────────────────────────────────────────
  // A manually-gated run: each call parks until its gate is released.
  function deferredRefresh() {
    const gates: Array<() => void> = [];
    const refresh = vi.fn(() => new Promise<{ success: true }>((resolve) => {
      gates.push(() => resolve({ success: true }));
    }));
    return { refresh, gates };
  }

  it('stop() before the debounce window drops the pending batch (clear path): no flush, warn logged, no throw', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await expect(queue.stop()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // the cleared timers must NOT fire a flush

    expect(refresh).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, reasons: ['import'], count: 1 }),
      'Connector refresh dropped on shutdown',
    );
  });

  it('stop() awaits an in-flight flush — does not resolve until run settles', async () => {
    const { refresh, gates } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; run in flight (gated)
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // still awaiting the in-flight draining chain

    gates[0]!(); // settle run
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it('stop() waits out an in-flight retry backoff (shutdown landing mid-backoff)', async () => {
    const BACKOFF = 500;
    const refresh = vi.fn()
      .mockRejectedValueOnce(new ConnectorRequestError('5xx', { retryable: true }))
      .mockResolvedValueOnce({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: BACKOFF, flushTimeoutMs: 0 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; first attempt rejects → enters backoff sleep
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); // mid-backoff: the in-flight flush (in draining) hasn't settled

    await vi.advanceTimersByTimeAsync(BACKOFF * 1.3); // backoff (+ max jitter) elapses → retry runs & succeeds
    await stopPromise;
    expect(stopped).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('enqueue() after stop() is a no-op — no flush scheduled or executed', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh));

    await queue.stop();
    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).not.toHaveBeenCalled();
  });

  it('unref()s the debounce, deadline, and request-timeout queue timers so none pins the event loop (AC3)', async () => {
    const unrefs: Array<ReturnType<typeof vi.fn>> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const handle = realSetTimeout(fn, ms) as ReturnType<typeof setTimeout>;
      const origUnref = handle.unref.bind(handle);
      const u = vi.fn(() => origUnref());
      handle.unref = u as unknown as typeof handle.unref;
      unrefs.push(u);
      return handle;
    }) as unknown as typeof setTimeout);
    try {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 1000 });

      queue.enqueue(1, 'import', ITEM(1));         // arms debounce + deadline timers
      await vi.advanceTimersByTimeAsync(DEBOUNCE);  // flush → withTimeout arms the request-timeout timer

      expect(refresh).toHaveBeenCalledTimes(1);
      // debounce + deadline + request-timeout = 3 queue timers, every one unref()'d.
      expect(unrefs.length).toBeGreaterThanOrEqual(3);
      for (const u of unrefs) expect(u).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore();
    }
  });

  it('warn-logs each dropped pending entry on stop() with connector id, ALL coalesced reasons + item count (AC5)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2)); // coalesced into connector 1's entry → count 2, two reasons
    queue.enqueue(2, 'import', ITEM(3));    // distinct connector → its own entry

    await queue.stop();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, reasons: ['import', 'restored'], count: 2 }),
      'Connector refresh dropped on shutdown',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 2, reasons: ['import'], count: 1 }),
      'Connector refresh dropped on shutdown',
    );
  });

  it('stop() is idempotent — a second call does not throw or re-flush', async () => {
    const { refresh, gates } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh).toHaveBeenCalledTimes(1);

    const first = queue.stop();
    const second = queue.stop();
    gates[0]!();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1); // no duplicate flush
  });

  // ── bounded shutdown drain (#1512) ──────────────────────────────────────────
  const DRAIN = 5_000;

  // A run that records its AbortSignal and rejects when it fires — so the
  // in-flight attempt actually unwinds at the drain deadline.
  function abortAwareRefresh(retryable = false) {
    let captured: AbortSignal | undefined;
    const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise((_resolve, reject) => {
      captured = signal;
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable })));
    }));
    return { refresh, get signal() { return captured; } };
  }

  it('stop() resolves within the shutdown drain budget even with a large in-flight batch — bounded by shutdownDrainMs, NOT the scaled withTimeout budget (AC1)', async () => {
    const { refresh } = deferredRefresh(); // 500-path batch in flight, never settles on its own
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 500 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: CONNECTOR_TIMEOUT_MS + 5_000, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; in-flight in `draining`
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(DRAIN - 1);
    expect(stopped).toBe(false); // still draining just under the budget
    await vi.advanceTimersByTimeAsync(1); // budget elapses → bounded resolve
    await stopPromise;
    expect(stopped).toBe(true);
  });

  it('aborts the in-flight run signal when the drain budget elapses (AC2)', async () => {
    const a = abortAwareRefresh();
    const queue = makeQueue(resolver(a.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(a.signal?.aborted).toBe(false);

    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;
    expect(a.signal?.aborted).toBe(true);
    // The abort is an intentional cancellation — NOT double-logged as a failure.
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh failed');
  });

  it('a deadline abort does NOT burn a retry — even when the abort error is retryable (AC3)', async () => {
    // retryable:true proves it's the ABORT, not retryability, that stops the retry.
    const a = abortAwareRefresh(true);
    const queue = makeQueue(resolver(a.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 1_000, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(a.refresh).toHaveBeenCalledTimes(1); // aborted attempt not retried
  });

  it('a chained draining tail does NOT start connector work after shutdown — dropped + warn-logged (AC4)', async () => {
    const a = abortAwareRefresh(); // active attempt rejects on abort so the chain unwinds
    const queue = makeQueue(resolver(a.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 2, shutdownDrainMs: DRAIN });

    // Cap-triggered chain for ONE connector: #1 active, #2 queued behind it.
    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'import', ITEM(2)); // cap → flush #1 (active)
    queue.enqueue(1, 'import', ITEM(3));
    queue.enqueue(1, 'import', ITEM(4)); // cap → flush #2 (chained tail)
    await vi.advanceTimersByTimeAsync(0);
    expect(a.refresh).toHaveBeenCalledTimes(1); // only #1 entered; #2 chained

    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;
    await vi.advanceTimersByTimeAsync(0); // let the active unwind + the tail short-circuit

    // The tail must never enter run, even after the active attempt unwound.
    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, reasons: ['import'], count: 2 }),
      'Connector refresh dropped on shutdown',
    );
  });

  it('warn-logs still-in-flight connectors as dropped at the drain deadline (AC5)', async () => {
    const { refresh } = deferredRefresh(); // never settles, ignores abort → still in flight at deadline
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorIds: [1], count: 1 }),
      'Connector refreshes dropped at shutdown drain deadline',
    );
  });

  it('a small batch that settles before the deadline drains fully — no premature abort, no dropped warn (regression)', async () => {
    const { refresh, gates } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    gates[0]!(); // genuine completion well inside the budget
    await stopPromise;
    expect(stopped).toBe(true);
    expect(log.warn).not.toHaveBeenCalled(); // no premature deadline abort / dropped warn
  });

  it('a second stop() after the first bounded stop returned is a no-op — does not re-warn the deadline (F7)', async () => {
    const { refresh } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const first = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN); // first resolves at the deadline (drops + warns once)
    await first;

    const warnMock = log.warn as unknown as ReturnType<typeof vi.fn>;
    const deadlineWarns = () => warnMock.mock.calls.filter((c: unknown[]) => c[1] === 'Connector refreshes dropped at shutdown drain deadline');
    expect(deadlineWarns()).toHaveLength(1);

    await queue.stop(); // second call in the post-deadline window
    await vi.advanceTimersByTimeAsync(0);
    expect(deadlineWarns()).toHaveLength(1); // not re-warned
  });
});
