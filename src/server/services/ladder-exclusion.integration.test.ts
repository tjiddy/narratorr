/**
 * #2375 — an indexer that failed for a reason the query cannot change is dropped from the rest of
 * the ladder run, and one that failed because of THIS query is not.
 *
 * Every behavioural case runs against both shared executors from one table, because a fix applied
 * to one leaves the other unprotected. The #2376 breaker is held open unless a case is explicitly
 * about the interaction: its backoff and the rung period are the same order of magnitude, so a
 * live breaker would let these assertions pass for the other mechanism's reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { createAggregateExecutor, createStreamingExecutor, runBookQueryLadder } from './search-ladder-execution.js';
import { buildQueryLadder, runQueryLadder, MAX_SEARCH_RUNGS, type Rung, type RungExecution } from './search-query-ladder.js';
import { SearchLadderCooldown } from './search-ladder-cooldown.js';
import { NOOP_SINK, type SearchEventSink } from './search-event-sink.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { indexerErrorEventSchema } from '@shared/schemas/search-stream.js';
import { httpStatusError, IndexerError } from '@core/indexers/errors.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

/** Colon segments are what `titleVariants` cuts on; this one fills the eight-rung budget exactly. */
const TITLE = 'Kings: Stormlight Archive: Special Edition';
const AUTHOR = 'Sanderson';
const BOOK = { id: 1, title: TITLE, authors: [{ name: AUTHOR }] };
const LADDER = buildQueryLadder({ title: TITLE, author: AUTHOR });

function refused(): Error {
  return Object.assign(new Error('Connection refused on port 443'), { code: 'ECONNREFUSED' });
}

function timedOut(): Error {
  return Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
}

function response(titles: string[] = []) {
  return {
    results: titles.map((title) => ({ title, indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: `magnet:?xt=urn:btih:${title}` })),
    parseStats: { itemsObserved: titles.length, kept: titles.length, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

/** An indexer that answers every rung with a genuine, empty result set. */
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
  const getAdapter = vi.spyOn(service, 'getAdapter').mockImplementation(async (indexer) => {
    const leg = byId.get(indexer.id)!;
    return {
      type: 'torznab',
      name: indexer.name,
      search: leg.search,
      test: vi.fn(),
      ...(leg.refreshStatus !== undefined && { refreshStatus: leg.refreshStatus }),
    } as never;
  });

  // Hold #2376's gate open so what these assertions measure can only be #2375. Cases that are
  // about the interaction opt into the real breaker.
  if (options?.breaker !== 'live') {
    vi.spyOn(service, 'reserveSearchAttempt').mockImplementation((id) => ({
      allowed: true,
      generation: service.getFailureGeneration(id),
      snapshot: service.getFailureSnapshot(id),
    }));
  }

  return { clock, log, service, search, getAdapter };
}

type Harness = ReturnType<typeof build>;
type Surface = 'aggregate' | 'streaming';
const SURFACES: Surface[] = ['aggregate', 'streaming'];

async function executorFor(
  surface: Surface,
  harness: Harness,
  sink: SearchEventSink = NOOP_SINK,
  signal?: AbortSignal,
): Promise<(rung: Rung) => Promise<RungExecution>> {
  if (surface === 'aggregate') {
    return createAggregateExecutor(BOOK, harness.search, sink, inject<FastifyBaseLogger>(harness.log), signal);
  }
  return createStreamingExecutor(BOOK, harness.search, sink, signal);
}

/** A sink that records only what an operator would see for a failing indexer. */
function recordingSink(): { sink: SearchEventSink; errors: Mock } {
  const errors = vi.fn();
  return { sink: { ...NOOP_SINK, indexerError: errors } as SearchEventSink, errors };
}

beforeEach(() => initializeKey(TEST_KEY));
afterEach(() => { _resetKey(); vi.restoreAllMocks(); });

describe('#2375 — the ladder is exactly eight rungs for this fixture', () => {
  it('fills the budget, so an exact per-rung call count is meaningful', () => {
    expect(LADDER).toHaveLength(MAX_SEARCH_RUNGS);
    expect(MAX_SEARCH_RUNGS).toBe(8);
  });
});

describe.each(SURFACES)('#2375 AC1 — the regression, on the %s executor', (surface) => {
  it('asks a transport-failed indexer exactly once while the healthy three are asked eight times', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const alive = [healthy(), healthy(), healthy()];
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: alive[0]! },
      { id: 3, name: 'Newznab', search: alive[1]! },
      { id: 4, name: 'Other', search: alive[2]! },
    ]);

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(dead).toHaveBeenCalledTimes(1);
    for (const indexer of alive) expect(indexer).toHaveBeenCalledTimes(8);
    expect(ran.exhausted).toBe(true);
  });

  it('excludes from the rung the failure happened on, not only from the last one', async () => {
    const flaky = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response())
      .mockRejectedValue(timedOut());
    const alive = healthy();
    const harness = build([
      { id: 1, name: 'ABB', search: flaky },
      { id: 2, name: 'Torznab', search: alive },
    ]);

    await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(flaky).toHaveBeenCalledTimes(3);
    expect(alive).toHaveBeenCalledTimes(8);
  });

  it('does not carry the exclusion into a second run built the way production builds one', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: healthy() },
    ]);

    await runQueryLadder(LADDER, await executorFor(surface, harness));
    const afterFirstRun = dead.mock.calls.length;
    await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(afterFirstRun).toBe(1);
    expect(dead).toHaveBeenCalledTimes(2);
  });
});

