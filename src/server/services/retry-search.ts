import type { FastifyBaseLogger } from 'fastify';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { DownloadWithBook } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { RetryBudget } from './retry-budget.js';
import { buildSearchQuery, buildNarratorPriority, filterAndRankResults, filterBlacklistedResults } from './search-pipeline.js';
import { buildGrabPayload } from './grab-payload.js';
import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


export type RetryOutcome =
  | { outcome: 'retried'; download: DownloadWithBook }
  | { outcome: 'exhausted' }
  | { outcome: 'no_candidates' }
  | { outcome: 'retry_error'; error: string };

export interface RetrySearchDeps {
  indexerSearchService: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  blacklistService: BlacklistService;
  bookService: BookService;
  settingsService: SettingsService;
  retryBudget: RetryBudget;
  log: FastifyBaseLogger;
}

/** Factory to build RetrySearchDeps from a Services bag + logger. Eliminates duplication across routes and jobs. */
export function createRetrySearchDeps(services: {
  indexerSearch: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  blacklist: BlacklistService;
  book: BookService;
  settings: SettingsService;
  retryBudget: RetryBudget;
}, log: FastifyBaseLogger): RetrySearchDeps {
  return {
    indexerSearchService: services.indexerSearch,
    downloadOrchestrator: services.downloadOrchestrator,
    blacklistService: services.blacklist,
    bookService: services.book,
    settingsService: services.settings,
    retryBudget: services.retryBudget,
    log,
  };
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
  const { indexerSearchService, downloadOrchestrator, blacklistService, bookService, settingsService, retryBudget, log } = deps;

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

    const query = buildSearchQuery(book);
    const rawResults = await indexerSearchService.searchAll(query, {
      title: book.title,
      author: book.authors?.[0]?.name,
    });

    if (rawResults.length === 0) {
      log.debug({ bookId, title: book.title }, 'Retry search returned no results');
      return { outcome: 'no_candidates' };
    }

    const filteredResults = await filterBlacklistedResults(rawResults, blacklistService, log);

    // Enrich Usenet results before filtering
    await enrichUsenetLanguages(filteredResults, log);

    // Quality filtering and ranking
    const qualitySettings = await settingsService.get('quality');
    const metadataSettings = await settingsService.get('metadata');
    const searchSettings = await settingsService.get('search');
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
    const retryInputCount = filteredResults.length;
    const { results } = filterAndRankResults(filteredResults, book.duration ?? undefined, {
      grabFloor: qualitySettings.grabFloor,
      minSeeders: qualitySettings.minSeeders,
      protocolPreference: qualitySettings.protocolPreference,
      rejectWords: qualitySettings.rejectWords,
      requiredWords: qualitySettings.requiredWords,
      languages: metadataSettings.languages,
      ...(narratorPriority !== undefined && { narratorPriority }),
      maxDownloadSize: qualitySettings.maxDownloadSize,
    }, log);
    if (results.length < retryInputCount) {
      log.debug({ inputCount: retryInputCount, outputCount: results.length }, 'Quality gate filtering applied');
    }

    // Take best downloadable result
    const best = results.find((r) => r.downloadUrl);
    if (!best) {
      log.debug({ bookId, title: book.title, attempt }, 'No viable candidates after filtering');
      return { outcome: 'no_candidates' };
    }

    // Grab the best candidate
    const newDownload = await downloadOrchestrator.grab(
      buildGrabPayload(best, book.id, { ...(best.guid !== undefined && { guid: best.guid }), skipDuplicateCheck: true }),
    );

    log.info({ bookId, title: best.title, attempt }, 'Retry search grabbed candidate');
    return { outcome: 'retried', download: newDownload };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    log.warn({ bookId, error: serializeError(error), attempt }, 'Retry search failed');
    return { outcome: 'retry_error', error: message };
  }
}
