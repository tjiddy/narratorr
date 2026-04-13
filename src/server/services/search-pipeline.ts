import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, isMultiPartUsenetPost } from '../../core/utils/index.js';
import { diceCoefficient, tokenizeNarrators, normalizeNarrator } from '../../core/utils/similarity.js';
import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import type { SearchResult } from '../../core/index.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';
import { buildGrabPayload } from './grab-payload.js';
import { parseWordList } from '../../shared/parse-word-list.js';
import { BYTES_PER_GB } from '../../shared/constants.js';

/** Build a search query string from a book's title and primary author. */
export function buildSearchQuery(book: { title: string; authors?: Array<{ name: string }> | null }): string {
  return [book.title, book.authors?.[0]?.name].filter(Boolean).join(' ');
}

/**
 * Build a NarratorPriority config from search settings and book narrators.
 * Returns undefined when priority is 'quality' or book has no narrators.
 */
export function buildNarratorPriority(
  searchPriority: string,
  bookNarrators?: Array<{ name: string }> | null,
): NarratorPriority | undefined {
  if (searchPriority !== 'accuracy') return undefined;
  const names = bookNarrators?.map(n => n.name).filter(Boolean) ?? [];
  if (names.length === 0) return undefined;
  return { bookNarrators: names };
}

/**
 * Canonical ranking comparator:
 * matchScore gate → narrator match → MB/hr → protocol preference → language → indexer priority → grabs → seeders.
 */
/** Optional narrator-priority config for auto-grab scoring. */
export interface NarratorPriority {
  bookNarrators: string[];
  threshold?: number;
}

/** Aggregated filter/rank options crossing quality, metadata, and computed settings. */
export interface SearchFilterOptions {
  grabFloor: number;
  minSeeders: number;
  protocolPreference: string;
  rejectWords?: string;
  requiredWords?: string;
  languages?: readonly string[];
  narratorPriority?: NarratorPriority;
  maxDownloadSize?: number;
}

const NARRATOR_MATCH_THRESHOLD = 0.8;
const NARRATOR_QUALITY_FLOOR_MBHR = 30; // Low tier boundary

/**
 * Check whether a search result's narrator fuzzy-matches any of the book's narrators.
 * Returns true if the best pairwise diceCoefficient >= threshold.
 */
function isNarratorMatch(result: SearchResult, priority: NarratorPriority): boolean {
  if (!result.narrator) return false;
  const threshold = priority.threshold ?? NARRATOR_MATCH_THRESHOLD;
  const resultTokens = tokenizeNarrators(result.narrator).map(normalizeNarrator).filter(Boolean);
  if (resultTokens.length === 0) return false;
  const bookNormalized = priority.bookNarrators.map(normalizeNarrator).filter(Boolean);
  if (bookNormalized.length === 0) return false;
  let best = 0;
  for (const rt of resultTokens) {
    for (const bn of bookNormalized) {
      best = Math.max(best, diceCoefficient(rt, bn));
    }
  }
  return best >= threshold;
}

/**
 * Compute the narrator-match tier value for a result.
 * Returns 1 for boosted (narrator match above quality floor), 0 otherwise.
 */
function narratorTierValue(
  result: SearchResult,
  priority: NarratorPriority | undefined,
  bookDuration: number | undefined,
  durationUnknown: boolean,
): number {
  if (!priority || priority.bookNarrators.length === 0) return 0;
  if (!isNarratorMatch(result, priority)) return 0;
  // Quality floor guard: don't boost results below Low tier when duration is known
  if (!durationUnknown && result.size && result.size > 0) {
    const quality = calculateQuality(result.size, bookDuration!);
    if (quality && quality.mbPerHour < NARRATOR_QUALITY_FLOOR_MBHR) return 0;
  }
  return 1;
}

