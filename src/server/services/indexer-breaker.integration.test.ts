/**
 * The #2376 breaker across the seams it actually has to hold: the three search entry points, the
 * health probe that feeds and reopens it, and the aggregate ladder that reads its counters.
 *
 * Fake clock throughout — `nextAttemptAt` is an epoch comparison specifically so time can be
 * injected, so nothing here waits on a timer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { HealthCheckService } from './health-check.service.js';
import { createAggregateExecutor } from './search-ladder-execution.js';
import { runQueryLadder, buildQueryLadder } from './search-query-ladder.js';
import { NOOP_SINK, type SearchEventSink } from './search-event-sink.js';
import { INDEXER_BACKOFF_BASE_MS } from './indexer-failure-state.js';
import { runRssJob } from '../jobs/rss.js';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService, type MockLogger } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { indexerErrorEventSchema } from '@shared/schemas/search-stream.js';
import { IndexerAuthError } from '@core/indexers/errors.js';
import { AudioBookBayIndexer } from '@core/indexers/abb.js';
import { abbThrottle, _resetAbbThrottleForTesting } from '@core/indexers/abb-throttle.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { DownloadClientService } from './download-client.service.js';
import type { NotifierService } from './notifier.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookListService } from './book-list.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const MINUTE = 60_000;
const REFUSED = 'Connection refused on port 443';

const ROW_A = createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://t.test', apiKey: 'k' } });
const ROW_B = createMockDbIndexer({ id: 2, name: 'Newznab', type: 'newznab', priority: 60, settings: { apiUrl: 'https://n.test', apiKey: 'k' } });

function emptyResponse(titles: string[] = []) {
  return {
    results: titles.map((title) => ({ title, indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: `magnet:?xt=urn:btih:${title}` })),
    parseStats: { itemsObserved: titles.length, kept: titles.length, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

/** Pull the single consumer-threw warn line, so callers assert its fields rather than its count. */
function expectConsumerThrewLog(harness: { log: MockLogger }): [Record<string, unknown>, string] {
  const calls = harness.log.warn.mock.calls
    .filter(([, message]) => message === 'Search event consumer threw — report dropped');
  expect(calls).toHaveLength(1);
  return calls[0] as [Record<string, unknown>, string];
}

/**
 * `toMatchObject({ message })` reads through `Error.prototype.message`, so it passes against a raw
 * Error and would stay green if `serializeError` were deleted. Pin the own-enumerable key set.
 */
function expectSerializedError(logged: unknown, message: string): void {
  expect(logged).not.toBeInstanceOf(Error);
  expect(Object.keys(logged as object).sort()).toEqual(['message', 'stack', 'type']);
  expect(logged).toMatchObject({ message, type: 'Error' });
}

function build(rows = [ROW_A]) {
  const clock = { now: 0 };
  const db = createMockDb();
  db.select.mockReturnValue(mockDbChain(rows));
  db.update.mockReturnValue(mockDbChain(rows));
  const log = createMockLogger();
  const service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log), undefined, () => clock.now);
  const search = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), service);

  const adapterSearch = vi.fn().mockResolvedValue(emptyResponse());
  const adapterTest = vi.fn().mockResolvedValue({ success: true, message: 'Connected' });
  const getAdapter = vi.spyOn(service, 'getAdapter').mockImplementation(async () => ({
    type: 'torznab', name: 'Torznab', search: adapterSearch, test: adapterTest,
  }) as never);

  return { clock, db, log, service, search, adapterSearch, adapterTest, getAdapter };
}

describe('#2376 the regression — a failing indexer under a sequential search driver', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  /**
   * This driver runs with NO health check. Its timings are therefore the pure AC1 schedule — a
   * search-only UPPER BOUND, not the production timeline, which AC7's health cadence makes far
   * shorter (see the health-driven suite below).
   */
  async function driveSeconds(seconds: number, harness: ReturnType<typeof build>, calls: number[]) {
    for (let t = 0; t <= seconds; t += 2) {
      harness.clock.now = t * 1000;
      const before = harness.adapterSearch.mock.calls.length;
      await harness.search.searchAllWithStatus('the way of kings');
      if (harness.adapterSearch.mock.calls.length > before) calls.push(t);
    }
  }

  it('issues exactly six adapter calls in the first simulated hour, on the AC1 schedule', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    const calls: number[] = [];

    await driveSeconds(3600, harness, calls);

    expect(calls).toEqual([0, 60, 180, 420, 900, 1860]);
  });

  it('goes terminal on the eighth attempt and never calls the adapter again, however far the clock runs', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    const calls: number[] = [];

    await driveSeconds(7400, harness, calls);
    expect(calls).toEqual([0, 60, 180, 420, 900, 1860, 3780, 7380]);
    expect(harness.service.getFailureSnapshot(1).state).toBe('stopped');

    const afterStop = harness.adapterSearch.mock.calls.length;
    harness.clock.now = 30 * 24 * 60 * 60_000;
    await harness.search.searchAllWithStatus('the way of kings');
    expect(harness.adapterSearch.mock.calls.length).toBe(afterStop);
  });

  it('counterfactual: with the gate never denying, the same driver issues 1801 calls', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    vi.spyOn(harness.service, 'reserveSearchAttempt').mockImplementation((id) => ({
      allowed: true,
      generation: harness.service.getFailureGeneration(id),
      snapshot: harness.service.getFailureSnapshot(id),
    }));
    const calls: number[] = [];

    await driveSeconds(3600, harness, calls);

    expect(calls).toHaveLength(1801);
  });
});

