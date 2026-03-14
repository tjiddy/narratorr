import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, compareQuality, resolveBookQualityInputs } from '../../core/utils/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { BookService } from '../services/book.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadService } from '../services/download.service.js';
import type { RetryBudget } from '../services/retry-budget.js';
import { buildSearchQuery, filterAndRankResults, searchAndGrabForBook } from '../services/search-pipeline.js';

export type { SingleBookSearchResult } from '../services/search-pipeline.js';
export { searchAndGrabForBook } from '../services/search-pipeline.js';

export interface SearchJobResult {
  searched: number;
  grabbed: number;
}

export interface SearchAllWantedResult {
  searched: number;
  grabbed: number;
  skipped: number;
  errors: number;
}

/**
 * Run a single search cycle: find wanted books, search indexers, and grab the best result.
 */
export async function runSearchJob(
  settingsService: SettingsService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadService: DownloadService,
  log: FastifyBaseLogger,
  retryBudget?: RetryBudget,
): Promise<SearchJobResult> {
  // Reset retry budget at the start of every search cycle (any caller)
  retryBudget?.resetAll();

  const searchSettings = await settingsService.get('search');
  if (!searchSettings.enabled) {
    log.debug('Scheduled search is disabled, skipping');
    return { searched: 0, grabbed: 0 };
  }

  const qualitySettings = await settingsService.get('quality');
  const wantedBooks = await bookService.getAll('wanted');
  if (wantedBooks.length === 0) {
    log.debug('No wanted books to search for');
    return { searched: 0, grabbed: 0 };
  }

  log.info({ count: wantedBooks.length }, 'Starting scheduled search for wanted books');

  let searched = 0;
  let grabbed = 0;

  for (const book of wantedBooks) {
    try {
      const result = await searchAndGrabForBook(book, indexerService, downloadService, qualitySettings, log);
      searched++;
      if (result.result === 'grabbed') grabbed++;
      if (result.result === 'grab_error') {
        log.warn({ error: result.error, bookId: book.id, title: book.title }, 'Search failed for book');
      }
    } catch (error) {
      log.warn({ error, bookId: book.id, title: book.title }, 'Search failed for book');
    }
  }

  log.info({ searched, grabbed }, 'Scheduled search completed');
  return { searched, grabbed };
}

/**
 * Search all wanted books against all enabled indexers and grab the best result per book.
 * Unlike runSearchJob, this bypasses the searchSettings.enabled check (manual trigger).
 */
export async function searchAllWanted(
  settingsService: SettingsService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadService: DownloadService,
  log: FastifyBaseLogger,
): Promise<SearchAllWantedResult> {
  const qualitySettings = await settingsService.get('quality');
  const wantedBooks = await bookService.getAll('wanted');

  if (wantedBooks.length === 0) {
    log.debug('No wanted books to search for');
    return { searched: 0, grabbed: 0, skipped: 0, errors: 0 };
  }

  log.info({ count: wantedBooks.length }, 'Starting search-all-wanted');

  let searched = 0;
  let grabbed = 0;
  let skipped = 0;
  let errors = 0;

  for (const book of wantedBooks) {
    try {
      const result = await searchAndGrabForBook(book, indexerService, downloadService, qualitySettings, log);
      searched++;
      if (result.result === 'grabbed') grabbed++;
      else if (result.result === 'skipped') skipped++;
      else if (result.result === 'grab_error') {
        errors++;
        log.warn({ error: result.error, bookId: book.id, title: book.title }, 'Grab failed for book');
      }
    } catch (error) {
      errors++;
      log.warn({ error, bookId: book.id, title: book.title }, 'Search failed for book');
    }
  }

  log.info({ searched, grabbed, skipped, errors }, 'Search-all-wanted completed');
  return { searched, grabbed, skipped, errors };
}

/**
 * Run a single upgrade search cycle: find monitored imported books,
 * search indexers, and grab if a higher-quality release is found.
 * Existing scheduled search for wanted books remains unchanged; this is additive.
 */
