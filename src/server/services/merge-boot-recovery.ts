/**
 * Boot-time settlement for merges interrupted by a process death (#2099).
 *
 * A merge is not job-table-backed, so a SIGSEGV/SIGTERM mid-merge leaves exactly two durable
 * traces: a dangling `merge_started` row with no terminal twin, and an orphaned
 * `.<Book>.merge-tmp` staging dir hidden from every scanner by the dotpath rule. Nothing
 * noticed either before this module — the operator's only signal was "wasn't this merging
 * earlier?". The import-job system has had the equivalent recovery since #1663.
 *
 * The pass is deliberately SPLIT in two so `startRuntime` can put the import queue worker's
 * start between them (D7):
 *   • {@link settleInterruptedMerges} — detect, classify, clean, settle. Runs BEFORE the worker
 *     starts, when the process provably has no merge producer of any kind (the HTTP route is
 *     not listening yet either), so no live merge's staging dir can be deleted underneath it.
 *   • {@link requeueRecoveredMerges} — re-enqueue the eligible books, then log the single
 *     summary line. Runs AFTER the worker start resolves, because `executeMerge` calls the same
 *     `.import-commit-pending` recovery the worker's marker sweep performs — issuing re-queues
 *     earlier would put two actors on one marker.
 *
 * Best-effort and preservation-preserving throughout, mirroring `sweepCommitPendingMarkers`:
 * a per-candidate failure before settlement leaves that candidate entirely untouched (dangling
 * event intact, staging dir intact) so the next boot re-detects it, logs a WARN naming it, and
 * the loop continues.
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

/**
 * What the on-disk staging dir proves about where the crash landed (D3).
 *
 * `pre-commit` is the only classification that licenses an automatic re-merge: `commitMerge`
 * deletes nothing until after its `rename()`, so audio still sitting in staging proves every
 * original is intact in `book.path`. The other two are indistinguishable from a state where
 * `book.path` already holds the merged output alongside surviving originals — re-merging
 * that produces an output with duplicated audio, which is the one real corruption this
 * feature could otherwise cause.
 */
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
  /** Detection-query row count. */
  candidates: number;
  /** Staging dirs successfully removed. */
  cleaned: number;
  /** Candidates that got their terminal `merge_failed` row. */
  settled: number;
  /** Candidates left entirely untouched for the next boot (transient failures). */
  retryable: number;
  /** Candidates that errored at or after settlement — plus phase 2's unexpected enqueue failures. */
  failed: number;
}

/**
 * Phase 1's output, carried across the import-worker barrier by `startRuntime`.
 *
 * `requeued` is deliberately NOT a counter here: phase 1 cannot know it. Phase 2 mints it,
 * folds its own unexpected enqueue failures into `failed`, and owns the single summary line —
 * it is the only point holding both phases' outcomes.
 */
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
 * Every book whose most recent merge-family event is `merge_started`, ordered by `id`.
 *
 * Ordering is by `book_events.id`, NEVER `created_at`: that column defaults to `(unixepoch())`
 * — one-second resolution — and `EventHistoryService.create()` never sets it explicitly, so a
 * merge that started and failed inside the same second produces two rows with an identical
 * timestamp. Ordering by `created_at` could then pick `merge_started` as "latest" for a merge
 * that settled correctly, and recovery would file a spurious second failure. `id` is
 * `INTEGER PRIMARY KEY AUTOINCREMENT` (monotonic, never reused) and the emitters issue their
 * inserts in wall-clock order on a single serialized connection.
 *
 * Rows with `book_id IS NULL` (the book was deleted — the FK is `ON DELETE SET NULL`) are not
 * candidates: there is no book to settle or re-merge.
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

/**
 * Classify the derived staging path (D3). ENOENT is `no-staging`, not a failure; any other
 * `readdir` error propagates to the per-candidate catch as a transient skip.
 *
 * Deliberately does NOT filter on `isHiddenName`: the staging dir's own contents are not
 * dot-led, but a half-written encode temp is, and it should still count as audio.
 */
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