describe('#2376 AC2 — a suppressed indexer costs no I/O at all', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  it('reaches neither getAdapter nor the adapter search while the gate is shut', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('kings');
    harness.getAdapter.mockClear();
    harness.adapterSearch.mockClear();

    harness.clock.now = 30_000;
    await harness.search.searchAllWithStatus('kings');

    expect(harness.getAdapter).not.toHaveBeenCalled();
    expect(harness.adapterSearch).not.toHaveBeenCalled();
  });

  it('resumes issuing I/O once the gate reopens', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('kings');
    harness.adapterSearch.mockClear();

    harness.clock.now = INDEXER_BACKOFF_BASE_MS;
    await harness.search.searchAllWithStatus('kings');

    expect(harness.adapterSearch).toHaveBeenCalledTimes(1);
  });

  it('never suppresses a healthy sibling in the same fan-out', async () => {
    const harness = build([ROW_A, ROW_B]);
    const failing = vi.fn().mockRejectedValue(new Error(REFUSED));
    const healthy = vi.fn().mockResolvedValue(emptyResponse(['Kings']));
    harness.getAdapter.mockImplementation(async (indexer) => ({
      type: 'torznab', name: indexer.name,
      search: indexer.id === 1 ? failing : healthy,
      test: vi.fn(),
    }) as never);
    await harness.search.searchAllWithStatus('kings');
    harness.clock.now = 30_000;

    const outcome = await harness.search.searchAllWithStatus('kings');

    expect(outcome.succeeded).toBe(1);
    expect(outcome.skipped.map((s) => s.indexerId)).toEqual([1]);
    expect(outcome.results).toHaveLength(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(healthy).toHaveBeenCalledTimes(2);
  });
});

describe('#2376 AC6 — the skip is reported, not silent', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  async function trip(harness: ReturnType<typeof build>, error: unknown = new Error(REFUSED)) {
    harness.adapterSearch.mockRejectedValue(error);
    await harness.search.searchAllWithStatus('kings');
    harness.clock.now += 1_000;
  }

  it('returns the aggregate skip descriptor and counts it in neither succeeded nor failed', async () => {
    const harness = build();
    await trip(harness);

    const outcome = await harness.search.searchAllWithStatus('kings');

    expect(outcome).toMatchObject({ succeeded: 0, failed: 0, results: [] });
    expect(outcome.skipped).toEqual([{ indexerId: 1, name: 'Torznab', state: 'backing-off', reason: REFUSED }]);
  });

  it('words a stopped skip exactly once, and identically on the streaming path', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new IndexerAuthError('Torznab', REFUSED));
    await harness.search.searchAllWithStatus('kings');

    const aggregate = await harness.search.searchAllWithStatus('kings');
    const onError = vi.fn();
    await harness.search.searchAllStreaming('kings', undefined, new Map(), { onComplete: vi.fn(), onError });

    const wording = `Skipped — ${aggregate.skipped[0]!.state}: ${aggregate.skipped[0]!.reason}`;
    expect(wording).toBe(`Skipped — stopped: ${REFUSED}`);
    expect(onError).toHaveBeenCalledWith(1, 'Torznab', `Skipped — stopped: ${REFUSED}`, 0);
  });

  it('logs the skip at info with breakerState and reason as own fields, on every path', async () => {
    const harness = build();
    await trip(harness);
    (harness.log.info as ReturnType<typeof vi.fn>).mockClear();

    await harness.search.searchAllWithStatus('kings');
    await harness.search.searchAllStreaming('kings', undefined, new Map(), { onComplete: vi.fn(), onError: vi.fn() });
    await harness.search.pollRss(ROW_A);

    const skipLines = (harness.log.info as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, message]) => message === 'Indexer search skipped — breaker open');
    expect(skipLines).toHaveLength(3);
    for (const [fields] of skipLines) {
      expect(fields).toMatchObject({ indexer: 'Torznab', indexerId: 1, breakerState: 'backing-off', reason: REFUSED });
      expect(typeof (fields as { nextAttemptAt: number }).nextAttemptAt).toBe('number');
    }
    // `debug` would hide a skip that makes a wanted book unobtainable.
    expect((harness.log.debug as ReturnType<typeof vi.fn>).mock.calls
      .filter(([, message]) => message === 'Indexer search skipped — breaker open')).toHaveLength(0);
  });

  it('returns the skipped array even with no listener at all', async () => {
    const harness = build();
    await trip(harness);

    const executor = createAggregateExecutor({ id: 1, title: 'Kings' }, harness.search, NOOP_SINK, inject<FastifyBaseLogger>(harness.log));
    const outcome = await executor({ query: 'kings', author: undefined, tag: 'full', lossy: false } as never);

    expect(outcome.succeeded).toBe(0);
    expect((await harness.search.searchAllWithStatus('kings')).skipped).toHaveLength(1);
  });

  it('forwards every aggregate skip to the sink the executor now receives', async () => {
    const harness = build();
    await trip(harness);
    const sink = { ...NOOP_SINK, indexerError: vi.fn() } as SearchEventSink;

    const executor = createAggregateExecutor({ id: 1, title: 'Kings' }, harness.search, sink, inject<FastifyBaseLogger>(harness.log));
    await executor({ query: 'kings', author: undefined, tag: 'full', lossy: false } as never);

    expect(sink.indexerError).toHaveBeenCalledWith(1, 'Torznab', `Skipped — backing-off: ${REFUSED}`, 0);
  });

  it('survives a sink that throws, without losing results or corrupting breaker state', async () => {
    const harness = build();
    await trip(harness);
    const sink = { ...NOOP_SINK, indexerError: vi.fn(() => { throw new Error('sink exploded'); }) } as SearchEventSink;
    const before = harness.service.getFailureSnapshot(1);

    const executor = createAggregateExecutor({ id: 1, title: 'Kings' }, harness.search, sink, inject<FastifyBaseLogger>(harness.log));

    await expect(executor({ query: 'kings', author: undefined, tag: 'full', lossy: false } as never)).resolves.toMatchObject({ succeeded: 0 });
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({
      state: before.state,
      consecutiveFailures: before.consecutiveFailures,
      reason: before.reason,
    });
  });

  // F2: a swallowed sink failure makes broken reporting indistinguishable from delivery. The
  // earlier `info` line records the skip, not the sink's own failure.
  it('logs the swallowed sink failure as a serialized error rather than discarding it', async () => {
    const harness = build();
    await trip(harness);
    const sink = { ...NOOP_SINK, indexerError: vi.fn(() => { throw new Error('sink exploded'); }) } as SearchEventSink;

    const executor = createAggregateExecutor({ id: 3, title: 'Kings' }, harness.search, sink, inject<FastifyBaseLogger>(harness.log));
    await executor({ query: 'kings', author: undefined, tag: 'full', lossy: false } as never);

    const [fields, message] = expectConsumerThrewLog(harness);
    expect(message).toBe('Search event consumer threw — report dropped');
    expect(fields).toMatchObject({ bookId: 3, indexer: 'Torznab', indexerId: 1 });
    expectSerializedError(fields.error, 'sink exploded');
  });

  it('adds no field to the SSE wire contract', () => {
    expect(Object.keys(indexerErrorEventSchema.shape).sort()).toEqual(['elapsedMs', 'error', 'indexerId', 'name']);
  });
});

