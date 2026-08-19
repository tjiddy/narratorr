import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  ConnectorRefreshQueue,
  FlushResolutionError,
  type ConnectorLogContext,
  type ResolveFlush,
} from './connector-refresh-queue.js';
import { createMockLogger } from '../__tests__/helpers.js';
import { ConnectorRequestError, type ConnectorImportBatch, type ConnectorRefreshResult } from '@core/connectors/index.js';
import { CONNECTOR_TIMEOUT_MS } from '@core/utils/constants.js';

// Queue tests use the injected resolver; ConnectorService covers connector-specific DB/adapter resolution.
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
  // Distinguishes same-type connectors in log assertions.
  url?: (id: number) => string;
}

// Mirrors real resolution: disabled returns null; otherwise carry log context into the provider call.
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

    expect(refresh).toHaveBeenCalledTimes(1);
    const batch = refresh.mock.calls[0]![0] as ConnectorImportBatch;
    expect(batch.reasons).toEqual(['import', 'restored']);
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

    const handleRequest = () => { queue.enqueue(1, 'import', ITEM(1)); return 'returned'; };
    expect(handleRequest()).toBe('returned');
    expect(resolve).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 1 }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

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

  it('flushes immediately at maxBatchItems without waiting for the debounce timer (F8)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 3 });

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'import', ITEM(2));
    queue.enqueue(1, 'import', ITEM(3));
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
  });

  it('the maxBatchItems === 1 edge flushes on the first item', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 1 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(1);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items.map((i) => i.bookId)).toEqual([1]);
  });

  it('flushes at the maxBatchWaitMs deadline despite continuous debounce resets (F8)', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh), { debounceMs: 1000, backoffMs: 0, flushTimeoutMs: 0, maxBatchWaitMs: 2500 });

    queue.enqueue(1, 'import', ITEM(1)); // t=0; deadline stays at 2500 despite debounce resets.
    await vi.advanceTimersByTimeAsync(900);
    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(900);
    queue.enqueue(1, 'import', ITEM(3));
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
  });

  it('aborts the signal passed into run when the outer flush timeout fires (F10)', async () => {
    // Collect every attempt's signal, not the latest: a timeout is retryable, so the retry hands in
    // a fresh un-aborted signal and a single `captured` binding would read that one instead.
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 500 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(500);

    expect(signals[0]?.aborted).toBe(true);
  });

  it('delivers its own timeout rather than a leaf error raised from the abort listener, so the flush still retries', async () => {
    // Abort listeners run synchronously, so a leaf rejecting from one settles the race first unless
    // withTimeout rejects before it aborts. The leaf here is the house `abort-verdict-not-error-shape`
    // shape and is deliberately NON-retryable: if it wins, shouldRetry sees retryable false and a
    // timeout silently becomes terminal. Swapping the two statements back reds exactly this case.
    const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('leaf abort', { retryable: false })));
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 500 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('scales the outer flush timeout by the reported request count so a healthy multi-path batch is NOT aborted (AC1)', async () => {
    const BASE = CONNECTOR_TIMEOUT_MS + 5_000;
    // Three sequential requests take 2.5 request budgets: above BASE, below the scaled budget.
    const work = 2.5 * CONNECTOR_TIMEOUT_MS;
    const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((resolve, reject) => {
      const t = setTimeout(() => resolve({ success: true }), work);
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new ConnectorRequestError('aborted', { retryable: false })); });
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 3 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(work);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('control: the SAME long work aborts at the base budget when a single request is reported (AC1)', async () => {
    const BASE = CONNECTOR_TIMEOUT_MS + 5_000;
    // First attempt's signal, not the latest: the timeout is retryable, so a retry follows with a
    // fresh signal. The leaf's own error shape does not decide that — withTimeout's does.
    const signals: AbortSignal[] = [];
    const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise<ConnectorRefreshResult>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
    }));
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 1 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await vi.advanceTimersByTimeAsync(BASE);

    expect(signals[0]?.aborted).toBe(true);
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
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
  });

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

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'restored', ITEM(2));
    queue.enqueue(1, 'rename', ITEM(3));
    queue.enqueue(1, 'import', ITEM(4));
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(1);
    expect(g.maxInFlight).toBe(1);

    g.gates[0]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(2);
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

    expect(g.refresh).toHaveBeenCalledTimes(1);
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

    expect(g.refresh).toHaveBeenCalledTimes(2);
    expect(g.maxInFlight).toBe(2);
    g.gates.forEach((release) => release());
    await vi.advanceTimersByTimeAsync(0);
  });

  it('an item enqueued while a flush is in flight is re-coalesced into a fresh batch, never dropped (AC2 boundary)', async () => {
    const g = gatedRefresh();
    const queue = makeQueue(resolver(g.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 1 });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(g.refresh).toHaveBeenCalledTimes(1);

    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(g.refresh).toHaveBeenCalledTimes(1);

    g.gates[0]!();
    await vi.advanceTimersByTimeAsync(0);

    expect(g.refresh).toHaveBeenCalledTimes(2);
    expect(g.batches.map((b) => b.items.map((i) => i.bookId))).toEqual([[1], [2]]);
    g.gates[1]!();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('resolver returning null is a no-op skip — no run, no retry, no dispatch/failure log; the draining entry self-prunes', async () => {
    const refresh = vi.fn().mockResolvedValue({ success: true });
    const queue = makeQueue(resolver(refresh, { disabled: true }));

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh dispatched');

    const refresh2 = vi.fn().mockResolvedValue({ success: true });
    const queue2 = makeQueue(resolver(refresh2));
    queue2.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh2).toHaveBeenCalledTimes(1);
  });

  it('run failure logs the FULL logContext fields (connectorType/connectorName/url) + serializeError', async () => {
    const refresh = vi.fn().mockRejectedValue(new ConnectorRequestError('still 5xx', { retryable: true }));
    const queue = makeQueue(resolver(refresh));

    queue.enqueue(1, 'import', ITEM(1));
    // Retry exhaustion must remain fire-and-forget.
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

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(batches.map((b) => b.reasons)).toEqual([['import', 'restored'], ['import', 'restored']]);
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

    mode = 'ok';
    queue.enqueue(1, 'import', ITEM(2));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items.map((i) => i.bookId)).toEqual([2]);
  });

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
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

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
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    gates[0]!();
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
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    await vi.advanceTimersByTimeAsync(BACKOFF * 1.3); // Covers maximum retry jitter.
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

      queue.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
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
    queue.enqueue(1, 'restored', ITEM(2));
    queue.enqueue(2, 'import', ITEM(3));

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
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  const DRAIN = 5_000;

  // Reject on abort so the in-flight attempt actually unwinds at the drain deadline.
  function abortAwareRefresh(retryable = false) {
    let captured: AbortSignal | undefined;
    const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise((_resolve, reject) => {
      captured = signal;
      signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable })));
    }));
    return { refresh, get signal() { return captured; } };
  }

  it('stop() resolves within the shutdown drain budget even with a large in-flight batch — bounded by shutdownDrainMs, NOT the scaled withTimeout budget (AC1)', async () => {
    const { refresh } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh, { requestCount: 500 }), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: CONNECTOR_TIMEOUT_MS + 5_000, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    expect(refresh).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = queue.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(DRAIN - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
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
    expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh failed');
  });

  it('a deadline abort does NOT burn a retry — even when the abort error is retryable (AC3)', async () => {
    // retryable=true proves abort state, not error classification, suppresses retry.
    const a = abortAwareRefresh(true);
    const queue = makeQueue(resolver(a.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 1_000, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(a.refresh).toHaveBeenCalledTimes(1);
  });

  it('a chained draining tail does NOT start connector work after shutdown — dropped + warn-logged (AC4)', async () => {
    const a = abortAwareRefresh();
    const queue = makeQueue(resolver(a.refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 2, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    queue.enqueue(1, 'import', ITEM(2));
    queue.enqueue(1, 'import', ITEM(3));
    queue.enqueue(1, 'import', ITEM(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.refresh).toHaveBeenCalledTimes(1);

    const stopPromise = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await stopPromise;
    await vi.advanceTimersByTimeAsync(0);

    expect(a.refresh).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ connectorId: 1, reasons: ['import'], count: 2 }),
      'Connector refresh dropped on shutdown',
    );
  });

  it('warn-logs still-in-flight connectors as dropped at the drain deadline (AC5)', async () => {
    const { refresh } = deferredRefresh();
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

    gates[0]!();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a second stop() after the first bounded stop returned is a no-op — does not re-warn the deadline (F7)', async () => {
    const { refresh } = deferredRefresh();
    const queue = makeQueue(resolver(refresh as unknown as Refresh), { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });

    queue.enqueue(1, 'import', ITEM(1));
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const first = queue.stop();
    await vi.advanceTimersByTimeAsync(DRAIN);
    await first;

    const warnMock = log.warn as unknown as ReturnType<typeof vi.fn>;
    const deadlineWarns = () => warnMock.mock.calls.filter((c: unknown[]) => c[1] === 'Connector refreshes dropped at shutdown drain deadline');
    expect(deadlineWarns()).toHaveLength(1);

    await queue.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(deadlineWarns()).toHaveLength(1);
  });
});