// eslint-disable-next-line complexity -- sequential early-return guards for book eligibility + quality comparison
export async function runUpgradeSearchJob(
  settingsService: SettingsService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadService: DownloadService,
  log: FastifyBaseLogger,
): Promise<SearchJobResult> {
  const searchSettings = await settingsService.get('search');
  if (!searchSettings.enabled) {
    log.debug('Scheduled search is disabled, skipping upgrade search');
    return { searched: 0, grabbed: 0 };
  }

  const qualitySettings = await settingsService.get('quality');
  const monitoredBooks = await bookService.getMonitoredBooks();
  if (monitoredBooks.length === 0) {
    log.debug('No monitored books for upgrade search');
    return { searched: 0, grabbed: 0 };
  }

  log.info({ count: monitoredBooks.length }, 'Starting upgrade search for monitored books');

  let searched = 0;
  let grabbed = 0;

  for (const book of monitoredBooks) {
    if (!book.path) continue;

    const { sizeBytes: existingSize, durationSeconds: existingDuration } = resolveBookQualityInputs(book);
    if (!existingDuration || existingDuration <= 0) {
      log.debug({ bookId: book.id, title: book.title }, 'Skipping upgrade search — no duration');
      continue;
    }

    const query = buildSearchQuery(book);
    try {
      const rawResults = await indexerService.searchAll(query, {
        title: book.title,
        author: book.author?.name,
      });
      searched++;

      // Apply quality filtering and ranking
      const { results } = filterAndRankResults(
        rawResults,
        existingDuration,
        qualitySettings.grabFloor,
        qualitySettings.minSeeders,
        qualitySettings.protocolPreference,
        qualitySettings.rejectWords,
        qualitySettings.requiredWords,
      );

      if (results.length === 0) continue;

      // Take first downloadable result with size — already canonically ranked
      const best = results.find((r) => r.downloadUrl && r.size);
      if (!best) continue;

      // Compare quality: only grab if result is meaningfully better
      const comparison = compareQuality(existingSize, best.size!, existingDuration);
      if (comparison !== 'higher') continue;

      // Double-check: result must also be above grab floor
      if (qualitySettings.grabFloor > 0) {
        const resultQuality = calculateQuality(best.size!, existingDuration);
        if (!resultQuality || resultQuality.mbPerHour < qualitySettings.grabFloor) continue;
      }

      try {
        await downloadService.grab({
          downloadUrl: best.downloadUrl!,
          title: best.title,
          protocol: best.protocol,
          bookId: book.id,
          size: best.size!,
          seeders: best.seeders,
        });
        grabbed++;
        log.info({ bookId: book.id, title: best.title }, 'Upgrade grabbed');
      } catch (grabError) {
        const message = grabError instanceof Error ? grabError.message : String(grabError);
        if (message.includes('already has an active download')) {
          log.debug({ bookId: book.id }, 'Skipping upgrade grab — active download exists');
        } else {
          throw grabError;
        }
      }
    } catch (error) {
      log.warn({ error, bookId: book.id, title: book.title }, 'Upgrade search failed for book');
    }
  }

  log.info({ searched, grabbed }, 'Upgrade search completed');
  return { searched, grabbed };
}

/**
 * Start the scheduled search job with a dynamic interval.
 * Reads intervalMinutes from settings each cycle, so changes take effect without restart.
 */
export function startSearchJob(
  settingsService: SettingsService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadService: DownloadService,
  log: FastifyBaseLogger,
  retryBudget?: RetryBudget,
): void {
  async function scheduleNext() {
    try {
      const searchSettings = await settingsService.get('search');
      const intervalMs = searchSettings.intervalMinutes * 60 * 1000;

      setTimeout(async () => {
        try {
          await runSearchJob(settingsService, bookService, indexerService, downloadService, log, retryBudget);
        } catch (error) {
          log.error(error, 'Search job error');
        }
        try {
          await runUpgradeSearchJob(settingsService, bookService, indexerService, downloadService, log);
        } catch (error) {
          log.error(error, 'Upgrade search job error');
        }
        scheduleNext();
      }, intervalMs);
    } catch (error) {
      log.error(error, 'Failed to read search interval, retrying in 5 minutes');
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
  log.info('Search job scheduler started');
}
