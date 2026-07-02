import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, filterByLanguage, filterMultiPartUsenet, resolveBookQualityInputs } from '../../core/utils/index.js';
import { canonicalCompare, type NarratorPriority } from './search-ranking.js';
export type { NarratorPriority } from './search-ranking.js';
import { AUTO_GRAB_PHASE2_CAP, enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import type { SearchResult } from '../../core/index.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download-errors.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { recordGrabFailedEvent } from '../utils/download-side-effects.js';
import { type SearchBook, type SearchEventSink, NOOP_SINK, createBroadcasterSink } from './search-event-sink.js';
import { ensureError } from '../utils/ensure-error.js';
import { buildGrabPayload } from './grab-payload.js';
import { parseWordList, matchesWord } from '../../shared/parse-word-list.js';
import { BYTES_PER_GB, BYTES_PER_MB } from '../../shared/constants.js';
import { cleanIndexerQuery } from './indexer-query.js';

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
  minDownloadSize?: number | undefined;
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
  bookDurationSeconds: number | undefined,
  durationUnknown: boolean,
  options: SearchFilterOptions,
): Gate[] {
  const { grabFloor, minSeeders, rejectWords, requiredWords, minDownloadSize, maxDownloadSize } = options;
  const rejectList = parseWordList(rejectWords);
  const requiredList = parseWordList(requiredWords);
  const minBytes = minDownloadSize && minDownloadSize > 0 ? minDownloadSize * BYTES_PER_MB : 0;
  const maxBytes = maxDownloadSize && maxDownloadSize > 0 ? maxDownloadSize * BYTES_PER_GB : 0;

  return [
    {
      reason: 'reject-word-match',
      enabled: rejectList.length > 0,
      evaluate: (r) => {
        const surfaces = [r.nzbName, r.rawTitle, r.title, r.author, r.narrator].filter(Boolean) as string[];
        for (const surface of surfaces) {
          const matched = rejectList.find((word) => matchesWord(surface, word));
          if (matched) return { keep: false, logFields: { matchedWord: matched } };
        }
        return { keep: true };
      },
    },
    {
      reason: 'required-word-missing',
      enabled: requiredList.length > 0,
      evaluate: (r) => {
        const surfaces = [r.nzbName, r.rawTitle, r.title, r.author, r.narrator].filter(Boolean) as string[];
        return requiredList.some((word) => surfaces.some((s) => matchesWord(s, word))) ? { keep: true } : { keep: false };
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
        const quality = calculateQuality(r.size, bookDurationSeconds!);
        if (!quality) return { keep: true };
        if (quality.mbPerHour >= grabFloor) return { keep: true };
        return { keep: false, logFields: { mbPerHour: quality.mbPerHour, grabFloor } };
      },
    },
    {
      reason: 'below-min-size',
      enabled: minBytes > 0,
      evaluate: (r) => {
        if (!r.size || r.size <= 0) return { keep: true };
        if (r.size >= minBytes) return { keep: true };
        return { keep: false, logFields: { sizeBytes: r.size, minBytes } };
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
 * grab-floor → min-size → max-size. Language partitioning runs after the gate array
 * because it emits two log branches (mismatch dropped + undetermined passed)
 * that don't fit the keep/drop shape.
 *
 * When `log` is provided, emits a debug log per dropped result at each gate
 * and the critical "language-undetermined passed" line for results that
 * survive solely because we couldn't detect a language.
 *
 * `bookDurationSeconds` is the book's duration in SECONDS (the MB/hr grab floor
 * and quality tiers are seconds-based). Callers holding the minutes-backed
 * `books.duration` column must convert via `resolveBookQualityInputs` first.
 */
export function filterAndRankResults(
  results: SearchResult[],
  bookDurationSeconds: number | undefined,
  options: SearchFilterOptions,
  log?: FastifyBaseLogger,
): { results: SearchResult[]; durationUnknown: boolean } {
  const { protocolPreference, languages, narratorPriority } = options;
  const durationUnknown = !bookDurationSeconds || bookDurationSeconds <= 0;

  const gates = buildQualityGates(bookDurationSeconds, durationUnknown, options);
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
  filtered.sort((a, b) => canonicalCompare(a, b, bookDurationSeconds, durationUnknown, protocolPreference, langs, narratorPriority));

  return { results: filtered, durationUnknown };
}

/**
 * Build a {@link SearchFilterOptions} from raw quality + metadata settings, the
 * single home for the field-by-field mapping that used to be copied into
 * display, retry, RSS, and the 4 `searchAndGrabForBook` callers. `narratorPriority`
 * is optional (retry and RSS pass it; the display path does not) and is omitted
 * from the result when undefined so `exactOptionalPropertyTypes` stays happy.
 */
export function buildSearchFilterOptions(
  quality: {
    grabFloor: number;
    minSeeders: number;
    protocolPreference: string;
    rejectWords: string;
    requiredWords: string;
    minDownloadSize: number;
    maxDownloadSize: number;
  },
  metadata: { languages?: readonly string[] | undefined },
  opts?: { narratorPriority?: NarratorPriority | undefined },
): SearchFilterOptions {
  return {
    grabFloor: quality.grabFloor,
    minSeeders: quality.minSeeders,
    protocolPreference: quality.protocolPreference,
    rejectWords: quality.rejectWords,
    requiredWords: quality.requiredWords,
    languages: metadata.languages,
    minDownloadSize: quality.minDownloadSize,
    maxDownloadSize: quality.maxDownloadSize,
    ...(opts?.narratorPriority !== undefined && { narratorPriority: opts.narratorPriority }),
  };
}

/**
 * Shared post-enrichment `multipart → rank` sub-chain, the single owner of the
 * step that display and RSS applied but auto-grab and retry historically dropped
 * (#1777). Runs {@link filterMultiPartUsenet} → emits one `multi-part-detected`
 * debug log per drop → runs {@link filterAndRankResults} → emits the quality-gate
 * debug log when the count shrinks, and returns the ranked results plus the
 * multipart rejections. `durationUnknown` is passed straight through from
 * {@link filterAndRankResults} so the display path can keep exposing it on the
 * SSE `search-complete` surface; the grab paths continue to ignore it.
 *
 * Every path (display, auto-grab, retry, RSS) is expected to call this after its
 * own enrichment step so a future post-enrichment step lands on all four at once.
 * This is a convention, not a construction: nothing in the type system forces a
 * new path to route through here, so keeping all four converged still requires
 * reviewer discipline — the shared helper only guarantees the paths that already
 * call it stay in lockstep (this is what caused #1777, and the same shape let the
 * duration-unit divergence fixed in #1797 slip in).
 *
 * `bookDurationSeconds` is the book's duration in SECONDS. The grab/retry/RSS
 * callers hold the minutes-backed `books.duration` column and MUST normalize via
 * `resolveBookQualityInputs` before calling; the display path already sends
 * seconds from the client.
 */
export function applyMultiPartFilterAndRank(
  results: SearchResult[],
  bookDurationSeconds: number | undefined,
  options: SearchFilterOptions,
  log?: FastifyBaseLogger,
): {
  results: SearchResult[];
  durationUnknown: boolean;
  multipartRejections: Array<{ title: string; matchedPattern: string }>;
} {
  const { filtered, rejectedTitles } = filterMultiPartUsenet(results);
  for (const r of rejectedTitles) {
    log?.debug({ title: r.title, reason: 'multi-part-detected', matchedPattern: r.matchedPattern }, 'Multi-part Usenet result rejected');
  }

  const inputCount = filtered.length;
  const ranked = filterAndRankResults(filtered, bookDurationSeconds, options, log);
  if (ranked.results.length < inputCount) {
    log?.debug({ inputCount, outputCount: ranked.results.length }, 'Quality gate filtering applied');
  }

  return { results: ranked.results, durationUnknown: ranked.durationUnknown, multipartRejections: rejectedTitles };
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
 *
 * `indexerService` is required (not optional) so any caller that omits it fails
 * TypeScript — the LAN allowlist for NZB-body fetches (#1149) must reach the
 * leaf, and a missed wrapper would silently degrade enrichment back to the
 * pre-fix "SSRF refuses Prowlarr-on-LAN" behavior.
 */
export async function postProcessSearchResults(
  allResults: SearchResult[],
  bookDuration: number | undefined,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
  indexerService: IndexerService,
  logger: FastifyBaseLogger,
): Promise<{
  results: SearchResult[];
  durationUnknown: boolean;
  unsupportedResults: { count: number; titles: string[] };
}> {
  const filteredResults = await filterBlacklistedResults(allResults, blacklistService, logger);

  // Enrich Usenet results with language from newsgroup metadata. Forwarding
  // the LAN allowlist lets the NZB fetch reach a configured-indexer host:port
  // even at a private IP (#1149). This interactive/post-process display path
  // stays uncapped (omit maxPhase2Fetches) so enrichment is unaffected; it
  // still benefits from the shared enrichment cache (#1315).
  const lanAllowlist = await indexerService.getLanAllowlist();
  await enrichUsenetLanguages(filteredResults, logger, lanAllowlist);

  // Multi-part filter + quality ranking (shared post-enrichment sub-chain, #1777).
  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const { results, durationUnknown, multipartRejections } = applyMultiPartFilterAndRank(
    filteredResults,
    bookDuration,
    buildSearchFilterOptions(qualitySettings, metadataSettings),
    logger,
  );

  // Preserve the legacy `unsupportedResults: { count, titles }` API surface — extract
  // titles only; matchedPattern stays internal to logging.
  const unsupportedTitles = multipartRejections.map((r) => r.title);
  return {
    results,
    durationUnknown,
    unsupportedResults: { count: unsupportedTitles.length, titles: unsupportedTitles },
  };
}

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string }
  | { result: 'grab_error'; error: Error };

/**
 * Attempt to grab the best result and return the search outcome. The return type
 * excludes `no_results` — `tryGrab` is only reached once a grabbable result has
 * been selected, so it can only resolve to grabbed/skipped/grab_error. Narrowing
 * here keeps the outcome chain in {@link runSearchAndGrab} statically aligned with
 * the three branches it actually handles (#1330, type-only — no behavior change).
 */
async function tryGrab(
  best: SearchResult,
  book: { id: number; title: string },
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
): Promise<Exclude<SingleBookSearchResult, { result: 'no_results' }>> {
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

/**
 * Dependency bag for {@link searchAndGrabForBook} — collapses the former
 * 9-positional-parameter signature. `indexerService` is required so the LAN
 * allowlist (#1149) threads to the enrichment leaf at every caller; `broadcaster`
 * is optional — present selects the streaming/SSE path, absent the no-op path.
 */
export interface SearchAndGrabDeps {
  indexerSearchService: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  qualitySettings: SearchFilterOptions;
  log: FastifyBaseLogger;
  blacklistService: BlacklistService;
  indexerService: IndexerService;
  eventHistory: EventHistoryService;
  broadcaster?: EventBroadcasterService | undefined;
}

/**
 * Streaming search executor for the broadcaster path: emits `search_started`,
 * sets up per-indexer abort controllers, and forwards per-indexer completion /
 * error callbacks into the sink (streaming-only events stay off the other path).
 */
async function streamingSearch(
  query: string,
  book: SearchBook,
  indexerSearchService: IndexerSearchService,
  sink: SearchEventSink,
): Promise<SearchResult[]> {
  const enabledIndexers = await indexerSearchService.getEnabledIndexers();
  sink.searchStarted(enabledIndexers);

  const controllers = new Map<number, AbortController>();
  for (const indexer of enabledIndexers) {
    controllers.set(indexer.id, new AbortController());
  }

  return indexerSearchService.searchAllStreaming(
    query,
    { title: book.title, author: book.authors?.[0]?.name },
    controllers,
    {
      onComplete: (indexerId, name, resultCount, elapsedMs) => sink.indexerComplete(indexerId, name, resultCount, elapsedMs),
      onError: (indexerId, name, error, elapsedMs) => sink.indexerError(indexerId, name, error, elapsedMs),
    },
  );
}

/**
 * Single search→gate→enrich→rank→grab pipeline shared by the streaming and
 * non-streaming entry points. The `searchExecutor` injects the search call
 * (streaming vs aggregate) and the `sink` injects event emission; everything
 * between — blacklist gate, Usenet language enrichment (LAN allowlist #1149 +
 * `AUTO_GRAB_PHASE2_CAP` #1315), quality ranking, best-result selection, grab,
 * and single-record grab-failure handling (#1157) — is identical on both paths.
 */
async function runSearchAndGrab(
  book: SearchBook,
  deps: SearchAndGrabDeps,
  sink: SearchEventSink,
  searchExecutor: () => Promise<SearchResult[]>,
): Promise<SingleBookSearchResult> {
  const { downloadOrchestrator, qualitySettings, log, blacklistService, indexerService, eventHistory } = deps;

  const rawResults = await searchExecutor();

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService, log);
  if (afterBlacklist.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'All results blacklisted');
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }

  await enrichUsenetLanguages(afterBlacklist, log, await indexerService.getLanAllowlist(), { maxPhase2Fetches: AUTO_GRAB_PHASE2_CAP });

  // book.duration is MINUTES; normalize to seconds (audioDuration ?? duration*60)
  // before the seconds-based quality chain, or the MB/hr floor is inert (#1797).
  const { durationSeconds } = resolveBookQualityInputs(book);
  const { results } = applyMultiPartFilterAndRank(afterBlacklist, durationSeconds ?? undefined, qualitySettings, log);

  const best = results.find((r) => r.downloadUrl);
  if (!best) {
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }

  const grabResult = await tryGrab(best, book, downloadOrchestrator, log);
  if (grabResult.result === 'grabbed') {
    sink.grabbed(best);
    sink.searchComplete('grabbed');
  } else if (grabResult.result === 'skipped') {
    sink.searchComplete('skipped');
  } else if (grabResult.result === 'grab_error') {
    sink.grabError(grabResult.error, best.title);
    const errorMessage = grabResult.error.message || 'Unknown grab error';
    recordGrabFailedEvent({ book, releaseTitle: best.title, errorMessage, eventHistory, log });
  }
  return grabResult;
}

/**
 * Search indexers for a single book and auto-grab the best result.
 * Core search-and-grab logic shared by all callers (jobs, routes).
 *
 * Pass `deps.broadcaster` to drive the streaming/SSE path (per-indexer events
 * plus `search_complete`); omit it for the silent non-streaming path. Both paths
 * run the identical {@link runSearchAndGrab} core, differing only in the injected
 * search call and event sink.
 */
export async function searchAndGrabForBook(
  book: SearchBook,
  deps: SearchAndGrabDeps,
): Promise<SingleBookSearchResult> {
  const { indexerSearchService, broadcaster, log } = deps;
  const query = buildSearchQuery(book);

  if (broadcaster) {
    const sink = createBroadcasterSink(book, broadcaster, log);
    return runSearchAndGrab(book, deps, sink, () => streamingSearch(query, book, indexerSearchService, sink));
  }

  return runSearchAndGrab(book, deps, NOOP_SINK, () =>
    indexerSearchService.searchAll(query, { title: book.title, author: book.authors?.[0]?.name }),
  );
}
