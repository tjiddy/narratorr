/**
 * I/O half of the query ladder: the pure ladder chooses queries while this module executes them
 * and settles cooldown state.
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
 * Emit `search_started` once and retain abort controllers across rungs. `succeeded` counts
 * responding indexers so the ladder can distinguish a real zero from an outage.
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

/** Shared silent executor preserves the transport/ranking author split across aggregate callers. */
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
  /** True selects the streaming executor. */
  streaming: boolean;
  sink: SearchEventSink;
  searchLadderCooldown?: SearchLadderCooldown | undefined;
  /** `'scheduled'` consults and records the cooldown; `'always'` does neither. */
  ladderMode: 'scheduled' | 'always';
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
    ? await createStreamingExecutor(book, indexerSearchService, sink)
    : createAggregateExecutor(book, indexerSearchService);

  const ran = await runQueryLadder(ladder, execute);

  if (scheduled && searchLadderCooldown) {
    // Never re-record a restricted run or every cycle would extend the cooldown.
    if (ran.exhausted && !restricted) searchLadderCooldown.recordExhausted(book.id, rung1Key, Date.now());
    else if (ran.index === 0 && ran.results.length > 0) searchLadderCooldown.clear(book.id);
  }

  return ran;
}
