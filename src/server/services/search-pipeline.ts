import type { FastifyBaseLogger } from 'fastify';
import { calculateQuality, filterByLanguage, filterMultiPartUsenet, resolveBookQualityInputs } from '@core/utils/index.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import { canonicalCompare, type NarratorPriority } from './search-ranking.js';
export type { NarratorPriority } from './search-ranking.js';
import { AUTO_GRAB_PHASE2_CAP, enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import type { SearchResult } from '@core/index.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import { DuplicateDownloadError } from './download-errors.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { recordGrabBlockedUnsatisfiedEvent, recordGrabFailedEvent, recordSearchRelaxedHeldEvent } from '../utils/download-side-effects.js';
import { type LadderRun } from './search-query-ladder.js';
import { applyUnsatisfiedLimitGate } from './unsatisfied-limit-gate.js';
import { runBookQueryLadder } from './search-ladder-execution.js';
import { withSearchDeadline, SearchDeadlineError } from './search-deadline.js';
import type { SearchLadderCooldown } from './search-ladder-cooldown.js';
import { type SearchBook, type SearchEventSink, NOOP_SINK, createBroadcasterSink } from './search-event-sink.js';
import { ensureError } from '../utils/ensure-error.js';
import { buildGrabPayload } from './grab-payload.js';
import { parseWordList, matchesWord } from '@shared/parse-word-list.js';
import { BYTES_PER_GB, BYTES_PER_MB } from '@shared/constants.js';
import type { SearchDropReason, SearchDropSummary } from '@shared/schemas/search-stream.js';
import { summarizeDrops, withBlacklistDrops, describeEmptiedSet, describeBlacklistEmptiedSet, BLACKLIST_EMPTIED_MESSAGE, type SearchDropCounts } from './search-drop-summary.js';
/** Compatibility re-export; the ladder imports indexer-query directly to avoid a cycle. */
export { buildSearchQuery } from './indexer-query.js';

export function buildNarratorPriority(
  searchPriority: string,
  bookNarrators?: Array<{ name: string }> | null,
): NarratorPriority | undefined {
  if (searchPriority !== 'accuracy') return undefined;
  const names = bookNarrators?.map(n => n.name).filter(Boolean) ?? [];
  if (names.length === 0) return undefined;
  return { bookNarrators: names };
}

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

type GateVerdict = { keep: true } | { keep: false; logFields?: Record<string, unknown> };

type Gate = {
  reason: SearchDropReason;
  enabled: boolean;
  evaluate: (r: SearchResult) => GateVerdict;
};

// Exclude ebook-only results but retain mixed formats. Do not use \b: underscore is a JS word
// character, so it misses scene names such as Dune_EPUB.
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
        // Ebook and audio markers may be split across title fields.
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
        return { keep: false, logFields: { sizeBytes: r.size, minBytes, ...(r.rawSize !== undefined && { rawSize: r.rawSize }) } };
      },
    },
    {
      reason: 'over-max-size',
      enabled: maxBytes > 0,
      evaluate: (r) => {
        if (!r.size || r.size <= 0) return { keep: true };
        if (r.size <= maxBytes) return { keep: true };
        return { keep: false, logFields: { sizeBytes: r.size, maxBytes, ...(r.rawSize !== undefined && { rawSize: r.rawSize }) } };
      },
    },
  ];
}

/** bookDurationSeconds is seconds; callers holding books.duration must normalize its minutes first. */
export function filterAndRankResults(
  results: SearchResult[],
  bookDurationSeconds: number | undefined,
  options: SearchFilterOptions,
  log?: FastifyBaseLogger,
): { results: SearchResult[]; durationUnknown: boolean; dropSummary: SearchDropSummary } {
  const { protocolPreference, languages, narratorPriority } = options;
  const durationUnknown = !bookDurationSeconds || bookDurationSeconds <= 0;

  // Gates run sequentially over the survivors, so each drop is attributed to the first gate that saw it.
  const dropCounts: SearchDropCounts = {};
  const gates = buildQualityGates(bookDurationSeconds, durationUnknown, options);
  let filtered = results;
  for (const gate of gates) {
    if (!gate.enabled) continue;
    filtered = filtered.filter((r) => {
      const verdict = gate.evaluate(r);
      if (verdict.keep) return true;
      dropCounts[gate.reason] = (dropCounts[gate.reason] ?? 0) + 1;
      log?.debug({ title: r.title, ...verdict.logFields, dropped: true, reason: gate.reason }, 'Quality filter dropped result');
      return false;
    });
  }

  const langs = languages ?? [];
  const langPartition = filterByLanguage(filtered, langs);
  if (langPartition.dropped.length > 0) dropCounts['language-mismatch'] = langPartition.dropped.length;
  if (log) {
    for (const r of langPartition.dropped) {
      log.debug({ title: r.title, detectedLanguage: r.language, allowedLanguages: langs, dropped: true, reason: 'language-mismatch' }, 'Language filter dropped result');
    }
    for (const r of langPartition.passedUndetermined) {
      log.debug({ title: r.title, allowedLanguages: langs, dropped: false, reason: 'language-undetermined' }, 'Language filter passed undetected result');
    }
  }
  filtered = langPartition.kept;

  filtered.sort((a, b) => canonicalCompare(a, b, bookDurationSeconds, durationUnknown, protocolPreference, langs, narratorPriority));

  return { results: filtered, durationUnknown, dropSummary: summarizeDrops(dropCounts, options) };
}

