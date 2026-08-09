import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';

export type SearchBook = {
  id: number;
  title: string;
  /** Minutes-backed `books.duration`; normalized to seconds via `resolveBookQualityInputs` (#1797). */
  duration?: number | null;
  /** Seconds-backed `books.audioDuration`; takes precedence over `duration` for quality (#1797). */
  audioDuration?: number | null;
  authors?: Array<{ name: string }> | null;
  narrators?: Array<{ name: string }> | null;
};

/**
 * Keep streaming and silent pipelines identical. `grabError` emits SSE only; persistent failure
 * recording stays in the pipeline core so both paths record exactly once.
 */
export interface SearchEventSink {
  searchStarted(indexers: Array<{ id: number; name: string }>): void;
  indexerComplete(indexerId: number, name: string, resultCount: number, elapsedMs: number): void;
  indexerError(indexerId: number, name: string, error: string, elapsedMs: number): void;
  searchComplete(outcome: 'no_results' | 'grabbed' | 'skipped'): void;
  grabbed(best: SearchResult): void;
  grabError(error: Error, releaseTitle: string): void;
}

export const NOOP_SINK: SearchEventSink = {
  searchStarted: () => {},
  indexerComplete: () => {},
  indexerError: () => {},
  searchComplete: () => {},
  grabbed: () => {},
  grabError: () => {},
};

/** Track total results and enabled indexers needed by later SSE events. */
export function createBroadcasterSink(
  book: SearchBook,
  broadcaster: EventBroadcasterService,
  log: FastifyBaseLogger,
): SearchEventSink {
  let totalResults = 0;
  let indexers: Array<{ id: number; name: string }> = [];
  return {
    searchStarted(enabledIndexers) {
      indexers = enabledIndexers;
      safeEmit(broadcaster, 'search_started', {
        book_id: book.id, book_title: book.title,
        indexers: enabledIndexers.map(i => ({ id: i.id, name: i.name })),
      }, log);
    },
    indexerComplete(indexerId, name, resultCount, elapsedMs) {
      totalResults += resultCount;
      safeEmit(broadcaster, 'search_indexer_complete', {
        book_id: book.id, indexer_id: indexerId, indexer_name: name,
        results_found: resultCount, elapsed_ms: elapsedMs,
      }, log);
    },
    indexerError(indexerId, name, error, elapsedMs) {
      safeEmit(broadcaster, 'search_indexer_error', {
        book_id: book.id, indexer_id: indexerId, indexer_name: name,
        error, elapsed_ms: elapsedMs,
      }, log);
    },
    searchComplete(outcome) {
      safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome }, log);
    },
    grabbed(best) {
      const indexerName = indexers.find(i => i.id === best.indexerId)?.name ?? best.indexer ?? 'unknown';
      safeEmit(broadcaster, 'search_grabbed', { book_id: book.id, release_title: best.title, indexer_name: indexerName }, log);
    },
    grabError(error, releaseTitle) {
      const errorMessage = error.message || 'Unknown grab error';
      safeEmit(broadcaster, 'search_complete', {
        book_id: book.id,
        total_results: totalResults,
        outcome: 'grab_error',
        book_title: book.title,
        error_message: errorMessage,
        release_title: releaseTitle,
      }, log);
    },
  };
}