/**
 * F1: every streaming callback is delivered to a consumer we do not control — an SSE writer on a
 * disconnected socket, a sink built by a route. A throw from one used to land in the leg's
 * transport catch and circuit-break a perfectly healthy indexer.
 */
describe('#2376 AC6 — a throwing streaming consumer cannot commit a transport failure', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  const boom = () => { throw new Error('consumer socket closed'); };

  it('leaves the breaker pristine and still returns results when onComplete throws', async () => {
    const harness = build();
    harness.adapterSearch.mockResolvedValue(emptyResponse(['Kings']));

    const results = await harness.search.searchAllStreaming('kings', undefined, new Map(), {
      onComplete: boom, onError: vi.fn(),
    });

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    // The leg's results are recorded before the callback, so a broken consumer costs nothing.
    expect(results).toHaveLength(1);
    const [fields] = expectConsumerThrewLog(harness);
    expect(fields).toMatchObject({ indexer: 'Torznab', indexerId: 1 });
    expectSerializedError(fields.error, 'consumer socket closed');
  });

  it('leaves the breaker pristine when the policy-refusal onError throws', async () => {
    const harness = build();
    harness.getAdapter.mockImplementation(async () => ({
      type: 'myanonamouse', name: 'MAM',
      refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
      search: harness.adapterSearch, test: vi.fn(),
    }) as never);

    await harness.search.searchAllStreaming('kings', undefined, new Map(), {
      onComplete: vi.fn(), onError: boom,
    });

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    expectConsumerThrewLog(harness);
  });

  it('leaves the breaker untouched when the breaker-skip onError throws', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('kings');
    const before = harness.service.getFailureSnapshot(1);

    await harness.search.searchAllStreaming('kings', undefined, new Map(), {
      onComplete: vi.fn(), onError: boom,
    });

    // Only the suppression counter moves — the skip itself is still counted.
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({
      state: before.state,
      consecutiveFailures: before.consecutiveFailures,
      nextAttemptAt: before.nextAttemptAt,
      reason: before.reason,
    });
    expectConsumerThrewLog(harness);
  });

  it('still commits the transport failure when a real failure meets a throwing onError', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));

    await harness.search.searchAllStreaming('kings', undefined, new Map(), {
      onComplete: vi.fn(), onError: boom,
    });

    // The control: isolating callbacks must not also isolate genuine transport outcomes.
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1, reason: REFUSED });
  });

  it('does not let a throwing consumer suppress a sibling indexer in the same fan-out', async () => {
    const harness = build([ROW_A, ROW_B]);
    harness.adapterSearch.mockResolvedValue(emptyResponse(['Kings']));
    const onComplete = vi.fn().mockImplementationOnce(boom);

    const results = await harness.search.searchAllStreaming('kings', undefined, new Map(), {
      onComplete, onError: vi.fn(),
    });

    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(harness.service.getFailureSnapshot(1).state).toBe('ok');
    expect(harness.service.getFailureSnapshot(2).state).toBe('ok');
  });
});