/** Shared settings mapper; omit narratorPriority rather than assigning undefined. */
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
 * Shared post-enrichment multipart→rank step for display, auto-grab, retry, and RSS; every path
 * must call it to stay converged. bookDurationSeconds is seconds, not the DB column's minutes.
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
  dropSummary: SearchDropSummary;
} {
  const { filtered, rejectedTitles } = filterMultiPartUsenet(results);
  for (const r of rejectedTitles) {
    // Keep multipart rejection forensics at info because they can make a book unobtainable.
    log?.info({ title: r.title, reason: 'multi-part-detected', matchedPattern: r.matchedPattern }, 'Multi-part Usenet result rejected');
  }

  const inputCount = filtered.length;
  const ranked = filterAndRankResults(filtered, bookDurationSeconds, options, log);
  if (ranked.results.length < inputCount) {
    log?.debug({ inputCount, outputCount: ranked.results.length }, 'Quality gate filtering applied');
  }
  // The one signal every search surface shares: results existed, and the operator sees none of them.
  if (inputCount > 0 && ranked.results.length === 0) {
    log?.info(describeEmptiedSet(ranked.dropSummary, inputCount), 'All search results removed by quality filters');
  }

  return { results: ranked.results, durationUnknown: ranked.durationUnknown, multipartRejections: rejectedTitles, dropSummary: ranked.dropSummary };
}

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

/** Shared JSON/SSE pipeline; IndexerService must reach enrichment to permit configured private indexers. */
export async function postProcessSearchResults(
  allResults: SearchResult[],
  bookDuration: number | undefined,
  blacklistService: BlacklistService,
  settingsService: SettingsService,
  indexerService: IndexerService,
  logger: FastifyBaseLogger,
  signal?: AbortSignal | undefined,
): Promise<{
  results: SearchResult[];
  durationUnknown: boolean;
  unsupportedResults: { count: number; titles: string[] };
  filteredOut?: SearchDropSummary | undefined;
}> {
  const filteredResults = await filterBlacklistedResults(allResults, blacklistService, logger);
  // The blacklist gate keeps its signature; a length delta is exact and costs nothing.
  const blacklistedCount = allResults.length - filteredResults.length;

  // Forward the configured private-indexer allowlist; this interactive path intentionally has no phase-2 cap.
  // The signal spread stays conditional: a signal-less caller must still make the three-argument
  // call #1330 pins, and the abort is the only thing bounding a tail that grows with the result count.
  const lanAllowlist = await indexerService.getLanAllowlist();
  await enrichUsenetLanguages(filteredResults, logger, lanAllowlist, ...(signal !== undefined ? [{ signal }] : []));

  const qualitySettings = await settingsService.get('quality');
  const metadataSettings = await settingsService.get('metadata');
  const filterOptions = buildSearchFilterOptions(qualitySettings, metadataSettings);
  const { results, durationUnknown, multipartRejections, dropSummary } = applyMultiPartFilterAndRank(
    filteredResults,
    bookDuration,
    filterOptions,
    logger,
  );
  const filteredOut = withBlacklistDrops(dropSummary, blacklistedCount, filterOptions);

  // Preserve the legacy titles-only API; matchedPattern remains internal.
  const unsupportedTitles = multipartRejections.map((r) => r.title);
  return {
    results,
    durationUnknown,
    unsupportedResults: { count: unsupportedTitles.length, titles: unsupportedTitles },
    // Omitted when nothing was dropped, so every caller sees the same absence — including v1, which ignores it.
    ...(filteredOut.total > 0 && { filteredOut }),
  };
}

export type SingleBookSearchResult =
  | { result: 'grabbed'; title: string }
  | { result: 'no_results' }
  | { result: 'skipped'; reason: string }
  | { result: 'grab_error'; error: Error };

async function tryGrab(
  best: SearchResult,
  book: { id: number; title: string },
  downloadOrchestrator: DownloadOrchestrator,
  log: FastifyBaseLogger,
): Promise<Exclude<SingleBookSearchResult, { result: 'no_results' }>> {
  try {
    await downloadOrchestrator.grab(
      buildGrabPayload(best, book.id),
    );
    log.info({ bookId: book.id, title: best.title, seeders: best.seeders }, 'Auto-grabbed best result');
    return { result: 'grabbed', title: best.title };
  } catch (grabError: unknown) {
    if (grabError instanceof DuplicateDownloadError) {
      log.debug({ bookId: book.id, title: book.title }, 'Skipping grab — book already has a blocking download or import');
      return { result: 'skipped', reason: 'grab_blocked' };
    }
    return { result: 'grab_error', error: ensureError(grabError) };
  }
}

