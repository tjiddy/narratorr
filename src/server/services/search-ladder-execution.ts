/**
 * The I/O half of the query ladder (#2104) — what `search-query-ladder.ts`
 * deliberately does not own.
 *
 * The ladder module is pure: it decides WHICH queries to issue, in what order,
 * and what corroborates a segment-cut rung. This module supplies the per-rung
 * executors that actually talk to `IndexerSearchService`, and the cooldown
 * bookkeeping around one book's ladder run. It lives outside
 * `search-pipeline.ts` because that file sits ~19 counted lines under the 400
 * `max-lines` cap and cannot absorb new machinery.
 */
import type { SearchBook, SearchEventSink } from './search-event-sink.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { SearchLadderCooldown } from './search-ladder-cooldown.js';
import {
  buildQueryLadder,
  runQueryLadder,
  rungDedupKey,
  type Rung,
  type RungExecution,
  type LadderRun,
} from './search-query-ladder.js';

/**
 * Per-rung search executor for the broadcaster path.
 *
 * `search_started` and the per-indexer abort controllers are hoisted OUT of the
 * returned closure: the ladder may run the closure up to `MAX_SEARCH_RUNGS`
 * times, and the lifecycle event must be emitted exactly once per
 * `searchAndGrabForBook` call. Sticky controllers are what let the pre-adapter
 * abort guard in `searchAllStreaming` skip an indexer the user cancelled on an
 * earlier rung.
 *
 * Per-indexer counts need no buffering across rungs — the client REPLACES its
 * entry by `indexerId` on each completion, so the last rung to report wins,
 * which is the winning rung.
 *
 * `succeeded` counts indexers that ANSWERED. The ladder needs it to tell a real
 * zero from an outage; errored and cancelled indexers never increment it.
 */
export async function createStreamingExecutor(
  book: SearchBook,
  indexerSearchService: IndexerSearchService,
  sink: SearchEventSink,
): Promise<(rung: Rung) => Promise<RungExecution>> {
  const enabledIndexers = await indexerSearchService.getEnabledIndexers();
  sink.searchStarted(enabledIndexers);

  const controllers = new Map<number, AbortController>();
  for (const indexer of enabledIndexers) {
    controllers.set(indexer.id, new AbortController());
  }

  return async (rung: Rung) => {
    let succeeded = 0;
    const results = await indexerSearchService.searchAllStreaming(
      rung.query,
      { title: book.title, author: rung.author, rankingAuthor: book.authors?.[0]?.name },
      controllers,
      {
        onComplete: (indexerId, name, resultCount, elapsedMs) => {
          succeeded++;
          sink.indexerComplete(indexerId, name, resultCount, elapsedMs);
        },
        onError: (indexerId, name, error, elapsedMs) => sink.indexerError(indexerId, name, error, elapsedMs),
      },
    );
    return { results, succeeded };
  };
}

/**
 * Per-rung search executor for the silent aggregate path — the SINGLE home,
 * shared by `searchAndGrabForBook`, `retrySearch`, and the public v1 discovery
 * route. Those three are separate chains with separate gates; sharing the
 * executor is what keeps the transport/ranking split (`author` vs
 * `rankingAuthor`) from drifting between them.
 */
export function createAggregateExecutor(
  book: SearchBook,
  indexerSearchService: IndexerSearchService,
): (rung: Rung) => Promise<RungExecution> {
  return async (rung: Rung) => {
    const { results, succeeded } = await indexerSearchService.searchAllWithStatus(rung.query, {
      title: book.title,
      author: rung.author,
      rankingAuthor: book.authors?.[0]?.name,
    });
    return { results, succeeded };
  };
}

export interface BookLadderRunDeps {
  indexerSearchService: IndexerSearchService;
  /** Present selects the streaming executor, absent the aggregate one. */
  streaming: boolean;
  sink: SearchEventSink;
  searchLadderCooldown?: SearchLadderCooldown | undefined;
  /** `'scheduled'` consults and records the cooldown; `'always'` does neither. */
  ladderMode: 'scheduled' | 'always';
}

/**
 * Build one book's ladder, run it, and settle the cooldown.
 *
 * Rung 1 is today's canonical query verbatim, so a book findable there issues
 * exactly one query per indexer and nothing downstream sees a difference.
 */
export async function runBookQueryLadder(book: SearchBook, deps: BookLadderRunDeps): Promise<LadderRun> {
  const { indexerSearchService, sink, searchLadderCooldown } = deps;

  const fullLadder = buildQueryLadder({ title: book.title, author: book.authors?.[0]?.name });
  const rung1Key = rungDedupKey(fullLadder[0]!);
  const scheduled = deps.ladderMode === 'scheduled';
  const restricted = scheduled && searchLadderCooldown?.shouldRestrict(book.id, rung1Key, Date.now()) === true;
  const ladder = restricted ? fullLadder.slice(0, 1) : fullLadder;

  const execute = deps.streaming
    ? await createStreamingExecutor(book, indexerSearchService, sink)
    : createAggregateExecutor(book, indexerSearchService);

  const ran = await runQueryLadder(ladder, execute);

  if (scheduled && searchLadderCooldown) {
    // Never re-record off a RESTRICTED run: that would refresh the window on
    // every cycle and the cooldown would never expire.
    if (ran.exhausted && !restricted) searchLadderCooldown.recordExhausted(book.id, rung1Key, Date.now());
    else if (ran.index === 0 && ran.results.length > 0) searchLadderCooldown.clear(book.id);
  }

  return ran;
}
