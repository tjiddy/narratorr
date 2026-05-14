import type { FastifyBaseLogger } from 'fastify';
import { filterMultiPartUsenet, scoreResult } from '../../core/utils/index.js';
import type { SearchResult } from '../../core/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { BookWithAuthor } from '../services/book.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { DuplicateDownloadError } from '../services/download.service.js';
import { buildNarratorPriority, filterAndRankResults, filterBlacklistedResults } from '../services/search-pipeline.js';
import { buildGrabPayload } from '../services/grab-payload.js';
import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


const MATCH_THRESHOLD = 0.7;

export interface RssJobResult {
  polled: number;
  matched: number;
  grabbed: number;
}

/**
 * Run a single RSS sync cycle: poll RSS feeds from RSS-capable indexers,
 * match results to wanted books, and grab the best matches.
 */
// eslint-disable-next-line complexity -- feed-first matching with per-book dedup and error isolation
export async function runRssJob(
  settingsService: SettingsService,
  bookListService: BookListService,
  indexerSearchService: IndexerSearchService,
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
  const searchSettings = await settingsService.get('search');

  const { data: wantedBooks } = await bookListService.getAll('wanted');
  const candidates: BookWithAuthor[] = wantedBooks;

  if (candidates.length === 0) {
    log.debug('No wanted books for RSS sync');
    return { polled: 0, matched: 0, grabbed: 0 };
  }

  // Get RSS-capable indexers
  const rssIndexers = await indexerSearchService.getRssCapableIndexers();
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
      const results = await indexerSearchService.pollRss(indexer);
      polled++;
      if (results.length === 0) {
        log.debug({ indexer: indexer.name }, 'RSS feed returned zero items');
      } else {
        log.debug({ indexer: indexer.name, count: results.length }, 'RSS feed polled');
        allResults.push(...results);
      }
    } catch (error: unknown) {
      log.warn({ indexer: indexer.name, error: serializeError(error) }, 'RSS poll failed for indexer');
    }
  }

  if (allResults.length === 0) {
    log.info({ polled }, 'RSS sync completed — no feed items');
    return { polled, matched: 0, grabbed: 0 };
  }

  const filtered = await filterBlacklistedResults(allResults, blacklistService, log);

  // Match each feed item to the best candidate book
  // Collect all matching items per book so we can rank the full set after filtering
  const itemsPerBook = new Map<number, { results: SearchResult[]; candidate: BookWithAuthor }>();

  for (const item of filtered) {
    if (!item.title) {
      log.debug({ rawTitle: item.rawTitle }, 'Skipping RSS item with no parseable title');
      continue;
    }

    let bestScore = 0;
    let bestCandidate: BookWithAuthor | null = null;

    for (const candidate of candidates) {
      const score = scoreResult(
        { title: item.title, ...(item.author !== undefined && { author: item.author }) },
        { title: candidate.title, ...(candidate.authors?.[0]?.name !== undefined && { author: candidate.authors[0].name }) },
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

    // Enrich Usenet results before filtering
    await enrichUsenetLanguages(bookResults, log);

    // Filter multi-part Usenet posts (after enrichment so nzbName is available)
    const { filtered: afterMultipart, rejectedTitles: rssMultipartRejections } = filterMultiPartUsenet(bookResults);
    for (const r of rssMultipartRejections) {
      log.debug({ title: r.title, reason: 'multi-part-detected', matchedPattern: r.matchedPattern }, 'Multi-part Usenet result rejected');
    }

    // Apply filter pipeline to all items for this book, then pick best-ranked
    const duration = candidate.duration
      ? candidate.duration * 60
      : (candidate.audioDuration ?? undefined);
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, candidate.narrators);
    const rssInputCount = afterMultipart.length;
    const { results: ranked } = filterAndRankResults(afterMultipart, duration, {
      grabFloor: qualitySettings.grabFloor,
      minSeeders: qualitySettings.minSeeders,
      protocolPreference: qualitySettings.protocolPreference,
      rejectWords: qualitySettings.rejectWords,
      requiredWords: qualitySettings.requiredWords,
      languages: metadataSettings.languages,
      narratorPriority,
      minDownloadSize: qualitySettings.minDownloadSize,
      maxDownloadSize: qualitySettings.maxDownloadSize,
    }, log);
    if (ranked.length < rssInputCount) {
      log.debug({ inputCount: rssInputCount, outputCount: ranked.length }, 'Quality gate filtering applied');
    }

    if (ranked.length === 0) {
      log.debug({ bookId, title: bookResults[0]!.title }, 'RSS match filtered out by quality pipeline');
      continue;
    }

    const best = ranked.find((r) => r.downloadUrl);
    if (!best) continue;

    // Attempt grab with mutex
    try {
      await downloadOrchestrator.grab(
        buildGrabPayload(best, bookId, { source: 'rss' }),
      );
      grabbed++;
      log.info({ bookId, title: best.title }, 'RSS grabbed');
    } catch (grabError: unknown) {
      if (grabError instanceof DuplicateDownloadError) {
        log.debug({ bookId }, 'Skipping RSS grab — book already has active download');
      } else {
        const message = getErrorMessage(grabError);
        log.info({ bookId, error: message }, 'RSS grab failed (possible concurrent race)');
      }
    }
  }

  log.info({ polled, matched, grabbed }, 'RSS sync completed');
  return { polled, matched, grabbed };
}

