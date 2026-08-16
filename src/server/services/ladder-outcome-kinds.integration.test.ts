/**
 * #2375 AC12/AC17/AC18 — the structural outcome kind, and the three carve-outs that hang off it.
 *
 * Cancellation, breaker suppression and policy refusal all reach the streaming executor through
 * the SAME `onError(indexerId, name, error: string, elapsedMs)` callback, so a message-matching
 * implementation would be indistinguishable from a structural one at that boundary. These cases
 * observe the exclusion set the executors actually pass to the service, which is where the
 * difference shows.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { createAggregateExecutor, createStreamingExecutor } from './search-ladder-execution.js';
import { buildQueryLadder, runQueryLadder, type Rung, type RungExecution } from './search-query-ladder.js';
import { createRunExclusionPolicy, type IndexerRunOptions, type RunExclusionPolicy } from './search-run-exclusion.js';
import { NOOP_SINK, type SearchEventSink } from './search-event-sink.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { INDEXER_BACKOFF_BASE_MS } from './indexer-failure-state.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';

// A passthrough spy: production keeps running, and the one case that needs a different policy
// wording can supply it without the test asserting on today's sentence.
vi.mock('./indexer-pre-search-refresh.js', async (importActual) => {
  const actual = await importActual<typeof import('./indexer-pre-search-refresh.js')>();
  return { preSearchRefresh: vi.fn(actual.preSearchRefresh) };
});
const actualRefresh = await vi.importActual<typeof import('./indexer-pre-search-refresh.js')>('./indexer-pre-search-refresh.js');

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const TITLE = 'Kings: Stormlight Archive: Special Edition';
const AUTHOR = 'Sanderson';
const BOOK = { id: 1, title: TITLE, authors: [{ name: AUTHOR }] };
const LADDER = buildQueryLadder({ title: TITLE, author: AUTHOR });
const MOUSE_REFUSAL = 'Searches disabled — Mouse class';

function refused(): Error {
  return Object.assign(new Error('Connection refused on port 443'), { code: 'ECONNREFUSED' });
}

function response(titles: string[] = []) {
  return {
    results: titles.map((title) => ({ title, indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: `magnet:?xt=urn:btih:${title}` })),
    parseStats: { itemsObserved: titles.length, kept: titles.length, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

function healthy(): Mock {
  return vi.fn().mockResolvedValue(response());
}

interface Leg {
  id: number;
  name: string;
  search: Mock;
  refreshStatus?: Mock;
}

function build(legs: Leg[], options?: { breaker?: 'live' }) {
  const clock = { now: 0 };
  const rows = legs.map((leg, index) => createMockDbIndexer({ id: leg.id, name: leg.name, type: 'torznab', priority: index, settings: {} }));
  const db = createMockDb();
  db.select.mockReturnValue(mockDbChain(rows));
  db.update.mockReturnValue(mockDbChain(rows));
  const log = createMockLogger();
  const service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log), undefined, () => clock.now);
  const search = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), service);

  const byId = new Map(legs.map((leg) => [leg.id, leg]));
  vi.spyOn(service, 'getAdapter').mockImplementation(async (indexer) => {
    const leg = byId.get(indexer.id)!;
    return {
      type: 'torznab',
      name: indexer.name,
      search: leg.search,
      test: vi.fn(),
      ...(leg.refreshStatus !== undefined && { refreshStatus: leg.refreshStatus }),
    } as never;
  });

  if (options?.breaker !== 'live') {
    vi.spyOn(service, 'reserveSearchAttempt').mockImplementation((id) => ({
      allowed: true,
      generation: service.getFailureGeneration(id),
      snapshot: service.getFailureSnapshot(id),
    }));
  }

  return { clock, log, service, search };
}

type Harness = ReturnType<typeof build>;
type Surface = 'aggregate' | 'streaming';
const SURFACES: Surface[] = ['aggregate', 'streaming'];

async function executorFor(surface: Surface, harness: Harness, sink: SearchEventSink = NOOP_SINK): Promise<(rung: Rung) => Promise<RungExecution>> {
  if (surface === 'aggregate') {
    return createAggregateExecutor(BOOK, harness.search, sink, inject<FastifyBaseLogger>(harness.log));
  }
  return createStreamingExecutor(BOOK, harness.search, sink);
}

/**
 * A real policy with a spy spliced into its outcome channel, so a case can assert the structural
 * kind a leg delivered rather than only the exclusion set it did or did not move.
 */
function observingPolicy(): { policy: RunExclusionPolicy; outcomes: Mock } {
  const policy = createRunExclusionPolicy();
  const outcomes = vi.fn();
  const runOptions: IndexerRunOptions = {
    ...policy.runOptions,
    onOutcome: (indexerId, name, outcome) => {
      outcomes(indexerId, name, outcome);
      policy.observe(indexerId, name, outcome);
    },
  };
  return { policy: { ...policy, runOptions }, outcomes };
}

