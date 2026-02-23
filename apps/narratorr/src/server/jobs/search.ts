import type { FastifyBaseLogger } from 'fastify';
import type { SearchResult } from '@narratorr/core';
import type { SettingsService } from '../services/settings.service.js';
import type { BookService } from '../services/book.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadService } from '../services/download.service.js';

export interface SearchJobResult {
  searched: number;
  grabbed: number;
}

/**
 * Select the best result from a list of search results.
 * Filters out results without a downloadUrl, then ranks by:
 * 1. matchScore (when difference > 0.1 threshold — relevance matters more than seeders)
 * 2. seeders (fallback when scores are similar or absent)
 */
export function selectBestResult(results: SearchResult[]): SearchResult | null {
  const downloadable = results.filter((r) => r.downloadUrl);
  if (downloadable.length === 0) return null;

  downloadable.sort((a, b) => {
    const scoreA = a.matchScore ?? 0;
    const scoreB = b.matchScore ?? 0;
    const scoreDiff = scoreB - scoreA;

    // If score difference is significant, prefer higher score
    if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

    // Otherwise, prefer more seeders
    return (b.seeders ?? 0) - (a.seeders ?? 0);
  });
  return downloadable[0];
}

/**
 * Run a single search cycle: find wanted books, search indexers, optionally grab best result.
 */
export async function runSearchJob(
  settingsService: SettingsService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadService: DownloadService,
  log: FastifyBaseLogger,
): Promise<SearchJobResult> {
  const searchSettings = await settingsService.get('search');
  if (!searchSettings.enabled) {
    log.debug('Scheduled search is disabled, skipping');
    return { searched: 0, grabbed: 0 };
  }

  const wantedBooks = await bookService.getAll('wanted');
  if (wantedBooks.length === 0) {
    log.debug('No wanted books to search for');
    return { searched: 0, grabbed: 0 };
  }

  log.info({ count: wantedBooks.length }, 'Starting scheduled search for wanted books');

  let searched = 0;
  let grabbed = 0;

  for (const book of wantedBooks) {
    const query = [book.title, book.author?.name].filter(Boolean).join(' ');
    try {
      const results = await indexerService.searchAll(query, {
        title: book.title,
        author: book.author?.name,
      });
      searched++;

      if (results.length === 0) {
        log.debug({ bookId: book.id, title: book.title }, 'No results found');
        continue;
      }

      log.info({ bookId: book.id, title: book.title, resultCount: results.length }, 'Search results found');

      if (searchSettings.autoGrab) {
        const best = selectBestResult(results);
        if (best && best.downloadUrl) {
          await downloadService.grab({
            downloadUrl: best.downloadUrl,
            title: best.title,
            protocol: best.protocol,
            bookId: book.id,
            size: best.size,
            seeders: best.seeders,
          });
          grabbed++;
          log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
        }
      }
    } catch (error) {
      log.warn({ error, bookId: book.id, title: book.title }, 'Search failed for book');
    }
  }

  log.info({ searched, grabbed }, 'Scheduled search completed');
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
): void {
  async function scheduleNext() {
    try {
      const searchSettings = await settingsService.get('search');
      const intervalMs = searchSettings.intervalMinutes * 60 * 1000;

      setTimeout(async () => {
        try {
          await runSearchJob(settingsService, bookService, indexerService, downloadService, log);
        } catch (error) {
          log.error(error, 'Search job error');
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