export interface SearchAndGrabDeps {
  indexerSearchService: IndexerSearchService;
  downloadOrchestrator: DownloadOrchestrator;
  qualitySettings: SearchFilterOptions;
  log: FastifyBaseLogger;
  blacklistService: BlacklistService;
  indexerService: IndexerService;
  eventHistory: EventHistoryService;
  broadcaster?: EventBroadcasterService | undefined;
  searchLadderCooldown?: SearchLadderCooldown | undefined;
  /** Scheduled honors/records cooldown; always bypasses it. Omission defaults manual/new callers to always. */
  ladderMode?: 'scheduled' | 'always' | undefined;
}

/** Shared streaming/aggregate gate→enrich→rank→grab core; the sink alone controls events. */
async function runSearchAndGrab(
  book: SearchBook,
  deps: SearchAndGrabDeps,
  sink: SearchEventSink,
  ran: LadderRun,
): Promise<SingleBookSearchResult> {
  const { downloadOrchestrator, qualitySettings, log, blacklistService, indexerService, eventHistory } = deps;

  const rawResults = ran.results;

  if (rawResults.length === 0) {
    log.debug({ bookId: book.id, title: book.title }, 'No results found');
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }

  log.info({ bookId: book.id, title: book.title, resultCount: rawResults.length }, 'Search results found');

  const afterBlacklist = await filterBlacklistedResults(rawResults, blacklistService, log);
  if (afterBlacklist.length === 0) {
    log.info({ bookId: book.id, title: book.title, ...describeBlacklistEmptiedSet(rawResults.length, rawResults.length) }, BLACKLIST_EMPTIED_MESSAGE);
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }

  // No signal, per #2310 AC8: the cap fixes this tail at two waves whatever the candidate count, and
  // `withSearchDeadline` has already released the caller, so there is nobody left waiting on it.
  await enrichUsenetLanguages(afterBlacklist, log, await indexerService.getLanAllowlist(), { maxPhase2Fetches: AUTO_GRAB_PHASE2_CAP });

  // books.duration is minutes; the quality chain requires seconds or its MB/hour floor is inert.
  const { durationSeconds } = resolveBookQualityInputs(book);
  const { results } = applyMultiPartFilterAndRank(afterBlacklist, durationSeconds ?? undefined, qualitySettings, log);

  // Share relaxed-rung selection with retrySearch so floor policy cannot drift.
  const gate = applyUnsatisfiedLimitGate(results, ran.rung);
  if (gate.kind === 'blocked') {
    recordGrabBlockedUnsatisfiedEvent({ book, eventHistory, log, release: gate.result });
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }
  const selection = gate.selection;
  if (selection.kind === 'hold') {
    recordSearchRelaxedHeldEvent({
      book, eventHistory, log,
      relaxedQuery: ran.rung.query,
      variantTag: ran.rung.variant?.tag ?? 'full',
      releaseTitle: selection.releaseTitle,
    });
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }
  if (selection.kind === 'none') {
    sink.searchComplete('no_results');
    return { result: 'no_results' };
  }
  const best = selection.result;

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
 * Shared auto-grab entry; broadcaster changes events, not the core. The query ladder advances
 * only on answered zero, then the gate chain runs once on the winning rung.
 */
export async function searchAndGrabForBook(
  book: SearchBook,
  deps: SearchAndGrabDeps,
): Promise<SingleBookSearchResult> {
  const { indexerSearchService, broadcaster, log } = deps;
  // Constructed before the raced body — a plain object with no I/O — so expiry can still reach it.
  const sink = broadcaster ? createBroadcasterSink(book, broadcaster, log) : NOOP_SINK;
  const outcome = await withSearchDeadline({ budgetMs: SEARCH_DEADLINE_MS, bookId: book.id, log }, async (signal) => {
    const ran = await runBookQueryLadder(book, {
      indexerSearchService, sink, signal, log, streaming: broadcaster !== undefined,
      searchLadderCooldown: deps.searchLadderCooldown, ladderMode: deps.ladderMode ?? 'always',
    });
    return runSearchAndGrab(book, deps, sink, ran);
  }).catch((error: unknown) => {
    // The client only removes a card on grabbed/complete, so an expiry must still say so.
    if (error instanceof SearchDeadlineError) sink.searchComplete('timed_out');
    throw error;
  });
  if (!outcome) log.info({ bookId: book.id, title: book.title }, 'Search skipped — this book already has one in flight');
  return outcome ?? { result: 'skipped', reason: 'search_already_in_flight' };
}