describe('#2376 AC13/AC14 — cancellation and policy skips are not failures', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  it('records nothing when the outer deadline aborts a leg, on a clean indexer', async () => {
    const harness = build();
    const outer = new AbortController();
    harness.adapterSearch.mockImplementation(async () => {
      outer.abort();
      throw new Error('socket hang up');
    });

    await expect(harness.search.searchAllWithStatus('kings', { signal: outer.signal })).rejects.toThrow();

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('records nothing when the deadline aborts a leg on an already backing-off indexer', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('kings');
    const backingOff = harness.service.getFailureSnapshot(1);

    harness.clock.now = INDEXER_BACKOFF_BASE_MS;
    const outer = new AbortController();
    harness.adapterSearch.mockImplementation(async () => {
      outer.abort();
      throw new Error('socket hang up');
    });
    await expect(harness.search.searchAllWithStatus('kings', { signal: outer.signal })).rejects.toThrow();

    // The reservation stands — it is a floor on the next attempt, not a recorded failure.
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({
      consecutiveFailures: backingOff.consecutiveFailures,
      nextAttemptAt: INDEXER_BACKOFF_BASE_MS + 2 * MINUTE,
    });
  });

  it('records nothing when a single leg is cancelled through its own controller', async () => {
    const harness = build();
    const perIndexer = new AbortController();
    harness.adapterSearch.mockImplementation(async () => {
      perIndexer.abort();
      throw new Error('aborted');
    });
    const onCancelled = vi.fn();

    await harness.search.searchAllStreaming('kings', undefined, new Map([[1, perIndexer]]), {
      onComplete: vi.fn(), onError: vi.fn(), onCancelled,
    });

    expect(onCancelled).toHaveBeenCalledWith(1, 'Torznab');
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('control: a genuine failure under a live, un-aborted signal still records', async () => {
    const harness = build();
    const live = new AbortController();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));

    await harness.search.searchAllWithStatus('kings', { signal: live.signal });

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
  });

  it('leaves the breaker pristine when preSearchRefresh refuses on the operator’s own account class', async () => {
    const harness = build();
    harness.getAdapter.mockImplementation(async () => ({
      type: 'myanonamouse', name: 'MAM',
      refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
      search: harness.adapterSearch, test: vi.fn(),
    }) as never);

    const aggregate = await harness.search.searchAllWithStatus('kings');
    const onError = vi.fn();
    await harness.search.searchAllStreaming('kings', undefined, new Map(), { onComplete: vi.fn(), onError });

    expect(aggregate.failed).toBe(1);
    expect(onError).toHaveBeenCalledWith(1, 'Torznab', 'Searches disabled — Mouse class', expect.any(Number));
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('records nothing for a refreshStatus throw by itself; the search outcome is what commits', async () => {
    const harness = build();
    harness.getAdapter.mockImplementation(async () => ({
      type: 'myanonamouse', name: 'MAM',
      refreshStatus: vi.fn().mockRejectedValue(new Error('status endpoint down')),
      search: harness.adapterSearch, test: vi.fn(),
    }) as never);

    await harness.search.searchAllWithStatus('kings');

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
});

describe('#2376 AC5/AC17 — a repair invalidates in-flight legs, an observation write does not', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  it('drops a stale failure from a search that was in flight across an operator clear', async () => {
    const harness = build();
    let releaseSearch: (() => void) | undefined;
    harness.adapterSearch.mockImplementation(() => new Promise((_resolve, reject) => {
      releaseSearch = () => reject(new Error(REFUSED));
    }));

    const inFlight = harness.search.searchAllWithStatus('kings');
    await vi.waitFor(() => expect(releaseSearch).toBeDefined());
    await harness.service.update(1, { name: 'Repaired' });
    releaseSearch!();
    await inFlight;

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('commits the failure of a MAM leg whose preSearchRefresh persisted observed metadata mid-flight', async () => {
    const harness = build();
    harness.getAdapter.mockImplementation(async () => ({
      type: 'myanonamouse', name: 'MAM',
      // A class CHANGE, so preSearchRefresh writes mid-leg — through the non-clearing writer.
      refreshStatus: vi.fn().mockResolvedValue({ isVip: true, classname: 'VIP' }),
      search: vi.fn().mockRejectedValue(new Error(REFUSED)),
      test: vi.fn(),
    }) as never);
    const persistSpy = vi.spyOn(harness.service, 'persistObservedSettings');

    await harness.search.searchAllWithStatus('kings');

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
  });
});

describe('#2376 AC11 — reasons are operator language, not serialized throws', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  it('stores the mapped sentence for an ECONNREFUSED-caused fetch failure', async () => {
    const harness = build();
    // The shape mapNetworkError produces: an operator sentence carrying the transport code.
    harness.adapterSearch.mockRejectedValue(Object.assign(new Error(REFUSED), { code: 'ECONNREFUSED' }));

    await harness.search.searchAllWithStatus('kings');

    const { reason } = harness.service.getFailureSnapshot(1);
    expect(reason).toBe(REFUSED);
    expect(reason).not.toMatch(/\bat .*:\d+/);
    expect(reason).not.toContain('[object Object]');
    expect(reason).not.toContain('TypeError');
  });
});

describe('#2376 AC15 — the ladder reads suppressed as an outage, never an answered zero', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  it('stops at rung one when every indexer is suppressed', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('the way of kings');
    harness.clock.now += 1_000;

    const executor = createAggregateExecutor({ id: 1, title: 'The Way of Kings' }, harness.search, NOOP_SINK, inject<FastifyBaseLogger>(harness.log));
    const spy = vi.fn(executor);
    const ran = await runQueryLadder(buildQueryLadder({ title: 'The Way of Kings', author: 'Brandon Sanderson' }), spy);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(ran.exhausted).toBe(false);
    expect(ran.results).toEqual([]);
  });

  it('advances normally when one of two indexers is suppressed and the other answers zero', async () => {
    const harness = build([ROW_A, ROW_B]);
    harness.getAdapter.mockImplementation(async (indexer) => ({
      type: 'torznab', name: indexer.name,
      search: indexer.id === 1 ? vi.fn().mockRejectedValue(new Error(REFUSED)) : vi.fn().mockResolvedValue(emptyResponse()),
      test: vi.fn(),
    }) as never);
    await harness.search.searchAllWithStatus('the way of kings');
    harness.clock.now += 1_000;

    const outcome = await harness.search.searchAllWithStatus('the way of kings');
    expect(outcome).toMatchObject({ succeeded: 1, failed: 0 });
    expect(outcome.skipped).toHaveLength(1);

    const spy = vi.fn(createAggregateExecutor({ id: 1, title: 'The Way of Kings' }, harness.search, NOOP_SINK, inject<FastifyBaseLogger>(harness.log)));
    const ladder = buildQueryLadder({ title: 'The Way of Kings', author: 'Brandon Sanderson' });
    const ran = await runQueryLadder(ladder, spy);

    expect(spy.mock.calls.length).toBeGreaterThan(1);
    expect(ran.exhausted).toBe(true);
  });
});

describe('#2376 AC20 — the scheduled RSS poll is gated and accounted too', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  function rssDeps() {
    return {
      settings: createMockSettingsService({
        rss: { enabled: true, intervalMinutes: 30 },
        quality: {}, metadata: {}, search: { searchPriority: 'accuracy' },
      }),
      bookList: inject<BookListService>({ getAll: vi.fn().mockResolvedValue({ data: [{ id: 1, title: 'Kings', authors: [{ name: 'Sanderson' }] }] }) }),
      download: inject<DownloadOrchestrator>({ grab: vi.fn() }),
      blacklist: inject<BlacklistService>({ isBlacklisted: vi.fn().mockResolvedValue(false), getAll: vi.fn().mockResolvedValue({ data: [] }) }),
    };
  }

  it('makes no adapter call, reports a skip, and does not increment polled', async () => {
    const harness = build([ROW_B]);
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.pollRss(ROW_B).catch(() => undefined);
    harness.clock.now += 1_000;
    harness.adapterSearch.mockClear();
    harness.getAdapter.mockClear();

    const outcome = await harness.search.pollRss(ROW_B);

    expect(outcome.results).toEqual([]);
    expect(outcome.skipped).toEqual({ indexerId: 2, name: 'Newznab', state: 'backing-off', reason: REFUSED });
    expect(harness.getAdapter).not.toHaveBeenCalled();
    expect(harness.adapterSearch).not.toHaveBeenCalled();
  });

  it('reports { polled: n-1, skipped: 1 } and still polls the remaining indexers', async () => {
    const harness = build([ROW_B, createMockDbIndexer({ id: 3, name: 'Other', type: 'torznab', settings: {} })]);
    const searchByIndexer = new Map<number, ReturnType<typeof vi.fn>>([
      [2, vi.fn().mockRejectedValue(new Error(REFUSED))],
      [3, vi.fn().mockResolvedValue(emptyResponse())],
    ]);
    harness.getAdapter.mockImplementation(async (indexer) => ({
      type: indexer.type, name: indexer.name, search: searchByIndexer.get(indexer.id), test: vi.fn(),
    }) as never);
    const { settings, bookList, download, blacklist } = rssDeps();

    // First cycle: indexer 2 fails and trips; indexer 3 answers.
    await runRssJob(settings, bookList, harness.search, download, blacklist, harness.service, inject<FastifyBaseLogger>(harness.log));
    harness.clock.now += 1_000;

    const second = await runRssJob(settings, bookList, harness.search, download, blacklist, harness.service, inject<FastifyBaseLogger>(harness.log));

    expect(second).toMatchObject({ polled: 1, skipped: 1 });
    expect(searchByIndexer.get(3)!).toHaveBeenCalledTimes(2);
    expect(searchByIndexer.get(2)!).toHaveBeenCalledTimes(1);
  });

  it('feeds the breaker from the RSS path alone, with no search having run', async () => {
    const harness = build([ROW_B]);
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));

    await expect(harness.search.pollRss(ROW_B)).rejects.toThrow(REFUSED);

    expect(harness.service.getFailureSnapshot(2)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1, reason: REFUSED });
  });
});

