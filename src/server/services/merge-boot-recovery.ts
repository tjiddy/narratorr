/**
 * Recover merges left with a dangling merge_started event and orphan staging directory after process death.
 * Settle before worker startup so no live merge can race cleanup; requeue afterward to avoid competing on import markers.
 * Any pre-settlement candidate failure preserves both durable traces for the next boot.
 */
import { readdir, rm } from 'node:fs/promises';
import { extname } from 'node:path';
import { and, eq, inArray, isNotNull, max } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { bookEvents } from '@db/schema.js';
import { AUDIO_EXTENSIONS } from '@core/utils/audio-constants.js';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
import type { EventType, EventSource } from '@shared/schemas/event-history.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { MergeService } from './merge.service.js';
import { MergeError } from './merge.service.js';
import { assertRealPathInsideLibrary, PathOutsideLibraryError } from '../utils/paths.js';
import { serializeError } from '../utils/serialize-error.js';

/** The merge lifecycle family. A book's latest row among these decides candidacy (D1). */
const MERGE_EVENT_TYPES: EventType[] = ['merge_started', 'merged', 'merge_failed'];

/** The settlement reason. `error` is required — `ErrorDetails` renders it and falls back to a raw dump without it. */
const PROCESS_RESTART_REASON = { error: 'Interrupted by server restart', type: 'ProcessRestart' } as const;

// Only pre-commit proves every original remains intact; re-merging either ambiguous class could duplicate audio.
export type MergeStagingClass = 'pre-commit' | 'ambiguous' | 'no-staging';

/** A book whose most recent merge-family event is a dangling `merge_started`. */
export interface InterruptedMergeCandidate {
  bookId: number;
  /** The dangling `merge_started` row's id — the `MAX(id)` that made this book a candidate. */
  eventId: number;
  /** Provenance copied onto the settlement, and the re-queue gate ('auto' only). */
  source: EventSource;
  bookTitle: string;
}

export interface MergeRecoveryCounters {
  candidates: number;
  cleaned: number;
  settled: number;
  /** Candidates left entirely untouched for the next boot (transient failures). */
  retryable: number;
  /** Candidates that errored at or after settlement — plus phase 2's unexpected enqueue failures. */
  failed: number;
}

// Phase 1 carries counters and eligible IDs across worker startup; phase 2 adds requeue outcomes and owns the summary.
export interface MergeRecoveryPlan {
  /** bookIds eligible for re-queue: `pre-commit` classification AND `source === 'auto'`. */
  requeue: number[];
  counters: MergeRecoveryCounters;
}

export interface SettleInterruptedMergesDeps {
  db: Db;
  log: FastifyBaseLogger;
  eventHistory: Pick<EventHistoryService, 'create'>;
  bookService: Pick<BookService, 'getById'>;
  settingsService: Pick<SettingsService, 'get'>;
}

/**
 * Find books whose latest merge-family row by AUTOINCREMENT id is merge_started; createdAt has only one-second resolution.
 * Exclude null book ids left by ON DELETE SET NULL.
 */
export async function findInterruptedMergeCandidates(db: Db): Promise<InterruptedMergeCandidate[]> {
  const latest = db
    .select({ bookId: bookEvents.bookId, lastId: max(bookEvents.id).as('last_id') })
    .from(bookEvents)
    .where(and(inArray(bookEvents.eventType, MERGE_EVENT_TYPES), isNotNull(bookEvents.bookId)))
    .groupBy(bookEvents.bookId)
    .as('latest_merge_event');

  const rows = await db
    .select({
      bookId: bookEvents.bookId,
      eventId: bookEvents.id,
      source: bookEvents.source,
      bookTitle: bookEvents.bookTitle,
    })
    .from(bookEvents)
    .innerJoin(latest, eq(bookEvents.id, latest.lastId))
    .where(eq(bookEvents.eventType, 'merge_started'));

  return rows.map((row) => ({
    bookId: row.bookId as number, // the grouped select already excluded NULL book ids
    eventId: row.eventId,
    source: row.source,
    bookTitle: row.bookTitle,
  }));
}

