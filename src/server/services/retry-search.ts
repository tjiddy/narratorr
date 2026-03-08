import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '../../core/index.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadService, DownloadWithBook } from './download.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { RetryBudget } from './retry-budget.js';
import { filterAndRankResults } from '../routes/search.js';

export type RetryOutcome =
  | { outcome: 'retried'; download: DownloadWithBook }
  | { outcome: 'exhausted' }
  | { outcome: 'no_candidates' }
  | { outcome: 'retry_error'; error: string };

export interface RetrySearchDeps {
  indexerService: IndexerService;
  downloadService: DownloadService;
  blacklistService: BlacklistService;
  bookService: BookService;
  settingsService: SettingsService;
  retryBudget: RetryBudget;
  log: FastifyBaseLogger;
}

/**
 * Shared retry-search helper used by:
 * - Monitor failure handling (handleDownloadFailure)
 * - Manual retry endpoint (POST /api/activity/:id/retry)
 * - Mark-as-failed trigger (EventHistoryService.markFailed)
 *
 * Searches indexers for the book, filters blacklisted releases,
 * ranks results, and grabs the best candidate.
 */
export async function retrySearch(
  bookId: number,
  deps: RetrySearchDeps,
): Promise<RetryOutcome> {
  const { indexerService, downloadService, blacklistService, bookService, settingsService, retryBudget, log } = deps;

  // Check retry budget
  if (!retryBudget.hasRemaining(bookId)) {
    return { outcome: 'exhausted' };
  }

  // Consume an attempt
  const attempt = retryBudget.consumeAttempt(bookId);

  try {
    // Look up the book for search query construction
    const book = await bookService.getById(bookId);
    if (!book) {
      return { outcome: 'retry_error', error: 'Book not found' };
    }

    const query = [book.title, book.author?.name].filter(Boolean).join(' ');
    const rawResults = await indexerService.searchAll(query, {
      title: book.title,
      author: book.author?.name,
    });

    if (rawResults.length === 0) {
      log.debug({ bookId, title: book.title }, 'Retry search returned no results');
      return { outcome: 'no_candidates' };
    }

    // Filter blacklisted releases
    const hashes = rawResults
      .map((r: SearchResult) => r.infoHash)
      .filter((h): h is string => !!h);
    let filteredResults = rawResults;
    if (hashes.length > 0) {
      const blacklisted = await blacklistService.getBlacklistedHashes(hashes);
      filteredResults = rawResults.filter(
        (r: SearchResult) => !r.infoHash || !blacklisted.has(r.infoHash),
      );
    }

    // Quality filtering and ranking
    const qualitySettings = await settingsService.get('quality');
    const { results } = filterAndRankResults(
      filteredResults,
      book.duration ?? undefined,
      qualitySettings.grabFloor,
      qualitySettings.minSeeders,
      qualitySettings.protocolPreference,
      qualitySettings.rejectWords,
      qualitySettings.requiredWords,
    );

    // Take best downloadable result
    const best = results.find((r) => r.downloadUrl);
    if (!best) {
      log.debug({ bookId, title: book.title, attempt }, 'No viable candidates after filtering');
      return { outcome: 'no_candidates' };
    }

    // Grab the best candidate
    const newDownload = await downloadService.grab({
      downloadUrl: best.downloadUrl!,
      title: best.title,
      protocol: best.protocol,
      bookId: book.id,
      size: best.size,
      seeders: best.seeders,
      skipDuplicateCheck: true,
    });

    log.info({ bookId, title: best.title, attempt }, 'Retry search grabbed candidate');
    return { outcome: 'retried', download: newDownload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn({ bookId, error, attempt }, 'Retry search failed');
    return { outcome: 'retry_error', error: message };
  }
}