describe('#2376 AC21 — a reopened gate admits exactly one attempt, process-wide', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  async function reopened() {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await harness.search.searchAllWithStatus('kings');
    harness.clock.now = INDEXER_BACKOFF_BASE_MS;
    harness.adapterSearch.mockClear();
    return harness;
  }

  it('admits one of two concurrent aggregate legs and reports the other as a skip', async () => {
    const harness = await reopened();

    const [first, second] = await Promise.all([
      harness.search.searchAllWithStatus('kings'),
      harness.search.searchAllWithStatus('kings'),
    ]);

    expect(harness.adapterSearch).toHaveBeenCalledTimes(1);
    expect(first.skipped.length + second.skipped.length).toBe(1);
  });

  it('admits one attempt across a streaming leg and an RSS poll racing the same window', async () => {
    const harness = await reopened();

    await Promise.all([
      harness.search.searchAllStreaming('kings', undefined, new Map(), { onComplete: vi.fn(), onError: vi.fn() }),
      harness.search.pollRss(ROW_A).catch(() => undefined),
    ]);

    expect(harness.adapterSearch).toHaveBeenCalledTimes(1);
  });

  it('leaves the schedule exactly where the failure alone would have put it', async () => {
    const harness = await reopened();

    await harness.search.searchAllWithStatus('kings');

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({
      consecutiveFailures: 2,
      nextAttemptAt: INDEXER_BACKOFF_BASE_MS + 2 * MINUTE,
    });
  });

  it('does not reserve a pristine indexer — two concurrent legs both proceed', async () => {
    const harness = build();

    await Promise.all([
      harness.search.searchAllWithStatus('kings'),
      harness.search.searchAllWithStatus('kings'),
    ]);

    expect(harness.adapterSearch).toHaveBeenCalledTimes(2);
  });
});

