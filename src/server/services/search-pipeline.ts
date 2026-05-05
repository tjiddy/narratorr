import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, filterByLanguage, filterMultiPartUsenet } from '../../core/utils/index.js';
import { canonicalCompare, type NarratorPriority } from './search-ranking.js';
export type { NarratorPriority } from './search-ranking.js';
import { enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import type { SearchResult } from '../../core/index.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';
import { ensureError } from '../utils/ensure-error.js';
import { buildGrabPayload } from './grab-payload.js';
import { parseWordList } from '../../shared/parse-word-list.js';
import { BYTES_PER_GB } from '../../shared/constants.js';

/**
 * Strip punctuation that fragments indexer Torznab queries while preserving
 * inner words and letters. Replaces parens/brackets/braces/dots/colons/
 * semicolons/commas with spaces, then collapses whitespace. Indexers tokenize
 * the same characters on their side, so dropping them client-side does not
 * lose matches and prevents zero-result queries from titles like
 * `Blood Ties (World of Warcraft: Midnight)` or authors like `M. O. Walsh`.
 *
 * Distinct from `cleanName` in `folder-parsing.ts` — that strips trailing
 * parens *and their content* for narrator annotations during library import.
 * This cleaner is for indexer-query construction only.
 */
function cleanIndexerQuery(s: string): string {
  return s
    .replace(/[()[\]{}.:;,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a search query string from a book's title and primary author. */
export function buildSearchQuery(book: { title: string; authors?: Array<{ name: string }> | null }): string {
  const raw = [book.title, book.authors?.[0]?.name].filter(Boolean).join(' ');
  return cleanIndexerQuery(raw);
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

/** Aggregated filter/rank options crossing quality, metadata, and computed settings. */
export interface SearchFilterOptions {
  grabFloor: number;
  minSeeders: number;
  protocolPreference: string;
  rejectWords?: string | undefined;
  requiredWords?: string | undefined;
  languages?: readonly string[] | undefined;
  narratorPriority?: NarratorPriority | undefined;
  maxDownloadSize?: number | undefined;
}

/**
 * Per-gate verdict: `keep: true` passes the result through, `keep: false`
 * drops it and contributes `logFields` to the per-drop debug log payload.
 */
type GateVerdict = { keep: true } | { keep: false; logFields?: Record<string, unknown> };

/**
 * A single quality-filter gate. `enabled: false` short-circuits — the gate's
 * evaluator is never called, so disabled gates pay nothing per result and
 * cannot accidentally log under their `reason`. Each gate's evaluator is a
 * closure that captures only its own per-gate values (e.g., `maxBytes` for
 * over-max-size, the per-result `mbPerHour` for grab-floor) so disabled-gate
 * inputs cannot leak into other gates' log payloads.
 */
type Gate = {
  reason: string;
  enabled: boolean;
  evaluate: (r: SearchResult) => GateVerdict;
};

// Ebook-only format detection: exclude results that contain ebook keywords
// (AZW3, EPUB, PDF, MOBI) but no audio keywords (M4B, MP3, FLAC, AAC, OGG).
// Mixed-format results are kept. Use lookahead/lookbehind instead of \b because
// JS treats _ as a word char, which would miss scene-style titles like "Dune_EPUB".
const EBOOK_FORMAT_RE = /(?<![a-zA-Z\d])(azw3|epub|pdf|mobi)(?![a-zA-Z\d])/i;
const AUDIO_FORMAT_RE = /(?<![a-zA-Z\d])(m4b|mp3|flac|aac|ogg)(?![a-zA-Z\d])/i;

function buildQualityGates(
  bookDuration: number | undefined,
  durationUnknown: boolean,
  options: SearchFilterOptions,
): Gate[] {
  const { grabFloor, minSeeders, rejectWords, requiredWords, maxDownloadSize } = options;
  const rejectList = parseWordList(rejectWords);
  const requiredList = parseWordList(requiredWords);
  const maxBytes = maxDownloadSize && maxDownloadSize > 0 ? maxDownloadSize * BYTES_PER_GB : 0;

  return [
    {
      reason: 'reject-word-match',
      enabled: rejectList.length > 0,
      evaluate: (r) => {
        const sourceTitle = (r.nzbName || r.rawTitle || r.title).toLowerCase();
        const matched = rejectList.find((word) => sourceTitle.includes(word));
        return matched ? { keep: false, logFields: { matchedWord: matched } } : { keep: true };
      },
    },
    {
      reason: 'required-word-missing',
      enabled: requiredList.length > 0,
      evaluate: (r) => {
        const sourceTitle = (r.nzbName || r.rawTitle || r.title).toLowerCase();
        return requiredList.some((word) => sourceTitle.includes(word)) ? { keep: true } : { keep: false };
      },
    },
    {
      reason: 'ebook-only-format',
      enabled: true,
      evaluate: (r) => {
        const sourceTitle = r.nzbName || r.rawTitle || r.title;
        if (!EBOOK_FORMAT_RE.test(sourceTitle)) return { keep: true };
        // Check all available title fields for audio keywords — ebook and audio markers
        // may be split across fields (e.g., nzbName=EPUB, rawTitle=MP3).
        if ([r.nzbName, r.rawTitle, r.title].some((t) => t && AUDIO_FORMAT_RE.test(t))) return { keep: true };
        return { keep: false };
      },
    },
    {
      reason: 'below-min-seeders',
      enabled: minSeeders > 0,
      evaluate: (r) => {
        if (r.protocol !== 'torrent') return { keep: true };
        if (r.seeders === undefined || r.seeders === null) return { keep: true }; // Unknown ≠ zero
        if (r.seeders >= minSeeders) return { keep: true };
        return { keep: false, logFields: { seeders: r.seeders, minSeeders } };
      },
    },
    {
      reason: 'below-grab-floor',
      enabled: !durationUnknown && grabFloor > 0,
      evaluate: (r) => {
        if (!r.size || r.size <= 0) return { keep: true };
        const quality = calculateQuality(r.size, bookDuration!);
        if (!quality) return { keep: true };
        if (quality.mbPerHour >= grabFloor) return { keep: true };
        return { keep: false, logFields: { mbPerHour: quality.mbPerHour, grabFloor } };
      },
    },
    {
      reason: 'over-max-size',
      enabled: maxBytes > 0,
      evaluate: (r) => {
        if (!r.size || r.size <= 0) return { keep: true };
        if (r.size <= maxBytes) return { keep: true };
        return { keep: false, logFields: { sizeBytes: r.size, maxBytes } };
      },
    },
  ];
}

/**
 * Apply quality filtering and canonical ranking to search results.
 * Filters by word lists, MB/hr grab floor, and min seeders, then sorts by
 * canonical order: matchScore gate → narrator match → MB/hr → protocol preference → language → indexer priority → grabs → seeders.
 *
 * Quality gates run sequentially (gate N sees the output of gate N-1) in
 * canonical order: reject-word → required-word → ebook-only → min-seeders →
 * grab-floor → max-size. Language partitioning runs after the gate array
 * because it emits two log branches (mismatch dropped + undetermined passed)
 * that don't fit the keep/drop shape.
 *
 * When `log` is provided, emits a debug log per dropped result at each gate
 * and the critical "language-undetermined passed" line for results that
 * survive solely because we couldn't detect a language.
 */
export function filterAndRankResults(
  results: SearchResult[],
  bookDuration: number | undefined,
  options: SearchFilterOptions,
  log?: FastifyBaseLogger,
): { results: SearchResult[]; durationUnknown: boolean } {
  const { protocolPreference, languages, narratorPriority } = options;
  const durationUnknown = !bookDuration || bookDuration <= 0;

  const gates = buildQualityGates(bookDuration, durationUnknown, options);
  let filtered = results;
  for (const gate of gates) {
    if (!gate.enabled) continue;
    filtered = filtered.filter((r) => {
      const verdict = gate.evaluate(r);
      if (verdict.keep) return true;
      log?.debug({ title: r.title, ...verdict.logFields, dropped: true, reason: gate.reason }, 'Quality filter dropped result');
      return false;
    });
  }

  // Language filtering: exclude results with explicit non-matching language
  const langs = languages ?? [];
  const langPartition = filterByLanguage(filtered, langs);
  if (log) {
    for (const r of langPartition.dropped) {
      log.debug({ title: r.title, detectedLanguage: r.language, allowedLanguages: langs, dropped: true, reason: 'language-mismatch' }, 'Language filter dropped result');
    }
    for (const r of langPartition.passedUndetermined) {
      log.debug({ title: r.title, allowedLanguages: langs, dropped: false, reason: 'language-undetermined' }, 'Language filter passed undetected result');
    }
  }
  filtered = langPartition.kept;

  // Canonical ranking
  filtered.sort((a, b) => canonicalCompare(a, b, bookDuration, durationUnknown, protocolPreference, langs, narratorPriority));

  return { results: filtered, durationUnknown };
}

/**
 * Filter out blacklisted releases by infoHash and/or guid.
 * Skips the blacklist lookup entirely when no identifiers are present.
 *
 * When `log` is provided, every dropped result emits a debug log line so
 * operators can see why a candidate was rejected by the blacklist gate.
 */
export async function filterBlacklistedResults(
  results: SearchResult[],
  blacklistService: BlacklistService,
  log?: FastifyBaseLogger,
): Promise<SearchResult[]> {
  const hashes = results.map(r => r.infoHash).filter((h): h is string => !!h);
  const guids = results.map(r => r.guid).filter((g): g is string => !!g);
  if (hashes.length === 0 && guids.length === 0) return results;
  const { blacklistedHashes, blacklistedGuids } = await blacklistService.getBlacklistedIdentifiers(hashes, guids);
  return results.filter(r => {
    const hashMatch = r.infoHash ? blacklistedHashes.has(r.infoHash) : false;
    const guidMatch = r.guid ? blacklistedGuids.has(r.guid) : false;
    if (hashMatch || guidMatch) {
      log?.debug({
        title: r.title,
        guid: r.guid,
        indexer: r.indexer,
        reason: 'blacklist-match',
        matchedRule: hashMatch ? 'hash' : 'guid',
      }, 'Blacklisted result dropped');
      return false;
    }
    return true;
  });
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
  const filteredResults = await filterBlacklistedResults(allResults, blacklistService, logger);

  // Enrich Usenet results with language from newsgroup metadata
  await enrichUsenetLanguages(filteredResults, logger);

  // Filter multi-part Usenet posts (after enrichment so nzbName is available)
  const { filtered: results, rejectedTitles: unsupportedRejections } = filterMultiPartUsenet(filteredResults);
  for (const r of unsupportedRejections) {
    logger.debug({ title: r.title, reason: 'multi-part-detected', matchedPattern: r.matchedPattern }, 'Multi-part Usenet result rejected');
  }

  // Quality filtering and ranking
  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const inputCount = results.length;
  const ranked = filterAndRankResults(results, bookDuration, {
    grabFloor: qualitySettings.grabFloor,
    minSeeders: qualitySettings.minSeeders,
    protocolPreference: qualitySettings.protocolPreference,
    rejectWords: qualitySettings.rejectWords,
    requiredWords: qualitySettings.requiredWords,
    languages: metadataSettings.languages,
    maxDownloadSize: qualitySettings.maxDownloadSize,
  }, logger);
  if (ranked.results.length < inputCount) logger.debug({ inputCount, outputCount: ranked.results.length }, 'Quality gate filtering applied');

  // Preserve the legacy `unsupportedResults: { count, titles }` API surface — extract
  // titles only; matchedPattern stays internal to logging.
  const unsupportedTitles = unsupportedRejections.map((r) => r.title);
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
  | { result: 'grab_error'; error: Error };

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
    return { result: 'grab_error', error: ensureError(grabError) };
  }
}

async function searchWithBroadcaster(
  book: { id: number; title: string; duration?: number | null; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  indexerSearchService: IndexerSearchService,
  downloadOrchestrator: DownloadOrchestrator,
  qualitySettings: SearchFilterOptions,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  broadcaster: EventBroadcasterService,
): Promise<SingleBookSearchResult> {
  const query = buildSearchQuery(book);
  const enabledIndexers = await indexerSearchService.getEnabledIndexers();
  safeEmit(broadcaster, 'search_started', {
    book_id: book.id, book_title: book.title,
    indexers: enabledIndexers.map(i => ({ id: i.id, name: i.name })),
  }, log);

  const controllers = new Map<number, AbortController>();
  for (const indexer of enabledIndexers) {
    controllers.set(indexer.id, new AbortController());
  }

  let totalResults = 0;
  const rawResults = await indexerSearchService.searchAllStreaming(
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

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService, log);
  if (afterBlacklist.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'All results blacklisted');
    safeEmit(broadcaster, 'search_complete', { book_id: book.id, total_results: totalResults, outcome: 'no_results' }, log);
    return { result: 'no_results' };
  }

  await enrichUsenetLanguages(afterBlacklist, log);

  const broadcasterInputCount = afterBlacklist.length;
  const { results } = filterAndRankResults(afterBlacklist, book.duration ?? undefined, qualitySettings, log);
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
  indexerSearchService: IndexerSearchService,
  downloadOrchestrator: DownloadOrchestrator,
  qualitySettings: SearchFilterOptions,
  log: FastifyBaseLogger,
  blacklistService: BlacklistService,
  broadcaster?: EventBroadcasterService,
): Promise<SingleBookSearchResult> {
  if (broadcaster) {
    return searchWithBroadcaster(book, indexerSearchService, downloadOrchestrator, qualitySettings, log, blacklistService, broadcaster);
  }

  const query = buildSearchQuery(book);
  const rawResults = await indexerSearchService.searchAll(query, {
    title: book.title,
    author: book.authors?.[0]?.name,
  });

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService, log);
  if (afterBlacklist.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'All results blacklisted');
    return { result: 'no_results' };
  }

  await enrichUsenetLanguages(afterBlacklist, log);

  const grabInputCount = afterBlacklist.length;
  const { results } = filterAndRankResults(afterBlacklist, book.duration ?? undefined, qualitySettings, log);
  if (results.length < grabInputCount) log.debug({ inputCount: grabInputCount, outputCount: results.length }, 'Quality gate filtering applied');

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    return { result: 'no_results' };
  }

  return tryGrab(best, book, downloadOrchestrator, log);
}