// ENOENT means no staging; other read errors retry. Hidden encode temps still count as audio evidence.
export async function classifyStagingDir(stagingDir: string): Promise<MergeStagingClass> {
  let entries: string[];
  try {
    entries = await readdir(stagingDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'no-staging';
    throw error;
  }
  return entries.some((entry) => AUDIO_EXTENSIONS.has(extname(entry).toLowerCase()))
    ? 'pre-commit'
    : 'ambiguous';
}

// Return the cause without logging so the caller emits exactly one pass-level warning.
async function resolveLibraryRoot(deps: SettleInterruptedMergesDeps): Promise<{ root: string | null; error?: unknown }> {
  try {
    const library = await deps.settingsService.get('library');
    return { root: library?.path || null };
  } catch (error: unknown) {
    return { root: null, error };
  }
}

// cleaned is an independent step counter, so terminal settlement failure must not erase successful cleanup.
type CandidateOutcome =
  | { kind: 'settled'; cleaned: boolean; requeue: boolean }
  | { kind: 'retryable' }
  | { kind: 'failed'; cleaned: boolean };

// Settlement ends detection permanently, so every retryable action must precede this write.
async function settleCandidate(
  deps: SettleInterruptedMergesDeps,
  candidate: InterruptedMergeCandidate,
): Promise<void> {
  await deps.eventHistory.create({
    bookId: candidate.bookId,
    bookTitle: candidate.bookTitle,
    eventType: 'merge_failed',
    source: candidate.source,
    reason: { ...PROCESS_RESTART_REASON },
  });
}

async function settleOnly(
  deps: SettleInterruptedMergesDeps,
  candidate: InterruptedMergeCandidate,
  cleaned: boolean,
  requeue: boolean,
): Promise<CandidateOutcome> {
  try {
    await settleCandidate(deps, candidate);
  } catch (error: unknown) {
    // Next boot sees no staging and retries settlement, but automatic requeue eligibility is lost.
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId },
      'Merge boot recovery: could not record the merge_failed settlement — the dangling event survives for the next boot',
    );
    return { kind: 'failed', cleaned };
  }
  return { kind: 'settled', cleaned, requeue };
}

/**
 * Guard recursive deletion with real-path containment so symlinked book paths cannot escape the library.
 * Use the non-strict guard because staging may vanish between classification and force-removal without needing a retry.
 */
async function cleanStagingDir(
  deps: SettleInterruptedMergesDeps,
  candidate: InterruptedMergeCandidate,
  stagingDir: string,
  libraryRoot: string,
  bookPath: string,
): Promise<'cleaned' | 'outside' | 'retry'> {
  try {
    await assertRealPathInsideLibrary(stagingDir, libraryRoot);
  } catch (error: unknown) {
    if (error instanceof PathOutsideLibraryError) {
      // Containment misses are permanent: settle without ever touching the foreign path.
      deps.log.warn(
        { bookId: candidate.bookId, bookPath, stagingDir, libraryRoot },
        'Merge boot recovery: staging path escapes the library root — settling without cleanup, not acting on a foreign path',
      );
      return 'outside';
    }
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId, stagingDir },
      'Merge boot recovery: could not canonicalize the staging path — leaving the candidate untouched for the next boot',
    );
    return 'retry';
  }

  try {
    await rm(stagingDir, { recursive: true, force: true });
  } catch (error: unknown) {
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId, bookPath, stagingDir },
      'Merge boot recovery: could not remove the orphaned staging dir — leaving the candidate untouched for the next boot',
    );
    return 'retry';
  }
  return 'cleaned';
}

