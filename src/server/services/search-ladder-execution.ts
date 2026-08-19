/**
 * I/O half of the query ladder: the pure ladder chooses queries while this module executes them
 * and settles cooldown state.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { SearchBook, SearchEventSink } from './search-event-sink.js';
import { deliverSearchReport } from './search-event-sink.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { SearchLadderCooldown } from './search-ladder-cooldown.js';
import { createRunExclusionPolicy, reportableLeg, type IndexerRunOptions } from './search-run-exclusion.js';
import {
  buildQueryLadder,
  runQueryLadder,
  rungDedupKey,
  type Rung,
  type RungExecution,
  type LadderRun,
} from './search-query-ladder.js';

/**
 * Emit `search_started` once and retain abort controllers across rungs. `succeeded` counts
 * responding indexers so the ladder can distinguish a real zero from an outage.
 *
 * The run exclusion policy lives here for the same reason the controllers do: it is scoped to
 * one ladder run and must die with it (#2375). A new executor starts with an empty set.
 */
export async function createStreamingExecutor(
  book: SearchBook,
  indexerSearchService: IndexerSearchService,
  sink: SearchEventSink,
  signal?: AbortSignal,
): Promise<(rung: Rung) => Promise<RungExecution>> {
  const enabledIndexers = await indexerSearchService.getEnabledIndexers();
  sink.searchStarted(enabledIndexers);

  const controllers = new Map<number, AbortController>();
  for (const indexer of enabledIndexers) {
    controllers.set(indexer.id, new AbortController());
  }

  const policy = createRunExclusionPolicy();

  return async (rung: Rung) => {
    let succeeded = 0;
    const results = await indexerSearchService.searchAllStreaming(
      rung.query,
      {
        title: book.title,
        author: rung.author,
        rankingAuthor: book.authors?.[0]?.name,
        queryWithApostrophes: rung.queryWithApostrophes,
      },
      controllers,
      {
        onComplete: (indexerId, name, resultCount, elapsedMs) => {
          succeeded++;
          sink.indexerComplete(indexerId, name, resultCount, elapsedMs);
        },
        onError: (indexerId, name, error, elapsedMs) => {
          if (!policy.claimReport(indexerId)) return;
          sink.indexerError(indexerId, name, error, elapsedMs);
        },
      },
      signal,
      policy.runOptions,
    );
    return { results, succeeded };
  };
}

/**
 * Shared silent executor preserves the transport/ranking author split across aggregate callers.
 * The sink gives this path the same breaker-skip observable the streaming path has; the two
 * callers that own no sink (`retry-search.ts`, `routes/v1/actions.ts`) pass `NOOP_SINK` and stay
 * explicable through the unconditional skip log inside the search service.
 */
export function createAggregateExecutor(
  book: SearchBook,
  indexerSearchService: IndexerSearchService,
  sink: SearchEventSink,
  log: FastifyBaseLogger,
  signal?: AbortSignal,
): (rung: Rung) => Promise<RungExecution> {
  const policy = createRunExclusionPolicy();

  // The aggregate status returns counts plus breaker skips, so the outcome channel is the only
  // place this executor can learn that a leg failed or was refused, and the only wording of it
  // that matches the streaming path. Reporting rides the same callback as the accounting so the
  // two cannot drift apart per rung.
  const runOptions: IndexerRunOptions = {
    ...policy.runOptions,
    onOutcome: (indexerId, name, outcome) => {
      policy.observe(indexerId, name, outcome);
      if (!reportableLeg(outcome)) return;
      // Re-gated and re-refused every rung; the operator wants "ABB failed" once, not eight times.
      if (!policy.claimReport(indexerId)) return;
      deliverSearchReport(log, { bookId: book.id, indexer: name, indexerId }, () =>
        sink.indexerError(indexerId, name, outcome.report.reason, outcome.report.elapsedMs));
    },
  };

  return async (rung: Rung) => {
    const { results, succeeded } = await indexerSearchService.searchAllWithStatus(
      rung.query,
      {
        title: book.title,
        author: rung.author,
        rankingAuthor: book.authors?.[0]?.name,
        queryWithApostrophes: rung.queryWithApostrophes,
        // Omitted rather than assigned undefined so callers without a deadline keep today's options.
        ...(signal !== undefined && { signal }),
      },
      runOptions,
    );
    return { results, succeeded };
  };
}

export interface BookLadderRunDeps {
  indexerSearchService: IndexerSearchService;
  /** True selects the streaming executor. */
  streaming: boolean;
  sink: SearchEventSink;
  searchLadderCooldown?: SearchLadderCooldown | undefined;
  /** `'scheduled'` consults and records the cooldown; `'always'` does neither. */
  ladderMode: 'scheduled' | 'always';
  log: FastifyBaseLogger;
  /** The outer search deadline; composed into every indexer leg, never substituted for one. */
  signal?: AbortSignal | undefined;
}

/** Rung one remains the canonical query, preserving the one-query success path. */
export async function runBookQueryLadder(book: SearchBook, deps: BookLadderRunDeps): Promise<LadderRun> {
  const { indexerSearchService, sink, searchLadderCooldown } = deps;

  const fullLadder = buildQueryLadder({ title: book.title, author: book.authors?.[0]?.name });
  const rung1Key = rungDedupKey(fullLadder[0]!);
  const scheduled = deps.ladderMode === 'scheduled';
  const restricted = scheduled && searchLadderCooldown?.shouldRestrict(book.id, rung1Key, Date.now()) === true;
  const ladder = restricted ? fullLadder.slice(0, 1) : fullLadder;

  const execute = deps.streaming
    ? await createStreamingExecutor(book, indexerSearchService, sink, deps.signal)
    : createAggregateExecutor(book, indexerSearchService, sink, deps.log, deps.signal);

  const ran = await runQueryLadder(ladder, execute);

  if (scheduled && searchLadderCooldown) {
    // Never re-record a restricted run or every cycle would extend the cooldown.
    if (ran.exhausted && !restricted) searchLadderCooldown.recordExhausted(book.id, rung1Key, Date.now());
    else if (ran.index === 0 && ran.results.length > 0) searchLadderCooldown.clear(book.id);
  }

  return ran;
}