/**
 * Resolve the library root, or `null` when it cannot be established (pass-level skip).
 *
 * Deliberately does NOT log: D6 gives the pass-level skip exactly ONE warn whether the settings
 * read threw or simply yielded an empty path, so the caller owns the single record and this
 * helper hands it the cause to attach. Logging here too would double-report one failure.
 */
async function resolveLibraryRoot(deps: SettleInterruptedMergesDeps): Promise<{ root: string | null; error?: unknown }> {
  try {
    const library = await deps.settingsService.get('library');
    return { root: library?.path || null };
  } catch (error: unknown) {
    return { root: null, error };
  }
}

/**
 * Outcome of one candidate's per-book work, folded into the plan by the caller.
 *
 * `cleaned` rides on BOTH terminal kinds because the counters it feeds are step counters, not a
 * partition of `candidates` (D6): a staging dir that was really deleted stays counted even when
 * the settlement insert that followed it failed. Only `retryable` is a candidate-level outcome,
 * and it is the one kind that carries no `cleaned` — by definition nothing was removed.
 */
type CandidateOutcome =
  | { kind: 'settled'; cleaned: boolean; requeue: boolean }
  | { kind: 'retryable' }
  | { kind: 'failed'; cleaned: boolean };

/**
 * Write the terminal `merge_failed` row. Settlement is TERMINAL FOR DETECTION — once this row
 * exists, {@link findInterruptedMergeCandidates} no longer sees the book — so everything that
 * must happen for this candidate has already happened by the time it is called.
 */
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

/**
 * Settle a candidate that has nothing left to clean, mapping a rejected insert to `failed`.
 * `cleaned` is carried through to the failure outcome too — the step already landed.
 */
async function settleOnly(
  deps: SettleInterruptedMergesDeps,
  candidate: InterruptedMergeCandidate,
  cleaned: boolean,
  requeue: boolean,
): Promise<CandidateOutcome> {
  try {
    await settleCandidate(deps, candidate);
  } catch (error: unknown) {
    // Post-clean failure: the staging dir is already gone, so this is not retryable in the same
    // shape. The next boot classifies the same candidate as `no-staging` and settles it then,
    // forfeiting only the re-queue.
    deps.log.warn(
      { error: serializeError(error), bookId: candidate.bookId },
      'Merge boot recovery: could not record the merge_failed settlement — the dangling event survives for the next boot',
    );
    return { kind: 'failed', cleaned };
  }
  return { kind: 'settled', cleaned, requeue };
}

