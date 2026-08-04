import type { FastifyBaseLogger } from 'fastify';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { DownloadWithBook } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { RetryBudget } from './retry-budget.js';
import type { EventHistoryService } from './event-history.service.js';
import { buildNarratorPriority, applyMultiPartFilterAndRank, buildSearchFilterOptions, filterBlacklistedResults } from './search-pipeline.js';
import { buildQueryLadder, runQueryLadder, selectRelaxedCandidate, type LadderRun } from './search-query-ladder.js';
import type { SearchResult } from '@core/index.js';
import { recordSearchRelaxedHeldEvent } from '../utils/download-side-effects.js';
import { resolveBookQualityInputs } from '@core/utils/index.js';
import { buildGrabPayload } from './grab-payload.js';
import { AUTO_GRAB_PHASE2_CAP, enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


export type RetryOutcome =
  | { outcome: 'retried'; download: DownloadWithBook }
  | { outcome: 'exhausted' }
  | { outcome: 'no_candidates' }
  // #1857/#1861 — the book already has a grab blocker: a live download (a
  // replacement's winner or a prior retry's grab), a QG-eligible completed row, or a
  // pending auto import job. retrySearch exists to replace a *failed* row, so any
  // such blocker means the book is already served.
  | { outcome: 'already_active' }
  | { outcome: 'retry_error'; error: string };

export interface RetrySearchDeps {
  indexerSearchService: IndexerSearchService;
  indexerService: IndexerService;
  downloadOrchestrator: DownloadOrchestrator;
  blacklistService: BlacklistService;
  bookService: BookService;
  settingsService: SettingsService;
  retryBudget: RetryBudget;
  /**
   * Needed for the query ladder's failed-floor `search_relaxed_held` event
   * (#2104 D9/D14). Retry owns an independent filter/rank/grab chain, so
   * without this dependency it could reach a segment-cut rung and be unable to
   * record why it declined to grab.
   */
  eventHistory: EventHistoryService;
  log: FastifyBaseLogger;
}

/** Factory to build RetrySearchDeps from a Services bag + logger. Eliminates duplication across routes and jobs. */
export function createRetrySearchDeps(services: {
  indexerSearch: IndexerSearchService;
  indexer: IndexerService;
  downloadOrchestrator: DownloadOrchestrator;
  blacklist: BlacklistService;
  book: BookService;
  settings: SettingsService;
  retryBudget: RetryBudget;
  eventHistory: EventHistoryService;
}, log: FastifyBaseLogger): RetrySearchDeps {
  return {
    indexerSearchService: services.indexerSearch,
    indexerService: services.indexer,
    downloadOrchestrator: services.downloadOrchestrator,
    blacklistService: services.blacklist,
    bookService: services.book,
    settingsService: services.settings,
    retryBudget: services.retryBudget,
    eventHistory: services.eventHistory,
    log,
  };
}

/**
 * Resolve the winning rung's ranked results to a grabbable candidate, or to the
 * `no_candidates` outcome — recording the failed-floor held event on the way out
 * when a segment-cut rung had grabbable candidates that none corroborated.
 *
 * Extracted from {@link retrySearch} so both auto-grab paths call the SAME pure
 * {@link selectRelaxedCandidate} and neither exceeds the complexity cap.
 */
function resolveRetryCandidate(
  results: SearchResult[],
  ran: LadderRun,
  book: { id: number; title: string; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  deps: Pick<RetrySearchDeps, 'eventHistory' | 'log'>,
  attempt: number,
): { best: SearchResult } | { outcome: RetryOutcome } {
  const { eventHistory, log } = deps;
  const selection = selectRelaxedCandidate(results, ran.rung);

  if (selection.kind === 'hold') {
    log.info({
      bookId: book.id, title: book.title, attempt,
      relaxedQuery: ran.rung.query, variantTag: ran.rung.variant?.tag, releaseTitle: selection.releaseTitle,
    }, 'Retry search: relaxed-query candidates held for review — none corroborated the retained title segments');
    recordSearchRelaxedHeldEvent({
      book, eventHistory, log,
      relaxedQuery: ran.rung.query,
      variantTag: ran.rung.variant?.tag ?? 'full',
      releaseTitle: selection.releaseTitle,
    });
    return { outcome: { outcome: 'no_candidates' } };
  }
  if (selection.kind === 'none') {
    log.debug({ bookId: book.id, title: book.title, attempt }, 'No viable candidates after filtering');
    return { outcome: { outcome: 'no_candidates' } };
  }
  return { best: selection.result };
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
  const { indexerSearchService, indexerService, downloadOrchestrator, blacklistService, bookService, settingsService, retryBudget, eventHistory, log } = deps;

  // Check retry budget
  if (!retryBudget.hasRemaining(bookId)) {
    return { outcome: 'exhausted' };
  }

  // Look up the book before consuming budget so imported-book guard doesn't
  // burn an attempt (F1, F6). Imported books are never auto-retried — Search
  // Releases is the only path for replacing an imported book, and the user
  // must do it manually.
  const book = await bookService.getById(bookId);
  if (!book) {
    return { outcome: 'retry_error', error: 'Book not found' };
  }
  if (book.path !== null) {
    log.debug({ bookId, title: book.title }, 'Retry search skipped — book is imported');
    return { outcome: 'no_candidates' };
  }

  // Early `already_active` precheck (#1857 F43/F47 / #1861): if the book already
  // has ANY grab blocker (a replacement's winner, a QG-eligible completed row, or a
  // pending auto import job), short-circuit BEFORE consuming a budget attempt — the
  // common case costs nothing, and there is no generation-crossing refund to reason
  // about. The authoritative in-lock recheck (grabForRetry) still catches a blocker
  // that appears during the network search.
  if (await downloadOrchestrator.hasGrabBlocker(bookId)) {
    log.debug({ bookId, title: book.title }, 'Retry search skipped — book already has a grab blocker (early)');
    return { outcome: 'already_active' };
  }

  // Consume an attempt
  const attempt = retryBudget.consumeAttempt(bookId);

  try {
    // Progressive query relaxation (#2104). Retry runs the FULL ladder — it is
    // already bounded by RetryBudget's 3 attempts, so it never consults the
    // scheduled-cycle cooldown (D15) — and the whole ladder costs exactly the ONE
    // attempt consumed above, not one per rung.
    const ladder = buildQueryLadder({ title: book.title, author: book.authors?.[0]?.name });
    const ran = await runQueryLadder(ladder, async (rung) => {
      const { results, succeeded } = await indexerSearchService.searchAllWithStatus(rung.query, {
        title: book.title,
        author: rung.author,
        rankingAuthor: book.authors?.[0]?.name,
      });
      return { results, succeeded };
    });
    const rawResults = ran.results;

    if (rawResults.length === 0) {
      log.debug({ bookId, title: book.title }, 'Retry search returned no results');
      return { outcome: 'no_candidates' };
    }

    const filteredResults = await filterBlacklistedResults(rawResults, blacklistService, log);

    // Enrich Usenet results before filtering. The LAN allowlist lets NZB-body
    // fetches reach a configured-indexer host:port even at a private IP (#1149).
    // Auto-grab path: cap Phase-2 fetches to the top-ranked candidates (#1315).
    await enrichUsenetLanguages(filteredResults, log, await indexerService.getLanAllowlist(), { maxPhase2Fetches: AUTO_GRAB_PHASE2_CAP });

    // Multi-part filter + quality ranking (shared post-enrichment sub-chain, #1777).
    const qualitySettings = await settingsService.get('quality');
    const metadataSettings = await settingsService.get('metadata');
    const searchSettings = await settingsService.get('search');
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
    // book.duration is MINUTES; normalize to seconds before the seconds-based
    // quality chain (audioDuration ?? duration*60) or the MB/hr floor is inert (#1797).
    const { durationSeconds } = resolveBookQualityInputs(book);
    const { results } = applyMultiPartFilterAndRank(
      filteredResults,
      durationSeconds ?? undefined,
      buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
      log,
    );

    // Candidate selection on the winning rung, through the SHARED pure selector
    // the auto-grab pipeline also uses, so the two paths cannot drift on floor
    // policy (#2104 D14). On rung 1 and on a `full` rung it degenerates to the
    // pre-ladder `results.find(r => r.downloadUrl)`.
    const candidate = resolveRetryCandidate(results, ran, book, { eventHistory, log }, attempt);
    if ('outcome' in candidate) return candidate.outcome;
    const best = candidate.best;

    // Grab the best candidate via the retry seam: acquires the per-book admission
    // mutex ONCE and rechecks for ANY grab blocker inside it (#1857 AC17 / #1861 — a
    // live download, a QG-eligible completed row, or a pending auto import job).
    // `skipDuplicateCheck` bypasses the duplicate guard, so the mutex alone would
    // leave two live downloads — the in-lock recheck is what dedups sequentially.
    const grabResult = await downloadOrchestrator.grabForRetry(
      buildGrabPayload(best, book.id, { ...(best.guid !== undefined && { guid: best.guid }), skipDuplicateCheck: true }),
    );
    if (grabResult === 'already_active') {
      log.info({ bookId, attempt }, 'Retry search: book gained a grab blocker during search — skipping (attempt consumed, not refunded)');
      return { outcome: 'already_active' };
    }

    log.info({ bookId, title: best.title, attempt }, 'Retry search grabbed candidate');
    return { outcome: 'retried', download: grabResult };
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    log.warn({ bookId, error: serializeError(error), attempt }, 'Retry search failed');
    return { outcome: 'retry_error', error: message };
  }
}