// eslint-disable-next-line complexity -- multi-tier sort with null coalescing inflates counted branches
function canonicalCompare(
  a: SearchResult,
  b: SearchResult,
  bookDuration: number | undefined,
  durationUnknown: boolean,
  protocolPreference: string,
  languages: readonly string[],
  narratorPriority?: NarratorPriority,
): number {
  const scoreA = a.matchScore ?? 0;
  const scoreB = b.matchScore ?? 0;
  const scoreDiff = scoreB - scoreA;

  if (Math.abs(scoreDiff) > 0.1) return scoreDiff;

  // Narrator-match tier (only when narratorPriority is provided)
  if (narratorPriority && narratorPriority.bookNarrators.length > 0) {
    const nA = narratorTierValue(a, narratorPriority, bookDuration, durationUnknown);
    const nB = narratorTierValue(b, narratorPriority, bookDuration, durationUnknown);
    if (nA !== nB) return nB - nA;
  }

  if (!durationUnknown) {
    const qualA = (a.size && a.size > 0) ? calculateQuality(a.size, bookDuration!) : null;
    const qualB = (b.size && b.size > 0) ? calculateQuality(b.size, bookDuration!) : null;
    const mbhrA = qualA?.mbPerHour ?? -1;
    const mbhrB = qualB?.mbPerHour ?? -1;
    if (mbhrA !== mbhrB) return mbhrB - mbhrA;
  }

  if (protocolPreference !== 'none') {
    const prefA = a.protocol === protocolPreference ? 1 : 0;
    const prefB = b.protocol === protocolPreference ? 1 : 0;
    if (prefA !== prefB) return prefB - prefA;
  }

  // Language tier: mismatch ranks below match/unknown (absence ≠ mismatch)
  // Sub-tier: primary language (first entry) ranks above other matches
  if (languages.length > 0) {
    const primary = languages[0];
    const aLang = a.language?.toLowerCase();
    const bLang = b.language?.toLowerCase();
    const aMatch = !aLang || languages.includes(aLang) ? 1 : 0;
    const bMatch = !bLang || languages.includes(bLang) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    // Among matches, prefer primary language
    if (aMatch === 1 && bMatch === 1 && languages.length > 1) {
      const aPrimary = aLang === primary ? 1 : 0;
      const bPrimary = bLang === primary ? 1 : 0;
      if (aPrimary !== bPrimary) return bPrimary - aPrimary;
    }
  }

  // Indexer priority tier: lower value = more preferred (ascending)
  const prioA = a.indexerPriority ?? Infinity;
  const prioB = b.indexerPriority ?? Infinity;
  if (prioA !== prioB) return prioA - prioB;

  // Grabs tier: log-scale normalization
  const grabsA = Math.log10((a.grabs ?? 0) + 1);
  const grabsB = Math.log10((b.grabs ?? 0) + 1);
  if (grabsA !== grabsB) return grabsB - grabsA;

  return (b.seeders ?? 0) - (a.seeders ?? 0);
}


/**
 * Apply quality filtering and canonical ranking to search results.
 * Filters by word lists, MB/hr grab floor, and min seeders, then sorts by
 * canonical order: matchScore gate → narrator match → MB/hr → protocol preference → language → indexer priority → grabs → seeders.
 */
export function filterAndRankResults(
  results: SearchResult[],
  bookDuration: number | undefined,
  options: SearchFilterOptions,
): { results: SearchResult[]; durationUnknown: boolean } {
  const { grabFloor, minSeeders, protocolPreference, rejectWords, requiredWords, languages, narratorPriority, maxDownloadSize } = options;
  const durationUnknown = !bookDuration || bookDuration <= 0;

  let filtered = results;

  // Apply reject word filtering (before ranking)
  const rejectList = parseWordList(rejectWords);
  if (rejectList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.nzbName || r.rawTitle || r.title).toLowerCase();
      return !rejectList.some((word) => sourceTitle.includes(word));
    });
  }

  // Apply required word filtering (before ranking)
  const requiredList = parseWordList(requiredWords);
  if (requiredList.length > 0) {
    filtered = filtered.filter((r) => {
      const sourceTitle = (r.nzbName || r.rawTitle || r.title).toLowerCase();
      return requiredList.some((word) => sourceTitle.includes(word));
    });
  }

  // Ebook-only format filter: exclude results that contain ebook keywords (AZW3, EPUB, PDF, MOBI)
  // but no audio keywords (M4B, MP3, FLAC, AAC, OGG). Mixed-format results are kept.
  // Use lookahead/lookbehind instead of \b because JS treats _ as a word char,
  // which would miss scene-style titles like "Dune_EPUB".
  const EBOOK_FORMAT_RE = /(?<![a-zA-Z\d])(azw3|epub|pdf|mobi)(?![a-zA-Z\d])/i;
  const AUDIO_FORMAT_RE = /(?<![a-zA-Z\d])(m4b|mp3|flac|aac|ogg)(?![a-zA-Z\d])/i;
  filtered = filtered.filter((r) => {
    const sourceTitle = r.rawTitle ?? r.title;
    if (!EBOOK_FORMAT_RE.test(sourceTitle)) return true;
    return AUDIO_FORMAT_RE.test(sourceTitle);
  });

  // Apply min seeders filter (torrent only)
  if (minSeeders > 0) {
    filtered = filtered.filter((r) => {
      if (r.protocol !== 'torrent') return true;
      if (r.seeders === undefined || r.seeders === null) return true; // Unknown ≠ zero
      return r.seeders >= minSeeders;
    });
  }

  // Apply grab floor filter (only when duration is known)
  if (!durationUnknown && grabFloor > 0) {
    filtered = filtered.filter((r) => {
      if (!r.size || r.size <= 0) return true; // can't calculate, pass through
      const quality = calculateQuality(r.size, bookDuration!);
      if (!quality) return true; // can't calculate, pass through
      return quality.mbPerHour >= grabFloor;
    });
  }

  // Apply max download size filter (protocol-agnostic, duration-independent)
  if (maxDownloadSize && maxDownloadSize > 0) {
    filtered = filtered.filter((r) => {
      if (!r.size || r.size <= 0) return true; // unknown size → pass through
      return r.size <= maxDownloadSize * BYTES_PER_GB;
    });
  }

  // Language filtering: exclude results with explicit non-matching language
  const langs = languages ?? [];
  if (langs.length > 0) {
    filtered = filtered.filter((r) => {
      if (!r.language) return true; // unknown → pass through
      return langs.includes(r.language.toLowerCase());
    });
  }

  // Canonical ranking
  filtered.sort((a, b) => canonicalCompare(a, b, bookDuration, durationUnknown, protocolPreference, langs, narratorPriority));

  return { results: filtered, durationUnknown };
}