/** A MAM-shaped adapter whose account class refuses searching. */
function mouse(): Leg {
  return { id: 1, name: 'MAM', search: vi.fn(), refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }) };
}

beforeEach(() => {
  initializeKey(TEST_KEY);
  // `restoreAllMocks` clears neither the implementation nor the history of a module-factory mock,
  // and every case in this file calls through it — an uncleared count is the whole suite's, not
  // this case's.
  vi.mocked(preSearchRefresh).mockReset().mockImplementation(actualRefresh.preSearchRefresh);
});
afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

describe('#2375 AC12 — a cancelled leg is never excluded', () => {
  /**
   * An empty exclusion set is where the set STARTS, so on its own it cannot tell "reported
   * cancelled" from "reported nothing at all". Both paths therefore assert the structural
   * outcome the leg actually delivered — that is the AC18 contract, and the AC9 parity claim.
   */
  it('emits a cancelled outcome and excludes nothing when the outer deadline aborts an aggregate leg', async () => {
    const outer = new AbortController();
    const harness = build([{ id: 1, name: 'ABB', search: vi.fn().mockImplementation(async () => { outer.abort(); throw new Error('socket hang up'); }) }]);
    const { policy, outcomes } = observingPolicy();

    await expect(harness.search.searchAllWithStatus('kings', { signal: outer.signal }, policy.runOptions)).rejects.toThrow();

    expect(outcomes).toHaveBeenCalledExactlyOnceWith(1, 'ABB', { kind: 'cancelled' });
    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([]);
  });

  it('emits a cancelled outcome and excludes nothing when the outer deadline aborts a streaming leg', async () => {
    const outer = new AbortController();
    const harness = build([{ id: 1, name: 'ABB', search: vi.fn().mockImplementation(async () => { outer.abort(); throw new Error('socket hang up'); }) }]);
    const { policy, outcomes } = observingPolicy();

    await expect(harness.search.searchAllStreaming(
      'kings', undefined, new Map(), { onComplete: vi.fn(), onError: vi.fn() }, outer.signal, policy.runOptions,
    )).rejects.toThrow();

    expect(outcomes).toHaveBeenCalledExactlyOnceWith(1, 'ABB', { kind: 'cancelled' });
    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([]);
  });

  it('excludes nothing when a single leg is cancelled through its own controller', async () => {
    const perIndexer = new AbortController();
    const harness = build([{ id: 1, name: 'ABB', search: vi.fn().mockImplementation(async () => { perIndexer.abort(); throw new Error('aborted'); }) }]);
    const policy = createRunExclusionPolicy();
    const onCancelled = vi.fn();

    await harness.search.searchAllStreaming(
      'kings', undefined, new Map([[1, perIndexer]]), { onComplete: vi.fn(), onError: vi.fn(), onCancelled }, undefined, policy.runOptions,
    );

    expect(onCancelled).toHaveBeenCalledWith(1, 'ABB');
    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([]);
  });

  it('excludes nothing on a later rung whose controller was already aborted', async () => {
    const perIndexer = new AbortController();
    perIndexer.abort();
    const search = healthy();
    const harness = build([{ id: 1, name: 'ABB', search }]);
    const policy = createRunExclusionPolicy();

    await harness.search.searchAllStreaming(
      'kings', undefined, new Map([[1, perIndexer]]), { onComplete: vi.fn(), onError: vi.fn() }, undefined, policy.runOptions,
    );

    expect(search).not.toHaveBeenCalled();
    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([]);
  });

  // Without this control, a rule that never excludes anything passes both cancellation cases.
  it.each(SURFACES)('control: a genuine transport failure under a live signal still excludes, on %s', async (surface) => {
    const live = new AbortController();
    const harness = build([{ id: 1, name: 'ABB', search: vi.fn().mockRejectedValue(refused()) }]);
    const policy = createRunExclusionPolicy();

    if (surface === 'aggregate') {
      await harness.search.searchAllWithStatus('kings', { signal: live.signal }, policy.runOptions);
    } else {
      await harness.search.searchAllStreaming(
        'kings', undefined, new Map(), { onComplete: vi.fn(), onError: vi.fn() }, live.signal, policy.runOptions,
      );
    }

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([1]);
  });
});

