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
import { describeBlacklistEmptiedSet, BLACKLIST_EMPTIED_MESSAGE } from './search-drop-summary.js';
import { buildQueryLadder, runQueryLadder, type LadderRun } from './search-query-ladder.js';
import { applyUnsatisfiedLimitGate } from './unsatisfied-limit-gate.js';
import { createAggregateExecutor } from './search-ladder-execution.js';
import { NOOP_SINK } from './search-event-sink.js';
import type { SearchResult } from '@core/index.js';
import { recordGrabBlockedUnsatisfiedEvent, recordSearchRelaxedHeldEvent } from '../utils/download-side-effects.js';
import { resolveBookQualityInputs } from '@core/utils/index.js';
import { buildGrabPayload } from './grab-payload.js';
import { AUTO_GRAB_PHASE2_CAP, enrichUsenetLanguages } from '../utils/enrich-usenet-languages.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


export type RetryOutcome =
  | { outcome: 'retried'; download: DownloadWithBook }
  | { outcome: 'exhausted' }
  | { outcome: 'no_candidates' }
  // A live download, gate-eligible completion, or pending auto import already serves the book.
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
  /** Records why the independent retry ladder holds a segment-cut candidate. */
  eventHistory: EventHistoryService;
  log: FastifyBaseLogger;
}

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

/** Share relaxed candidate selection with auto-grab and record a segment-cut hold before returning none. */
function resolveRetryCandidate(
  results: SearchResult[],
  ran: LadderRun,
  book: { id: number; title: string; authors?: Array<{ name: string }> | null; narrators?: Array<{ name: string }> | null },
  deps: Pick<RetrySearchDeps, 'eventHistory' | 'log'>,
  attempt: number,
): { best: SearchResult } | { outcome: RetryOutcome } {
  const { eventHistory, log } = deps;
  const gate = applyUnsatisfiedLimitGate(results, ran.rung);

  // No new RetryOutcome variant: the blocked disposition is the same no_candidates the segment-cut
  // hold already returns, with the attempt consumed. The AC8 event carries the real reason.
  if (gate.kind === 'blocked') {
    recordGrabBlockedUnsatisfiedEvent({ book, eventHistory, log, attempt, release: gate.result });
    return { outcome: { outcome: 'no_candidates' } };
  }

  const selection = gate.selection;
  if (selection.kind === 'hold') {
    recordSearchRelaxedHeldEvent({
      book, eventHistory, log, attempt,
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

/** Shared search→filter→rank→grab retry for monitor failures, manual retry, and mark-failed. */
export async function retrySearch(
  bookId: number,
  deps: RetrySearchDeps,
): Promise<RetryOutcome> {
  const { indexerSearchService, indexerService, downloadOrchestrator, blacklistService, bookService, settingsService, retryBudget, eventHistory, log } = deps;

  if (!retryBudget.hasRemaining(bookId)) {
    return { outcome: 'exhausted' };
  }

  // Check imported state before consuming budget; imported books require manual Search Releases.
  const book = await bookService.getById(bookId);
  if (!book) {
    return { outcome: 'retry_error', error: 'Book not found' };
  }
  if (book.path !== null) {
    log.debug({ bookId, title: book.title }, 'Retry search skipped — book is imported');
    return { outcome: 'no_candidates' };
  }

  // Avoid spending budget on an existing blocker; grabForRetry rechecks under lock after network search.
  if (await downloadOrchestrator.hasGrabBlocker(bookId)) {
    log.debug({ bookId, title: book.title }, 'Retry search skipped — book already has a grab blocker (early)');
    return { outcome: 'already_active' };
  }

  const attempt = retryBudget.consumeAttempt(bookId);

  try {
    // Retry runs the full ladder without scheduled cooldown; the whole ladder costs one budget attempt.
    const ladder = buildQueryLadder({ title: book.title, author: book.authors?.[0]?.name });
    const ran = await runQueryLadder(ladder, createAggregateExecutor(book, indexerSearchService, NOOP_SINK, log));
    const rawResults = ran.results;

    if (rawResults.length === 0) {
      log.debug({ bookId, title: book.title }, 'Retry search returned no results');
      return { outcome: 'no_candidates' };
    }

    const filteredResults = await filterBlacklistedResults(rawResults, blacklistService, log);
    // Report, don't return: the path still falls through to ranking so its own no-candidate line fires.
    if (filteredResults.length === 0) {
      log.info({ bookId, title: book.title, attempt, ...describeBlacklistEmptiedSet(rawResults.length, rawResults.length) }, BLACKLIST_EMPTIED_MESSAGE);
    }

    // Permit configured private indexers and cap auto-grab phase-2 NZB fetches.
    await enrichUsenetLanguages(filteredResults, log, await indexerService.getLanAllowlist(), { maxPhase2Fetches: AUTO_GRAB_PHASE2_CAP });

    const qualitySettings = await settingsService.get('quality');
    const metadataSettings = await settingsService.get('metadata');
    const searchSettings = await settingsService.get('search');
    const narratorPriority = buildNarratorPriority(searchSettings.searchPriority, book.narrators);
    // books.duration is minutes; the quality chain requires seconds or its MB/hour floor is inert.
    const { durationSeconds } = resolveBookQualityInputs(book);
    const { results } = applyMultiPartFilterAndRank(
      filteredResults,
      durationSeconds ?? undefined,
      buildSearchFilterOptions(qualitySettings, metadataSettings, { narratorPriority }),
      log,
    );

    // Share floor policy with the auto-grab selector.
    const candidate = resolveRetryCandidate(results, ran, book, { eventHistory, log }, attempt);
    if ('outcome' in candidate) return candidate.outcome;
    const best = candidate.best;

    // grabForRetry acquires the book mutex and rechecks blockers. Because this payload bypasses
    // the normal duplicate guard, that in-lock check is what prevents sequential duplicates.
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
