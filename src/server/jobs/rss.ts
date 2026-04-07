import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, compareQuality, resolveBookQualityInputs, scoreResult } from '../../core/utils/index.js';
import { isMultiPartUsenetPost } from '../../core/utils/index.js';
import type { SearchResult } from '../../core/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { BookService, BookWithAuthor } from '../services/book.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { filterAndRankResults, filterBlacklistedResults } from '../services/search-pipeline.js';

const MATCH_THRESHOLD = 0.7;

export interface RssJobResult {
  polled: number;
  matched: number;
  grabbed: number;
}

/**
 * Run a single RSS sync cycle: poll RSS feeds from RSS-capable indexers,
 * match results to wanted/monitored books, and grab the best matches.
 */
// eslint-disable-next-line complexity -- feed-first matching with per-book dedup, upgrades, and error isolation
export async function runRssJob(
  settingsService: SettingsService,
  bookListService: BookListService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  blacklistService: BlacklistService,
  log: FastifyBaseLogger,
): Promise<RssJobResult> {
  const rssSettings = await settingsService.get('rss');
  if (!rssSettings.enabled) {
    log.debug('RSS sync is disabled, skipping');
    return { polled: 0, matched: 0, grabbed: 0 };
  }

  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');

  // Load candidate books: wanted + monitored-for-upgrade
  const { data: wantedBooks } = await bookListService.getAll('wanted');
  const monitoredBooks = await bookService.getMonitoredBooks();
  const candidates: Array<BookWithAuthor & { isUpgrade: boolean }> = [
    ...wantedBooks.map((b) => ({ ...b, isUpgrade: false })),
    ...monitoredBooks.map((b) => ({ ...b, isUpgrade: true })),
  ];

  if (candidates.length === 0) {
    log.debug('No wanted or monitored books for RSS sync');
    return { polled: 0, matched: 0, grabbed: 0 };
  }

  // Get RSS-capable indexers
  const rssIndexers = await indexerService.getRssCapableIndexers();
  if (rssIndexers.length === 0) {
    log.debug('No RSS-capable indexers enabled');
    return { polled: 0, matched: 0, grabbed: 0 };
  }

  log.info({ indexerCount: rssIndexers.length, candidateCount: candidates.length }, 'Starting RSS sync');

  // Poll each indexer and collect all results
  let polled = 0;
  const allResults: SearchResult[] = [];

  for (const indexer of rssIndexers) {
    try {
      const results = await indexerService.pollRss(indexer);
      polled++;
      if (results.length === 0) {
        log.debug({ indexer: indexer.name }, 'RSS feed returned zero items');
      } else {
        log.debug({ indexer: indexer.name, count: results.length }, 'RSS feed polled');
        allResults.push(...results);
      }
    } catch (error: unknown) {
      log.warn({ indexer: indexer.name, error }, 'RSS poll failed for indexer');
    }
  }

  if (allResults.length === 0) {
    log.info({ polled }, 'RSS sync completed — no feed items');
    return { polled, matched: 0, grabbed: 0 };
  }

  // Filter multi-part Usenet posts
  const afterMultipart = allResults.filter((r) => {
    if (r.protocol !== 'usenet') return true;
    const sourceTitle = r.rawTitle ?? r.title;
    const multiPart = isMultiPartUsenetPost(sourceTitle);
    return !(multiPart.match && multiPart.total! > 1);
  });

  const filtered = await filterBlacklistedResults(afterMultipart, blacklistService);

  // Match each feed item to the best candidate book
  // Collect all matching items per book so we can rank the full set after filtering
  const itemsPerBook = new Map<number, { results: SearchResult[]; candidate: BookWithAuthor & { isUpgrade: boolean } }>();

  for (const item of filtered) {
    if (!item.title) {
      log.debug({ rawTitle: item.rawTitle }, 'Skipping RSS item with no parseable title');
      continue;
    }

    let bestScore = 0;
    let bestCandidate: (BookWithAuthor & { isUpgrade: boolean }) | null = null;

    for (const candidate of candidates) {
      const score = scoreResult(
        { title: item.title, author: item.author },
        { title: candidate.title, author: candidate.authors?.[0]?.name },
      );
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    if (bestScore < MATCH_THRESHOLD || !bestCandidate) {
      log.debug({ title: item.title, bestScore }, 'No book match above threshold for RSS item');
      continue;
    }

    const existing = itemsPerBook.get(bestCandidate.id);
    if (existing) {
      existing.results.push(item);
    } else {
      itemsPerBook.set(bestCandidate.id, { results: [item], candidate: bestCandidate });
    }
  }

  let matched = 0;
  let grabbed = 0;

  // Process each matched book — filter and rank all candidates together
  for (const [bookId, { results: bookResults, candidate }] of itemsPerBook) {
    matched++;

    // Apply filter pipeline to all items for this book, then pick best-ranked
    const duration = candidate.duration
      ? candidate.duration * 60
      : (candidate.audioDuration ?? undefined);
    const { results: ranked } = filterAndRankResults(
      bookResults,
      duration,
      qualitySettings.grabFloor,
      qualitySettings.minSeeders,
      qualitySettings.protocolPreference,
      qualitySettings.rejectWords,
      qualitySettings.requiredWords,
      metadataSettings.languages,
    );

    if (ranked.length === 0) {
      log.debug({ bookId, title: bookResults[0].title }, 'RSS match filtered out by quality pipeline');
      continue;
    }

    const best = ranked.find((r) => r.downloadUrl);
    if (!best) continue;

    // For upgrades: compare quality to existing import
    if (candidate.isUpgrade) {
      if (!candidate.path) continue;
      const { sizeBytes: existingSize, durationSeconds: existingDuration } = resolveBookQualityInputs(candidate);
      if (!existingDuration || existingDuration <= 0) continue;
      if (!best.size) continue;

      const comparison = compareQuality(existingSize, best.size, existingDuration);
      if (comparison !== 'higher') continue;

      // Double-check: result must also be above grab floor
      if (qualitySettings.grabFloor > 0) {
        const resultQuality = calculateQuality(best.size, existingDuration);
        if (!resultQuality || resultQuality.mbPerHour < qualitySettings.grabFloor) continue;
      }
    }

    // Attempt grab with mutex
    try {
      await downloadOrchestrator.grab({
        downloadUrl: best.downloadUrl!,
        title: best.title,
        protocol: best.protocol,
        bookId,
        indexerId: best.indexerId,
        size: best.size,
        seeders: best.seeders,
        source: 'rss',
      });
      grabbed++;
      log.info({ bookId, title: best.title, isUpgrade: candidate.isUpgrade }, 'RSS grabbed');
    } catch (grabError: unknown) {
      if (grabError instanceof DuplicateDownloadError) {
        log.debug({ bookId }, 'Skipping RSS grab — book already has active download');
      } else {
        const message = grabError instanceof Error ? grabError.message : String(grabError);
        log.info({ bookId, error: message }, 'RSS grab failed (possible concurrent race)');
      }
    }
  }

  log.info({ polled, matched, grabbed }, 'RSS sync completed');
  return { polled, matched, grabbed };
}

/**
 * Start the RSS sync job with a dynamic interval.
 * Reads intervalMinutes from settings each cycle, so changes take effect without restart.
 */
export function startRssJob(
  settingsService: SettingsService,
  bookListService: BookListService,
  bookService: BookService,
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  blacklistService: BlacklistService,
  log: FastifyBaseLogger,
): void {
  async function scheduleNext() {
    try {
      const rssSettings = await settingsService.get('rss');
      const intervalMs = rssSettings.intervalMinutes * 60 * 1000;

      setTimeout(async () => {
        try {
          await runRssJob(settingsService, bookListService, bookService, indexerService, downloadOrchestrator, blacklistService, log);
        } catch (error: unknown) {
          log.error(error, 'RSS sync job error');
        }
        scheduleNext();
      }, intervalMs);
    } catch (error: unknown) {
      log.error(error, 'Failed to read RSS interval, retrying in 5 minutes');
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
  log.info('RSS sync job scheduler started');
}