describe('#2376 AC22 — outcome precedence when nine concurrent legs settle out of order', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  /** Nine legs all admitted while pristine, then committed in an order we choose by hand. */
  function admitNine(service: IndexerService) {
    return Array.from({ length: 9 }, () => service.reserveSearchAttempt(1).generation);
  }

  it('resets to pristine when the success settles before the eighth failure', () => {
    const { service } = build();
    const generations = admitNine(service);

    for (const generation of generations.slice(0, 7)) service.recordSearchFailure(1, new Error(REFUSED), generation);
    service.recordSearchSuccess(1, generations[7]!);
    service.recordSearchFailure(1, new Error(REFUSED), generations[8]!);

    expect(service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
  });

  it('stays stopped when the success settles after the eighth failure', async () => {
    const harness = build();
    const generations = admitNine(harness.service);

    for (const generation of generations.slice(0, 8)) harness.service.recordSearchFailure(1, new Error(REFUSED), generation);
    harness.service.recordSearchSuccess(1, generations[8]!);

    expect(harness.service.getFailureSnapshot(1).state).toBe('stopped');
    harness.adapterSearch.mockClear();
    await harness.search.searchAllWithStatus('kings');
    expect(harness.adapterSearch).not.toHaveBeenCalled();
  });

  it('the asymmetry: a search success leaves a stopped indexer stopped, a health probe clears it', async () => {
    const harness = build();
    harness.adapterSearch.mockRejectedValue(new IndexerAuthError('Torznab', REFUSED));
    await harness.search.searchAllWithStatus('kings');
    expect(harness.service.getFailureSnapshot(1).state).toBe('stopped');

    harness.service.recordSearchSuccess(1, harness.service.getFailureGeneration(1));
    expect(harness.service.getFailureSnapshot(1).state).toBe('stopped');

    await harness.service.test(1);
    expect(harness.service.getFailureSnapshot(1).state).toBe('ok');
  });
});