/**
 * Filter out blacklisted releases by infoHash and/or guid.
 * Skips the blacklist lookup entirely when no identifiers are present.
 */
export async function filterBlacklistedResults(
  results: SearchResult[],
  blacklistService: BlacklistService,
): Promise<SearchResult[]> {
  const hashes = results.map(r => r.infoHash).filter((h): h is string => !!h);
  const guids = results.map(r => r.guid).filter((g): g is string => !!g);
  if (hashes.length === 0 && guids.length === 0) return results;
  const { blacklistedHashes, blacklistedGuids } = await blacklistService.getBlacklistedIdentifiers(hashes, guids);
  return results.filter(r =>
    (!r.infoHash || !blacklistedHashes.has(r.infoHash)) &&
    (!r.guid || !blacklistedGuids.has(r.guid)),
  );
}

/**
 * Shared post-processing pipeline for search results.
 * Applies multi-part Usenet filtering, blacklist filtering, and quality ranking.
 * Used by both JSON and SSE search routes.
 */
export async function postProcessSearchResults(
  allResults: SearchResult[],
  bookDuration: number | undefined,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
  logger: FastifyBaseLogger,
): Promise<{
  results: SearchResult[];
  durationUnknown: boolean;
  unsupportedResults: { count: number; titles: string[] };
}> {
  // Filter multi-part Usenet posts
  const unsupportedTitles: string[] = [];
  const results = allResults.filter((r) => {
    if (r.protocol !== 'usenet') return true;
    const sourceTitle = r.rawTitle ?? r.title;
    const multiPart = isMultiPartUsenetPost(sourceTitle);
    if (multiPart.match && multiPart.total! > 1) {
      unsupportedTitles.push(sourceTitle);
      return false;
    }
    return true;
  });

  const filteredResults = await filterBlacklistedResults(results, blacklistService);

  // Enrich Usenet results with language from newsgroup metadata
  await enrichUsenetLanguages(filteredResults, logger);

  // Quality filtering and ranking
  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const inputCount = filteredResults.length;
  const ranked = filterAndRankResults(filteredResults, bookDuration, {
    grabFloor: qualitySettings.grabFloor,
    minSeeders: qualitySettings.minSeeders,
    protocolPreference: qualitySettings.protocolPreference,
    rejectWords: qualitySettings.rejectWords,
    requiredWords: qualitySettings.requiredWords,
    languages: metadataSettings.languages,
    maxDownloadSize: qualitySettings.maxDownloadSize,
  });
  if (ranked.results.length < inputCount) logger.debug({ inputCount, outputCount: ranked.results.length }, 'Quality gate filtering applied');

  return {
    results: ranked.results,
    durationUnknown: ranked.durationUnknown,
    unsupportedResults: { count: unsupportedTitles.length, titles: unsupportedTitles },
  };
}

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string }
  | { result: 'grab_error'; error: unknown };

