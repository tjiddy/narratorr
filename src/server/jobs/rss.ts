import type { FastifyBaseLogger } from 'fastify';
import { scoreResult, resolveBookQualityInputs } from '@core/utils/index.js';
import type { SearchResult } from '@core/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { BookWithAuthor } from '../services/book.service.js';
import type { BookListService } from '../services/book-list.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { BlacklistService } from '../services/blacklist.service.js';
import { DuplicateDownloadError } from '../services/download-errors.js';
import { buildNarratorPriority, applyMultiPartFilterAndRank, buildSearchFilterOptions, filterBlacklistedResults } from '../services/search-pipeline.js';
import { buildGrabPayload } from '../services/grab-payload.js';
import { AUTO_GRAB_PHASE2_CAP, enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


const MATCH_THRESHOLD = 0.7;

export interface RssJobResult {
  polled: number;
  /** Feeds the #2376 breaker suppressed. Never folded into `polled`, which means feeds actually
   *  fetched — counting a zero-I/O skip there would misreport RSS coverage. */
  skipped: number;
  matched: number;
  grabbed: number;
}

// eslint-disable-next-line complexity -- feed-first matching with per-book dedup and error isolation
export async function runRssJob(
  settingsService: SettingsService,
  bookListService: BookListService,
  indexerSearchService: IndexerSearchService,
  downloadOrchestrator: DownloadOrchestrator,
  blacklistService: BlacklistService,
  indexerService: IndexerService,
  log: FastifyBaseLogger,
): Promise<RssJobResult> {
  const rssSettings = await settingsService.get('rss');
  if (!rssSettings.enabled) {
    log.debug('RSS sync is disabled, skipping');
    return { polled: 0, skipped: 0, matched: 0, grabbed: 0 };
  }

  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const searchSettings = await settingsService.get('search');

  const { data: wantedBooks } = await bookListService.getAll('wanted');
  const candidates: BookWithAuthor[] = wantedBooks;

  if (candidates.length === 0) {
    log.debug('No wanted books for RSS sync');
    return { polled: 0, skipped: 0, matched: 0, grabbed: 0 };
  }

  const rssIndexers = await indexerSearchService.getRssCapableIndexers();
  if (rssIndexers.length === 0) {
    log.debug('No RSS-capable indexers enabled');
    return { polled: 0, skipped: 0, matched: 0, grabbed: 0 };
  }

  log.info({ indexerCount: rssIndexers.length, candidateCount: candidates.length }, 'Starting RSS sync');

  let polled = 0;
  let skipped = 0;
  const allResults: SearchResult[] = [];

  for (const indexer of rssIndexers) {
    try {
      const { results, skipped: suppressed } = await indexerSearchService.pollRss(indexer);
      // A skip is not an error and must not short-circuit the loop: the rest still poll.
      if (suppressed) {
        skipped++;
        continue;
      }
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
    log.info({ polled, skipped }, 'RSS sync completed — no feed items');
    return { polled, skipped, matched: 0, grabbed: 0 };
  }

  const filtered = await filterBlacklistedResults(allResults, blacklistService, log);

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

    // Both Phase-2 capping and canonicalCompare consume matchScore; without it,
    // Usenet candidates tend to fall back to feed order.
    item.matchScore = bestScore;

    const existing = itemsPerBook.get(bestCandidate.id);
    if (existing) {
      existing.results.push(item);
    } else {
      itemsPerBook.set(bestCandidate.id, { results: [item], candidate: bestCandidate });
    }
  }

  let matched = 0;
  let grabbed = 0;

  // Reuse one LAN allowlist snapshot for every book in this cycle.
  const lanAllowlist = await indexerService.getLanAllowlist();

  for (const [bookId, { results: bookResults, candidate }] of itemsPerBook) {
    matched++;

    // Enrichment must precede filters that inspect NZB-derived fields; cap its Phase-2 fetches.
    await enrichUsenetLanguages(bookResults, log, lanAllowlist, { maxPhase2Fetches: AUTO_GRAB_PHASE2_CAP });

    // Preserve canonical audioDuration ?? duration*60 precedence across grab paths.
    const { durationSeconds } = resolveBookQualityInputs(candidate);
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, candidate.narrators);
    const { results: ranked } = applyMultiPartFilterAndRank(
      bookResults,
      durationSeconds ?? undefined,
      buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
      log,
    );

    if (ranked.length === 0) {
      log.debug({ bookId, title: bookResults[0]!.title }, 'RSS match filtered out by quality pipeline');
      continue;
    }

    const best = ranked.find((r) => r.downloadUrl);
    if (!best) continue;

    try {
      await downloadOrchestrator.grab(
        buildGrabPayload(best, bookId, { source: 'rss' }),
      );
      grabbed++;
      log.info({ bookId, title: best.title }, 'RSS grabbed');
    } catch (grabError: unknown) {
      if (grabError instanceof DuplicateDownloadError) {
        log.debug({ bookId }, 'Skipping RSS grab — book already has a blocking download or import');
      } else {
        const message = getErrorMessage(grabError);
        log.info({ bookId, error: message }, 'RSS grab failed (possible concurrent race)');
      }
    }
  }

  log.info({ polled, skipped, matched, grabbed }, 'RSS sync completed');
  return { polled, skipped, matched, grabbed };
}

