import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@core/index.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';
import { serializeError } from '../utils/serialize-error.js';
import { getErrorMessage } from '../utils/error-message.js';

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
  searchComplete(outcome: 'no_results' | 'grabbed' | 'skipped' | 'timed_out'): void;
  grabbed(best: SearchResult): void;
  grabError(error: Error, releaseTitle: string): void;
}

/**
 * The single home for "a search consumer's failure is its own, not the search's".
 *
 * Two things ride on it. A report that throws must not cost the caller results it already holds;
 * and — the sharper one — a callback delivered from inside a per-indexer leg must never be
 * mistaken for a transport outcome, or a broken SSE consumer would circuit-break a healthy
 * indexer (#2376). Both consequences are silent, so the swallow logs rather than discards.
 */
export function deliverSearchReport(
  log: FastifyBaseLogger,
  context: Record<string, unknown>,
  report: () => void,
): void {
  try {
    report();
  } catch (error: unknown) {
    log.warn({ ...context, error: serializeError(error) }, 'Search event consumer threw — report dropped');
  }
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
  // Abandoned deadline work keeps running and reaches its own terminal emission; the client's
  // grabbed handler overwrites an outcome unconditionally, so a late event would flip a timed-out
  // card. A no-op on every path that exists today: each arm returns right after its terminal event.
  let terminal = false;
  const fenced = (event: string): boolean => {
    if (!terminal) return false;
    log.debug({ bookId: book.id, event }, 'Search event dropped — a terminal event already fired');
    return true;
  };
  return {
    searchStarted(enabledIndexers) {
      indexers = enabledIndexers;
      safeEmit(broadcaster, 'search_started', {
        book_id: book.id, book_title: book.title,
        indexers: enabledIndexers.map(i => ({ id: i.id, name: i.name })),
      }, log);
    },
    indexerComplete(indexerId, name, resultCount, elapsedMs) {
      if (fenced('search_indexer_complete')) return;
      totalResults += resultCount;
      safeEmit(broadcaster, 'search_indexer_complete', {
        book_id: book.id, indexer_id: indexerId, indexer_name: name,
        results_found: resultCount, elapsed_ms: elapsedMs,
      }, log);
    },
    indexerError(indexerId, name, error, elapsedMs) {
      if (fenced('search_indexer_error')) return;
      safeEmit(broadcaster, 'search_indexer_error', {
        book_id: book.id, indexer_id: indexerId, indexer_name: name,
        error, elapsed_ms: elapsedMs,
      }, log);
    },
    searchComplete(outcome) {
      if (fenced('search_complete')) return;
      terminal = true;
      safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome }, log);
    },
    grabbed(best) {
      if (fenced('search_grabbed')) return;
      const indexerName = indexers.find(i => i.id === best.indexerId)?.name ?? best.indexer ?? 'unknown';
      safeEmit(broadcaster, 'search_grabbed', { book_id: book.id, release_title: best.title, indexer_name: indexerName }, log);
    },
    grabError(error, releaseTitle) {
      if (fenced('search_complete')) return;
      terminal = true;
      // Reads a caught value, so it bypasses the shared renderer unless routed explicitly (#2604 L2).
      const errorMessage = getErrorMessage(error) || 'Unknown grab error';
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