/**
 * Remove the staging dir behind the SYMLINK-AWARE containment guard.
 *
 * `assertPathInsideLibrary` compares normalized lexical paths only. This path is derived from
 * DB-owned `book.path` and feeds a recursive delete — precisely the case
 * `assertRealPathInsideLibrary` documents itself for. With `/library/Author` symlinked to
 * `/external/Author`, the lexical check on `/library/Author/.Book.merge-tmp` passes while
 * `rm -rf` would resolve through the symlink and delete outside the library.
 *
 * The NON-strict variant is correct here: its strict twin propagates a `realpath` ENOENT so a
 * serve-time opener can classify "vanished" as missing, whereas a staging dir that disappears
 * between classification and cleanup needs no error at all — the swallow-and-return leaves the
 * `force: true` `rm` as a harmless no-op instead of wedging the candidate into a permanent retry.
 *
 * Returns `'cleaned'`, `'outside'` (permanent — settle without cleaning) or `'retry'` (transient).
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
      // A containment miss does not heal on the next boot, so retrying forever would just hide
      // the dangling event. Settle it, but never act on the foreign path.
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

/**
 * Per-candidate order: classify → clean → settle → (eligible for) re-queue (D4).
 *
 * Cleanup precedes settlement because settlement is terminal for detection: anything not
 * finished before that insert can never be retried. A failure at classify or clean therefore
 * leaves the candidate wholly untouched — no settlement, dangling event intact, orphan still
 * on disk — and the next boot re-attempts it.
 *
 * Source files in `book.path` are never touched on any branch.
 */
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

  // No row, or no path: permanent. There is nothing to derive a staging path from and nothing
  // to re-merge, but the dangling event must still be settled or it dangles forever.
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
    // Absence does not prove the commit ran — it also covers a crash between the durable start
    // event and `mkdir`. The two are indistinguishable on disk and the first means the book is
    // already merged, so the conservative no-re-queue action covers both readings.
    return settleOnly(deps, candidate, false, false);
  }

  const cleanResult = await cleanStagingDir(deps, candidate, stagingDir, libraryRoot, bookPath);
  if (cleanResult === 'retry') return { kind: 'retryable' };
  if (cleanResult === 'outside') return settleOnly(deps, candidate, false, false);

  if (classification === 'ambiguous') {
    // Either the crash landed inside the commit window (output renamed out, originals partly
    // unlinked, staging not yet removed) or in the microsecond gap between `mkdir` and the
    // first `cp`. Indistinguishable — and the first reading means `book.path` may hold the
    // merged output PLUS surviving originals, so an automatic re-merge would duplicate audio.
    deps.log.warn(
      { bookId: candidate.bookId, bookPath },
      'Merge boot recovery: interrupted merge left an audio-free staging dir — cannot prove the commit did not run, so no automatic re-merge; inspect the book folder',
    );
    return settleOnly(deps, candidate, true, false);
  }

  // pre-commit: every original is provably intact in book.path. Re-queue unattended merges only
  // — a manual merge settles failed-with-reason and waits for the operator.
  return settleOnly(deps, candidate, true, candidate.source === 'auto');
}

/**
 * Phase 1 (D7 step 1): detect, classify, clean and settle every interrupted merge, returning
 * the plan phase 2 completes. Resolves rather than rejecting on a per-candidate failure.
 *
 * MUST run before `importQueueWorker.start()`: that call activates an untracked drain before
 * its promise resolves, a drained import reaches `maybeEnqueueAutoMerge`, and recovery placed
 * after it could observe a LIVE merge's `merge_started` as a dangling candidate and delete the
 * staging dir out from under it.
 */
export async function settleInterruptedMerges(deps: SettleInterruptedMergesDeps): Promise<MergeRecoveryPlan> {
  const counters: MergeRecoveryCounters = { candidates: 0, cleaned: 0, settled: 0, retryable: 0, failed: 0 };
  const requeue: number[] = [];

  // Resolved FIRST, before detection: every destructive op below is containment-guarded against
  // this root, so without it none of them may run. A pass-level skip settles nothing and reports
  // all-zero counters — the whole pass retries on the next boot.
  const resolved = await resolveLibraryRoot(deps);
  if (!resolved.root) {
    // EXACTLY one warn for the pass-level skip, whether the read threw or the path was empty
    // (D6's first taxonomy row covers both with a single record). One call site is what enforces
    // it — the cause rides along as `error` when there was one.
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
    // `cleaned` is a STEP counter: a staging dir that was really removed stays counted even when
    // the settlement that followed it failed (D6 — the counters do not partition `candidates`).
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

/**
 * Phase 2 (D7 step 3): re-enqueue the eligible books, then emit the single per-boot summary.
 *
 * Runs AFTER `importQueueWorker.start()` resolves — `enqueueMerge` starts `executeMerge` on the
 * event loop and that calls the same `.import-commit-pending` recovery the worker's marker sweep
 * performs, and the sweep documents itself as the single recovery actor per marker.
 *
 * Exactly one summary line on normal completion (at `debug` when there were no candidates,
 * mirroring the marker sweep's quiet no-op path), never two, and none if this throws before
 * reaching it — in which case `startRuntime`'s caught `error` log is the sole record.
 */
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
        // Expected: the book is no longer eligible, or another producer already queued it.
        // The settlement is already durable, so the outcome stays visible either way.
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