describe.each(SURFACES)('#2375 AC17/AC18 — a policy refusal is asked once, on the %s executor', (surface) => {
  it('refreshes status exactly once, never searches, and lets the healthy indexer reach every rung', async () => {
    const refused = mouse();
    const alive = healthy();
    const harness = build([refused, { id: 2, name: 'Torznab', search: alive }]);
    const execute = vi.fn(await executorFor(surface, harness));

    const ran = await runQueryLadder(LADDER, execute);

    expect(refused.refreshStatus).toHaveBeenCalledTimes(1);
    expect(refused.search).not.toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(8);
    expect(ran.exhausted).toBe(true);
    for (const call of execute.mock.results) {
      await expect(call.value).resolves.toMatchObject({ succeeded: 1 });
    }
  });

  it('reports the refusal to the operator exactly once, not once per rung', async () => {
    const refusal = mouse();
    const errors = vi.fn();
    const harness = build([refusal, { id: 2, name: 'Torznab', search: healthy() }]);

    await runQueryLadder(LADDER, await executorFor(surface, harness, { ...NOOP_SINK, indexerError: errors } as SearchEventSink));

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(1, 'MAM', MOUSE_REFUSAL, expect.any(Number));
  });

  /**
   * The verdict must survive a future rewording of the policy sentence. A message-matching
   * implementation reds here and nowhere else.
   */
  it('keeps the verdict when the refusal wording changes', async () => {
    vi.mocked(preSearchRefresh).mockImplementation(async (adapter, indexer, deps) => (
      indexer.id === 1
        ? { skip: true, error: 'Account tier does not permit searching' }
        : actualRefresh.preSearchRefresh(adapter, indexer, deps)
    ));
    const refusal = mouse();
    const alive = healthy();
    const harness = build([refusal, { id: 2, name: 'Torznab', search: alive }]);

    await runQueryLadder(LADDER, await executorFor(surface, harness));

    // The refused indexer is asked ONCE. An implementation that recognised the refusal by its
    // sentence would read the new wording as an ordinary outcome and ask it on all eight rungs.
    const refusedCalls = vi.mocked(preSearchRefresh).mock.calls.filter(([, indexer]) => indexer.id === 1);
    expect(refusedCalls).toHaveLength(1);
    expect(refusal.search).not.toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(8);
  });

  it('records no breaker failure for the refusal, exactly as before', async () => {
    const refusal = mouse();
    const harness = build([refusal, { id: 2, name: 'Torznab', search: healthy() }], { breaker: 'live' });
    const recordFailure = vi.spyOn(harness.service, 'recordSearchFailure');

    await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(recordFailure).not.toHaveBeenCalled();
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
});

describe('#2375 AC18 — the three streaming onError kinds get three different verdicts', () => {
  it('excludes the policy refusal and the transport failure but not the breaker skip', async () => {
    const suppressed = vi.fn().mockRejectedValue(refused());
    const refusal = { id: 2, name: 'MAM', search: vi.fn(), refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }) };
    // Answers the priming search, then breaks — so only indexer 1 is behind an open breaker.
    const dead = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(refused());
    const harness = build([
      { id: 1, name: 'ABB', search: suppressed },
      refusal,
      { id: 3, name: 'Torznab', search: dead },
      { id: 4, name: 'Newznab', search: healthy() },
    ], { breaker: 'live' });
    // Trip indexer 1's breaker only, so the very next search sees a suppressed leg.
    await harness.search.searchAllWithStatus('kings');
    const policy = createRunExclusionPolicy();
    const onError = vi.fn();

    await harness.search.searchAllStreaming(
      'kings', undefined, new Map(), { onComplete: vi.fn(), onError }, undefined, policy.runOptions,
    );

    // All three arrived through the one string channel; only the structural kind separates them.
    expect(onError.mock.calls.map(([id]) => id).sort()).toEqual([1, 2, 3]);
    expect([...policy.runOptions.excludeIndexerIds!].sort()).toEqual([2, 3]);
  });

  /**
   * Carve-out (c) is load-bearing: #2376 re-gates each rung on its own clock, and excluding a
   * suppressed indexer here would swallow the half-open probe it is entitled to.
   */
  it('attempts a suppressed indexer again once its backoff elapses mid-run', async () => {
    const recovering = vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue(response());
    const alive = healthy();
    const harness = build([
      { id: 1, name: 'ABB', search: recovering },
      { id: 2, name: 'Torznab', search: alive },
    ], { breaker: 'live' });
    await harness.search.searchAllWithStatus('kings');
    recovering.mockClear();
    alive.mockClear();

    const execute = await createStreamingExecutor(BOOK, harness.search, NOOP_SINK);
    await runQueryLadder(LADDER, async (rung, index) => {
      // Rung one lands inside the backoff window; every later rung is past it.
      if (index > 0) harness.clock.now += INDEXER_BACKOFF_BASE_MS + 1_000;
      return execute(rung);
    });

    expect(recovering).toHaveBeenCalled();
    expect(alive).toHaveBeenCalledTimes(8);
  });

  /**
   * A genuine failure worded exactly like the policy refusal: both are excluded, but only the
   * genuine one feeds the breaker. Text cannot tell them apart; the kind can.
   */
  it('separates a genuine failure from a refusal that words identically', async () => {
    const impostor = vi.fn().mockRejectedValue(new Error(MOUSE_REFUSAL));
    const harness = build([{ id: 1, name: 'Torznab', search: impostor }], { breaker: 'live' });
    const policy = createRunExclusionPolicy();

    await harness.search.searchAllWithStatus('kings', undefined, policy.runOptions);

    expect([...policy.runOptions.excludeIndexerIds!]).toEqual([1]);
    expect(harness.service.getFailureSnapshot(1)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1, reason: MOUSE_REFUSAL });
  });
});