// Classify and clean before terminal settlement; failures before settlement preserve the candidate for retry.
// No branch touches source files in book.path.
async function recoverCandidate(
  deps: SettleInterruptedMergesDeps,
  candidate: InterruptedMergeCandidate,
  libraryRoot: string,
): Promise<CandidateOutcome> {
  let book: Awaited<ReturnType<BookService['getById']>>;
  try {
    book = await deps.bookService.getById(candidate.bookId);
  } catch (error: unknown) {
    // The book row's existence is unknown, so settling would file a terminal event on a guess.
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId },
      'Merge boot recovery: could not read the book — leaving the candidate untouched for the next boot',
    );
    return { kind: 'retryable' };
  }

  // Missing book/path cannot be retried or remerged, but still requires terminal settlement.
  if (!book?.path) return settleOnly(deps, candidate, false, false);

  const bookPath = book.path;
  const stagingDir = dotPrefixBasename(bookPath + '.merge-tmp');

  let classification: MergeStagingClass;
  try {
    classification = await classifyStagingDir(stagingDir);
  } catch (error: unknown) {
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId, stagingDir },
      'Merge boot recovery: could not classify the staging path — leaving the candidate untouched for the next boot',
    );
    return { kind: 'retryable' };
  }

  if (classification === 'no-staging') {
    // No staging cannot distinguish post-commit from pre-mkdir crash, so never requeue automatically.
    return settleOnly(deps, candidate, false, false);
  }

  const cleanResult = await cleanStagingDir(deps, candidate, stagingDir, libraryRoot, bookPath);
  if (cleanResult === 'retry') return { kind: 'retryable' };
  if (cleanResult === 'outside') return settleOnly(deps, candidate, false, false);

  if (classification === 'ambiguous') {
    // Audio-free staging can mean partial commit or pre-copy crash; automatic remerge could duplicate audio.
    deps.log.warn(
      { bookId: candidate.bookId, bookPath },
      'Merge boot recovery: interrupted merge left an audio-free staging dir — cannot prove the commit did not run, so no automatic re-merge; inspect the book folder',
    );
    return settleOnly(deps, candidate, true, false);
  }

  // Only proven pre-commit auto merges requeue; manual merges wait for the operator.
  return settleOnly(deps, candidate, true, candidate.source === 'auto');
}

// Phase 1 must precede importQueueWorker.start(), whose drain can launch a live auto-merge before start resolves.
// Per-candidate failures resolve into the returned recovery plan.
export async function settleInterruptedMerges(deps: SettleInterruptedMergesDeps): Promise<MergeRecoveryPlan> {
  const counters: MergeRecoveryCounters = { candidates: 0, cleaned: 0, settled: 0, retryable: 0, failed: 0 };
  const requeue: number[] = [];

  // Resolve containment root before detection; without it, perform no destructive or settlement work.
  const resolved = await resolveLibraryRoot(deps);
  if (!resolved.root) {
    // One call site guarantees exactly one warning for either read failure or empty path.
    deps.log.warn(
      resolved.error !== undefined ? { error: serializeError(resolved.error) } : {},
      'Merge boot recovery: no library root resolved — skipping merge recovery this boot',
    );
    return { requeue, counters };
  }
  const libraryRoot = resolved.root;

  const candidates = await findInterruptedMergeCandidates(deps.db);
  counters.candidates = candidates.length;

  for (const candidate of candidates) {
    const outcome = await recoverCandidate(deps, candidate, libraryRoot);
    if (outcome.kind === 'retryable') {
      counters.retryable++;
      continue;
    }
    // cleaned counts landed cleanup even when subsequent settlement failed.
    if (outcome.cleaned) counters.cleaned++;
    if (outcome.kind === 'failed') {
      counters.failed++;
      continue;
    }
    counters.settled++;
    if (outcome.requeue) requeue.push(candidate.bookId);
  }

  return { requeue, counters };
}

// Phase 2 follows worker startup so marker recovery has one actor, then emits the sole normal-completion summary.
// No-candidate summaries use debug; unexpected pre-summary failure is logged only by startRuntime.
export async function requeueRecoveredMerges(
  mergeService: Pick<MergeService, 'enqueueMerge'>,
  plan: MergeRecoveryPlan,
  log: FastifyBaseLogger,
): Promise<void> {
  let requeued = 0;
  let failed = plan.counters.failed;

  for (const bookId of plan.requeue) {
    try {
      await mergeService.enqueueMerge(bookId, 'auto');
      requeued++;
    } catch (error: unknown) {
      if (error instanceof MergeError) {
        // Ineligibility or an existing queue entry is expected after durable settlement.
        log.info({ bookId, code: error.code }, 'Merge boot recovery: recovered merge was not re-queued');
        continue;
      }
      log.warn({ error: serializeError(error), bookId }, 'Merge boot recovery: unexpected failure re-queueing a recovered merge');
      failed++;
    }
  }

  const summary = { ...plan.counters, requeued, failed };
  if (plan.counters.candidates === 0) {
    log.debug(summary, 'Merge boot recovery complete');
  } else {
    log.info(summary, 'Merge boot recovery complete');
  }
}