describe.each(SURFACES)('#2375 AC2 — a query-scoped failure stays eligible, on the %s executor', (surface) => {
  const QUERY_SCOPED: Array<{ name: string; error: unknown }> = [
    { name: 'a structural HTTP 400', error: httpStatusError(400, 'Bad Request') },
    { name: 'a response-validation IndexerError', error: new IndexerError('Torznab', 'invalid JSON') },
    { name: 'an oversized response', error: Object.assign(new Error('Response exceeded size limit'), { code: 'UND_ERR_RESPONSE_EXCEEDED_SIZE' }) },
  ];

  it.each(QUERY_SCOPED)('re-asks after $name and returns the results of the retry', async ({ error }) => {
    const picky = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(response(['Stormlight Archive']));
    const harness = build([
      { id: 1, name: 'ABB', search: picky },
      { id: 2, name: 'Torznab', search: healthy() },
    ]);

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(picky).toHaveBeenCalledTimes(2);
    expect(ran.index).toBe(1);
    expect(ran.results.map((r) => r.title)).toEqual(['Stormlight Archive']);
  });

  /**
   * The healthy companion is load-bearing, not scenery: without it the unchanged outage rule stops
   * the run at rung one, and reading AC2 as "the ladder must always advance" would be wrong.
   */
  it('stops at rung one as an outage when the query-scoped indexer is the only one', async () => {
    const picky = vi.fn().mockRejectedValueOnce(httpStatusError(400, 'Bad Request')).mockResolvedValue(response(['Stormlight Archive']));
    const harness = build([{ id: 1, name: 'ABB', search: picky }]);

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(picky).toHaveBeenCalledTimes(1);
    expect(ran).toMatchObject({ index: 0, exhausted: false, results: [] });
  });
});

describe.each(SURFACES)('#2375 AC7/AC13/AC17 — accounting, on the %s executor', (surface) => {
  it('ends a run in which every indexer transport-failed as an outage, with no later rung issued', async () => {
    const first = vi.fn().mockRejectedValue(refused());
    const second = vi.fn().mockRejectedValue(timedOut());
    const harness = build([
      { id: 1, name: 'ABB', search: first },
      { id: 2, name: 'Torznab', search: second },
    ]);

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(ran).toMatchObject({ index: 0, exhausted: false, results: [] });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  /**
   * Observed on the SAME closure. A second run starts with an empty set whether or not run one
   * wrongly excluded the indexer, so a fresh-run observation is green against the very defect it
   * claims to catch.
   */
  it('leaves an all-query-scoped rung eligible even though the run ends there as an outage', async () => {
    const picky = vi.fn().mockRejectedValue(httpStatusError(422, 'Unprocessable Entity'));
    const harness = build([{ id: 1, name: 'ABB', search: picky }]);
    const execute = await executorFor(surface, harness);

    const ran = await runQueryLadder(LADDER, execute);
    const nextRung = await execute(LADDER[1]!);

    expect(ran).toMatchObject({ index: 0, exhausted: false });
    expect(picky).toHaveBeenCalledTimes(2);
    expect(nextRung.succeeded).toBe(0);
  });

  it('counts only the resolving indexer on a mixed rung and drops only the transport failure', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const picky = vi.fn().mockRejectedValue(httpStatusError(400, 'Bad Request'));
    const alive = healthy();
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: picky },
      { id: 3, name: 'Newznab', search: alive },
    ]);
    const execute = vi.fn(await executorFor(surface, harness));

    await runQueryLadder(LADDER, execute);

    await expect(execute.mock.results[0]!.value).resolves.toMatchObject({ succeeded: 1 });
    await expect(execute.mock.results[1]!.value).resolves.toMatchObject({ succeeded: 1 });
    expect(dead).toHaveBeenCalledTimes(1);
    expect(picky).toHaveBeenCalledTimes(8);
    expect(alive).toHaveBeenCalledTimes(8);
  });

  it('stops climbing the moment the last indexer is excluded, and never reports exhausted', async () => {
    const searches = [0, 1, 2, 3].map((failOnRung) => {
      const mock = vi.fn();
      for (let rung = 0; rung < failOnRung; rung++) mock.mockResolvedValueOnce(response());
      return mock.mockRejectedValue(refused());
    });
    const harness = build(searches.map((search, index) => ({ id: index + 1, name: `Indexer${index + 1}`, search })));

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness));

    expect(searches.map((s) => s.mock.calls.length)).toEqual([1, 2, 3, 4]);
    expect(ran).toMatchObject({ index: 3, exhausted: false, results: [] });
  });

  /** AC13 — an excluded indexer costs zero I/O, not a request that is started and discarded. */
  it('issues no adapter call at all once exclusion has emptied the eligible set', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const harness = build([{ id: 1, name: 'ABB', search: dead }]);
    const execute = await executorFor(surface, harness);

    await execute(LADDER[0]!);
    harness.getAdapter.mockClear();
    const emptied = await execute(LADDER[1]!);

    expect(emptied).toMatchObject({ succeeded: 0, results: [] });
    expect(harness.getAdapter).not.toHaveBeenCalled();
    expect(dead).toHaveBeenCalledTimes(1);
  });

  /** AC8 — the pure module keeps its shape; nothing about exclusion travels through it. */
  it('returns a RungExecution with no field added', async () => {
    const harness = build([{ id: 1, name: 'ABB', search: healthy() }]);

    const execution = await (await executorFor(surface, harness))(LADDER[0]!);

    expect(Object.keys(execution).sort()).toEqual(['results', 'succeeded']);
  });
});