/** Attempt to grab the best result and return the search outcome. */
async function tryGrab(
  best: SearchResult,
  book: { id: number; title: string },
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
): Promise<SingleBookSearchResult> {
  try {
    await downloadOrchestrator.grab(
      buildGrabPayload(best, book.id, { guid: best.guid }),
    );
    log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
    return { result: 'grabbed', title: best.title };
  } catch (grabError: unknown) {
    if (grabError instanceof DuplicateDownloadError) {
      log.debug({ bookId: book.id, title: book.title }, 'Skipping grab — book already has active download');
      return { result: 'skipped', reason: 'already_has_active_download' };
    }
    return { result: 'grab_error', error: grabError };
  }
}

async function searchWithBroadcaster(
  book: { id: number; title: string; duration?: number | null; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  qualitySettings: SearchFilterOptions,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  broadcaster: EventBroadcasterService,
): Promise<SingleBookSearchResult> {
  const query = buildSearchQuery(book);
  const enabledIndexers = await indexerService.getEnabledIndexers();
  safeEmit(broadcaster, 'search_started', {
    book_id: book.id, book_title: book.title,
    indexers: enabledIndexers.map(i => ({ id: i.id, name: i.name })),
  }, log);

  const controllers = new Map<number, AbortController>();
  for (const indexer of enabledIndexers) {
    controllers.set(indexer.id, new AbortController());
  }

  let totalResults = 0;
  const rawResults = await indexerService.searchAllStreaming(
    query,
    { title: book.title, author: book.authors?.[0]?.name },
    controllers,
    {
      onComplete: (indexerId, name, resultCount, elapsedMs) => {
        totalResults += resultCount;
        safeEmit(broadcaster, 'search_indexer_complete', {
          book_id: book.id, indexer_id: indexerId, indexer_name: name,
          results_found: resultCount, elapsed_ms: elapsedMs,
        }, log);
      },
      onError: (indexerId, name, error, elapsedMs) => {
        safeEmit(broadcaster, 'search_indexer_error', {
          book_id: book.id, indexer_id: indexerId, indexer_name: name,
          error, elapsed_ms: elapsedMs,
        }, log);
      },
    },
  );

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'no_results' }, log);
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService);
  if (afterBlacklist.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'All results blacklisted');
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'no_results' }, log);
    return { result: 'no_results' };
  }

  await enrichUsenetLanguages(afterBlacklist, log);

  const broadcasterInputCount = afterBlacklist.length;
  const { results } = filterAndRankResults(afterBlacklist, book.duration ?? undefined, qualitySettings);
  if (results.length < broadcasterInputCount) log.debug({ inputCount: broadcasterInputCount, outputCount: results.length }, 'Quality gate filtering applied');

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'no_results' }, log);
    return { result: 'no_results' };
  }

  const grabResult = await tryGrab(best, book, downloadOrchestrator, log);
  if (grabResult.result === 'grabbed') {
    const indexerName = enabledIndexers.find(i => i.id === best.indexerId)?.name ?? best.indexer ?? 'unknown';
    safeEmit(broadcaster, 'search_grabbed', { book_id: book.id, release_title: best.title, indexer_name: indexerName }, log);
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'grabbed' }, log);
  } else if (grabResult.result === 'skipped') {
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'skipped' }, log);
  } else if (grabResult.result === 'grab_error') {
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'grab_error' }, log);
  } else {
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'no_results' }, log);
  }
  return grabResult;
}

/**
 * Search indexers for a single book and auto-grab the best result.
 * Core search-and-grab logic shared by all callers (jobs, routes).
 */
export async function searchAndGrabForBook(
  book: { id: number; title: string; duration?: number | null; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  indexerService: IndexerService,
  downloadOrchestrator: DownloadOrchestrator,
  qualitySettings: SearchFilterOptions,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  broadcaster?: EventBroadcasterService,
): Promise<SingleBookSearchResult> {
  if (broadcaster) {
    return searchWithBroadcaster(book, indexerService, downloadOrchestrator, qualitySettings, log, blacklistService, broadcaster);
  }

  const query = buildSearchQuery(book);
  const rawResults = await indexerService.searchAll(query, {
    title: book.title,
    author: book.authors?.[0]?.name,
  });

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService);
  if (afterBlacklist.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'All results blacklisted');
    return { result: 'no_results' };
  }

  await enrichUsenetLanguages(afterBlacklist, log);

  const grabInputCount = afterBlacklist.length;
  const { results } = filterAndRankResults(afterBlacklist, book.duration ?? undefined, qualitySettings);
  if (results.length < grabInputCount) log.debug({ inputCount: grabInputCount, outputCount: results.length }, 'Quality gate filtering applied');

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    return { result: 'no_results' };
  }

  return tryGrab(best, book, downloadOrchestrator, log);
}