describe('#2376 AC4/AC7/AC9 — production time-to-stopped under the real health cadence', () => {
  beforeEach(() => initializeKey(TEST_KEY));
  afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

  function healthHarness(rows = [ROW_A]) {
    const harness = build(rows);
    const notify = vi.fn().mockResolvedValue(undefined);
    const health = new HealthCheckService(
      harness.service,
      inject<DownloadClientService>({ getAll: vi.fn().mockResolvedValue([]), test: vi.fn() }),
      inject<SettingsService>(createMockSettingsService({ processing: {}, tagging: {}, metadata: {} })),
      inject<NotifierService>({ notify, getAll: vi.fn().mockResolvedValue([]) }),
      inject<Db>({ select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }) }),
      inject<FastifyBaseLogger>(harness.log),
      {
        fsAccess: vi.fn().mockResolvedValue(undefined),
        fsStatfs: vi.fn().mockResolvedValue({ bavail: 100_000_000, bsize: 4096 }),
        probeFfmpeg: vi.fn().mockResolvedValue('6.1.1'),
        probeMutagen: vi.fn().mockResolvedValue('1.47.0'),
        resolveProxyIp: vi.fn().mockResolvedValue('203.0.113.1'),
      },
    );
    return { ...harness, health, notify };
  }

  /** Run the five-minute health cron until the breaker stops; returns the simulated minute. */
  async function runUntilStopped(h: ReturnType<typeof healthHarness>, options?: { searchEveryCycle?: boolean }) {
    let alertedAtMinute: number | null = null;
    for (let minute = 0; minute <= 240; minute += 5) {
      h.clock.now = minute * MINUTE;
      await h.health.runAllChecks();
      if (options?.searchEveryCycle) await h.search.searchAllWithStatus('kings');
      if (alertedAtMinute === null && h.notify.mock.calls.length > 0) alertedAtMinute = minute;
      if (h.service.getFailureSnapshot(1).state === 'stopped') {
        return { stoppedAtMinute: minute, alertedAtMinute, probes: h.adapterTest.mock.calls.length };
      }
    }
    return { stoppedAtMinute: null, alertedAtMinute, probes: h.adapterTest.mock.calls.length };
  }

  it('stops at ~35 simulated minutes on eight probes, with no search traffic at all', async () => {
    const h = healthHarness();
    h.adapterTest.mockResolvedValue({ success: false, message: REFUSED });
    h.adapterSearch.mockRejectedValue(new Error(REFUSED));

    const { stoppedAtMinute, probes } = await runUntilStopped(h);

    expect(stoppedAtMinute).toBe(35);
    expect(probes).toBe(8);
    expect(h.adapterSearch).not.toHaveBeenCalled();
    // Well inside the ~2-hour search-only upper bound; a regression that stops feeding health
    // outcomes into the tracker (AC7) reds right here.
    expect(stoppedAtMinute!).toBeLessThan(120);
  });

  it('alerts the operator before it stops — on_health_issue first, stopped second', async () => {
    const h = healthHarness();
    h.adapterTest.mockResolvedValue({ success: false, message: REFUSED });

    const { stoppedAtMinute, alertedAtMinute } = await runUntilStopped(h);

    expect(alertedAtMinute).not.toBeNull();
    expect(alertedAtMinute!).toBeLessThan(stoppedAtMinute!);
    expect(h.notify).toHaveBeenCalledWith('on_health_issue', expect.objectContaining({
      health: expect.objectContaining({ checkName: 'indexer:Torznab', previousState: 'healthy', currentState: 'error' }),
    }));
  });

  it('does not wait for stopped: an unconfirmed blip never notifies', async () => {
    const h = healthHarness();
    h.adapterTest
      .mockResolvedValueOnce({ success: false, message: REFUSED })
      .mockResolvedValue({ success: true, message: 'Connected' });

    for (let minute = 0; minute <= 15; minute += 5) {
      h.clock.now = minute * MINUTE;
      await h.health.runAllChecks();
    }

    expect(h.notify).not.toHaveBeenCalled();
    expect(h.service.getFailureSnapshot(1).state).toBe('ok');
  });

  it('interleaved search failures make it stop no later, never later', async () => {
    const healthOnly = healthHarness();
    healthOnly.adapterTest.mockResolvedValue({ success: false, message: REFUSED });
    healthOnly.adapterSearch.mockRejectedValue(new Error(REFUSED));
    const baseline = await runUntilStopped(healthOnly);

    const interleaved = healthHarness();
    interleaved.adapterTest.mockResolvedValue({ success: false, message: REFUSED });
    interleaved.adapterSearch.mockRejectedValue(new Error(REFUSED));
    const withSearches = await runUntilStopped(interleaved, { searchEveryCycle: true });

    expect(withSearches.stoppedAtMinute!).toBeLessThanOrEqual(baseline.stoppedAtMinute!);
  });

  it('keeps probing a stopped indexer and reopens it on the FIRST successful probe', async () => {
    const h = healthHarness();
    h.adapterTest.mockResolvedValue({ success: false, message: REFUSED });
    h.adapterSearch.mockRejectedValue(new Error(REFUSED));
    await runUntilStopped(h);
    const probesAtStop = h.adapterTest.mock.calls.length;

    h.clock.now += 5 * MINUTE;
    h.adapterTest.mockResolvedValue({ success: true, message: 'Connected' });
    await h.health.runAllChecks();

    expect(h.adapterTest.mock.calls.length).toBe(probesAtStop + 1);
    expect(h.service.getFailureSnapshot(1).state).toBe('ok');

    h.adapterSearch.mockResolvedValue(emptyResponse(['Kings']));
    expect((await h.search.searchAllWithStatus('kings')).succeeded).toBe(1);
  });

  it('surfaces the breaker reason on the indexer health card once stopped', async () => {
    const h = healthHarness();
    h.adapterTest.mockResolvedValue({ success: false, message: REFUSED });
    await runUntilStopped(h);

    const results = await h.health.runAllChecks();
    const card = results.find((r) => r.checkName === 'indexer:Torznab');

    expect(card).toMatchObject({ state: 'error', target: { kind: 'indexer', id: 1 } });
    expect(card!.message).toContain('Searches stopped');
    expect(card!.message).toContain(REFUSED);
  });

  it('never consults or advances the breaker for an operator-disabled indexer', async () => {
    const h = healthHarness([createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', enabled: false, settings: {} })]);
    h.adapterTest.mockResolvedValue({ success: false, message: REFUSED });

    await h.health.runAllChecks();

    expect(h.adapterTest).not.toHaveBeenCalled();
    expect(h.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
});

/**
 * #2483 — the point of the issue, observed where it actually matters. Per
 * `degrading-adapter-invisible-to-mock-suite` (#2375) a mock adapter that rejects proves the
 * classifier and nothing about whether the REAL adapter rejects, so this drives
 * `AudioBookBayIndexer` through `IndexerSearchService` with MSW at the solver transport.
 *
 * Before the gate a solver-delivered 503 parsed as zero ABB posts, `recordSearchSuccess` ran, and
 * the breaker reset against a site that was telling us to back off.
 */
describe('#2483 — a solver-delivered non-2xx is a breaker failure, not an answered zero', () => {
  const server = useMswServer();
  const ABB_HOST = 'abb.test';
  const SOLVER_URL = 'http://flaresolverr.test:8191';
  const CHALLENGE = '<html><body>Checking your browser…</body></html>';
  const EMPTY_PAGE = '<html><body></body></html>';

  beforeEach(() => {
    initializeKey(TEST_KEY);
    _resetAbbThrottleForTesting();
    // ABB's 6.1s floor would make an eight-leg run a minute-long test; its own timing is pinned in
    // `abb-throttle.test.ts`. The gate is module-level, so one spy covers every adapter built here.
    vi.spyOn(abbThrottle, 'acquire').mockResolvedValue(undefined);
  });

  afterEach(() => { _resetKey(); _resetAbbThrottleForTesting(); vi.restoreAllMocks(); });

  /** Indexer 1 is the real ABB, reaching the target only through the solver. */
  function buildWithRealAbb() {
    const harness = build([createMockDbIndexer({ id: 1, name: 'AudioBookBay', type: 'abb', settings: { hostname: ABB_HOST } })]);
    harness.getAdapter.mockImplementation(async () => new AudioBookBayIndexer({
      hostname: ABB_HOST,
      pageLimit: 1,
      flareSolverrUrl: SOLVER_URL,
    }) as never);
    return harness;
  }

  /** The solver answers every round-trip with an `ok` envelope carrying `status` as delivered. */
  function serveDelivered(body: string, status: number): { requests: () => number } {
    let requests = 0;
    server.use(http.post(`${SOLVER_URL}/v1`, () => {
      requests++;
      return HttpResponse.json({ status: 'ok', solution: { response: body, status } });
    }));
    return { requests: () => requests };
  }

  it('records a transient failure whose reason names the delivered status (AC12, AC13)', async () => {
    const harness = buildWithRealAbb();
    serveDelivered(CHALLENGE, 503);

    const outcome = await harness.search.searchAllWithStatus('kings');

    expect(outcome).toMatchObject({ succeeded: 0, failed: 1 });
    const snapshot = harness.service.getFailureSnapshot(1);
    expect(snapshot).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
    expect(snapshot.reason).toContain('503');
  });

  /** Without this control the assertion above passes just as well against "ABB always fails". */
  it('control: a genuine answered zero still records a success and leaves the breaker pristine', async () => {
    const harness = buildWithRealAbb();
    serveDelivered(EMPTY_PAGE, 200);

    const outcome = await harness.search.searchAllWithStatus('kings');

    expect(outcome).toMatchObject({ succeeded: 1, failed: 0, results: [] });
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  /**
   * `classifyIndexerFailure` is terminal only for `IndexerAuthError`, deliberately: broadening auth
   * detection to bare status codes is its own change. A delivered 403 must take the backoff ladder.
   */
  it('takes the transient ladder even for a delivered 403, never the terminal stop (AC13)', async () => {
    const harness = buildWithRealAbb();
    serveDelivered(CHALLENGE, 403);

    await harness.search.searchAllWithStatus('kings');

    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
  });

  it('reaches the terminal stop on the eighth consecutive leg, after which the ninth costs zero I/O', async () => {
    const harness = buildWithRealAbb();
    const solver = serveDelivered(CHALLENGE, 503);

    for (let leg = 0; leg < 8; leg++) {
      harness.clock.now = leg * 2 * 60 * MINUTE;
      await harness.search.searchAllWithStatus('kings');
    }

    expect(harness.service.getFailureSnapshot(1).state).toBe('stopped');
    expect(solver.requests()).toBe(8);

    harness.clock.now += 30 * 24 * 60 * MINUTE;
    await harness.search.searchAllWithStatus('kings');
    expect(solver.requests()).toBe(8);
  });

  /**
   * The accounting-level guarantee that makes AC17's narrowing safe: `commitLegFailure` returns
   * early on `signal.aborted`, so a cancelled leg commits nothing WHATEVER the error looks like —
   * the verdict is the signal's, never the error's shape (`abort-verdict-not-error-shape`).
   */
  it('commits nothing for a leg cancelled while the solver round-trip is in flight', async () => {
    const harness = buildWithRealAbb();
    const controller = new AbortController();
    server.use(http.post(`${SOLVER_URL}/v1`, () => {
      controller.abort();
      return HttpResponse.json({ status: 'ok', solution: { response: CHALLENGE, status: 503 } });
    }));

    await harness.search.searchAllWithStatus('kings', { signal: controller.signal }).catch(() => undefined);

    expect(controller.signal.aborted).toBe(true);
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
});