describe.each(SURFACES)('#2375 AC10 — reported once, on the %s executor', (surface) => {
  it('reports a transport-failed indexer exactly once across the whole run', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: healthy() },
    ]);
    const { sink, errors } = recordingSink();

    await runQueryLadder(LADDER, await executorFor(surface, harness, sink));

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(1, 'ABB', 'Connection refused on port 443', expect.any(Number));
  });

  /**
   * A #2376 skip is re-gated and re-reported on every rung today, and it is the same operator-facing
   * noise. The breaker is live here because the case is about it.
   */
  it('reports a breaker-suppressed indexer one time across eight rungs, on a valid wire frame', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: healthy() },
    ], { breaker: 'live' });
    await harness.search.searchAllWithStatus('kings');
    harness.clock.now += 1_000;
    const { sink, errors } = recordingSink();

    await runQueryLadder(LADDER, await executorFor(surface, harness, sink));

    expect(errors).toHaveBeenCalledTimes(1);
    const [indexerId, name, error, elapsedMs] = errors.mock.calls[0] as [number, string, string, number];
    expect(indexerErrorEventSchema.safeParse({ indexerId, name, error, elapsedMs }).success).toBe(true);
    expect(error).toBe('Skipped — backing-off: Connection refused on port 443');
  });

  it('completes the run and keeps the indexer excluded when the sink consumer throws', async () => {
    const dead = vi.fn().mockRejectedValue(refused());
    const alive = healthy();
    const harness = build([
      { id: 1, name: 'ABB', search: dead },
      { id: 2, name: 'Torznab', search: alive },
    ]);
    const sink = { ...NOOP_SINK, indexerError: vi.fn(() => { throw new Error('sink exploded'); }) } as SearchEventSink;

    const ran = await runQueryLadder(LADDER, await executorFor(surface, harness, sink));

    expect(ran.exhausted).toBe(true);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(alive).toHaveBeenCalledTimes(8);
  });
});

describe.each(SURFACES)('#2375 AC7 — the ladder cooldown, on the %s executor', (surface) => {
  async function runScheduled(harness: Harness, cooldown: SearchLadderCooldown) {
    return runBookQueryLadder(BOOK, {
      indexerSearchService: harness.search,
      streaming: surface === 'streaming',
      sink: NOOP_SINK,
      searchLadderCooldown: cooldown,
      ladderMode: 'scheduled',
      log: inject<FastifyBaseLogger>(harness.log),
    });
  }

  it('records no cooldown for a run that ended with nothing left to ask', async () => {
    const searches = [0, 1].map((failOnRung) => {
      const mock = vi.fn();
      for (let rung = 0; rung < failOnRung; rung++) mock.mockResolvedValueOnce(response());
      return mock.mockRejectedValue(refused());
    });
    const harness = build(searches.map((search, index) => ({ id: index + 1, name: `Indexer${index + 1}`, search })));
    const cooldown = new SearchLadderCooldown();
    const record = vi.spyOn(cooldown, 'recordExhausted');

    const ran = await runScheduled(harness, cooldown);

    expect(ran.exhausted).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('still records a genuine answered zero on every rung', async () => {
    const harness = build([{ id: 1, name: 'Torznab', search: healthy() }]);
    const cooldown = new SearchLadderCooldown();
    const record = vi.spyOn(cooldown, 'recordExhausted');

    const ran = await runScheduled(harness, cooldown);

    expect(ran.exhausted).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
