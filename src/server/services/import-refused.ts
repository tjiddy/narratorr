import { eq, and } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs, books } from '@db/schema.js';
import type { Db } from '@db/index.js';
import type { PhaseHistoryEntry } from '@shared/schemas/import-job.js';
import type { ForcedImportRefusedReason } from '@shared/schemas/sse-events.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { BookEventRow } from './types.js';
import { withBookAdmissionLock } from './book-admission.js';
import { buildForcedImportRefusedReason, type OwnedRecordingError } from './book.service.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { safeEmit } from '../utils/safe-emit.js';
import { serializeError } from '../utils/serialize-error.js';

export interface RefusedDispositionDeps {
  db: Db;
  broadcaster: EventBroadcasterService | null;
  eventHistory: EventHistoryService | null;
  log: FastifyBaseLogger;
}

export interface RefusedDispositionArgs {
  jobId: number;
  bookId: number | null;
  currentPhase: string;
  bookTitle: string;
  error: OwnedRecordingError;
  phaseHistory?: PhaseHistoryEntry[];
}

interface RefusalCopy {
  refusalReason: ForcedImportRefusedReason;
  errorMessage: string;
}

/** What actually committed, so the post-section code reports without re-reading anything. */
interface RefusalOutcome {
  placeholderRemoved: boolean;
  eventRow: BookEventRow | null;
}

/** The in-lock re-read that decides whether the placeholder is still this job's to delete. */
interface PlaceholderState {
  exists: boolean;
  deletable: boolean;
}

/**
 * Fail a forced import refused by the collision fence. Delete only its importing placeholder;
 * durable FKs become null, while SSE retains the old id so clients can evict the placeholder card.
 *
 * The whole terminal disposition runs under `withBookAdmissionLock(bookId)`, which is
 * **non-reentrant**: no caller may already hold admission for `bookId`. `ImportQueueWorker`'s catch
 * is the sole caller and reaches here only after the adapter's own section has released.
 * `finalizeForcedImportRefusalWithinAdmissionLock` is the unlocked inner half, mirroring
 * `grabWithinAdmissionLock` (`./download-orchestrator.ts`).
 */
export async function finalizeForcedImportRefusal(deps: RefusedDispositionDeps, args: RefusedDispositionArgs): Promise<void> {
  const { broadcaster, eventHistory, log } = deps;
  const { jobId, bookId, currentPhase, bookTitle, error } = args;
  const refusalReason = buildForcedImportRefusedReason(error);
  const errorMessage = refusalReason.existingBookId != null
    ? `force refused: target owned by book #${refusalReason.existingBookId} (${error.reason})`
    : `force refused: target has audio on disk with no identifiable owner (${error.reason})`;

  const run = () => finalizeForcedImportRefusalWithinAdmissionLock(deps, args, { refusalReason, errorMessage });
  const outcome = bookId == null ? await run() : await withBookAdmissionLock(bookId, run);

  // Only reporting leaves the section, and the disposition is already durable by now — so neither
  // half may disturb the caller, which here is the worker's catch block. `safeEmit` encodes that
  // rule for the broadcaster; the post-commit event log gets the same isolation.
  // A row only exists if `create` ran, so the `?.` here is unreachable-when-null rather than a
  // second live branch — the testable nullable guard is the one on the insert.
  if (outcome.eventRow) {
    try {
      eventHistory?.logRecorded(outcome.eventRow);
    } catch (error: unknown) {
      log.debug({ error: serializeError(error), jobId }, 'Failed to log the forced-import-refused event');
    }
  }
  log.debug({ jobId, bookId, placeholderRemoved: outcome.placeholderRemoved }, 'Forced-import refusal finalized');

  safeEmit(broadcaster, 'import_failed', {
    job_id: jobId,
    book_id: bookId,
    book_title: bookTitle,
    phase: currentPhase,
    error_message: errorMessage,
    refusal_reason: refusalReason,
  }, log);
}

/**
 * Caller must hold the admission lock for a non-null `bookId`.
 *
 * The job-fail update, the guarded delete and the durable event commit together: an event insert
 * launched after unlock can be overtaken by a queued deletion, and `book_events.book_id` is a real
 * FK, so that insert would then be rejected and the refusal event lost. The delete comes first
 * because the event's link is chosen from its outcome — FK-safe for the mirror of the reason
 * `BookDeletionService.commitDeletion` inserts first: the only arm that links here is the arm
 * where nothing was deleted.
 */
export async function finalizeForcedImportRefusalWithinAdmissionLock(
  deps: RefusedDispositionDeps,
  args: RefusedDispositionArgs,
  copy: RefusalCopy,
): Promise<RefusalOutcome> {
  const { db, eventHistory, log } = deps;
  const { jobId, bookId, bookTitle, phaseHistory } = args;
  const { refusalReason, errorMessage } = copy;
  const now = new Date();

  const placeholder = bookId == null
    ? { exists: false, deletable: false }
    : await readPlaceholderState(db, jobId, bookId);

  return db.transaction(async (tx) => {
    await tx.update(importJobs).set({
      status: 'failed',
      phase: 'failed',
      lastError: JSON.stringify({ message: errorMessage, type: 'OwnedRecordingError', refusal: refusalReason }),
      ...(phaseHistory ? { phaseHistory: JSON.stringify(phaseHistory) } : {}),
      completedAt: now,
      updatedAt: now,
    }).where(eq(importJobs.id, jobId));

    let placeholderRemoved = false;
    if (bookId != null && placeholder.deletable) {
      // The pre-read narrows the decision; this predicate stays as the atomic guard, so an existing
      // owned book cannot be removed and a status flip in between still misses.
      const result = await tx.delete(books).where(and(eq(books.id, bookId), eq(books.status, 'importing')));
      placeholderRemoved = getRowsAffected(result) > 0;
    }

    // A row that outlived the delete gets a linked event; a vanished one cannot be linked at all.
    const linkedBookId = !placeholderRemoved && placeholder.exists ? bookId : null;

    const eventRow = eventHistory
      ? await eventHistory.create({
        bookId: linkedBookId,
        bookTitle,
        eventType: 'import_failed',
        source: 'manual',
        reason: { error: errorMessage, refusal: refusalReason },
      }, tx).catch((err: unknown) => {
        // Caught inside the transaction: a failed event must not roll the disposition back.
        log.warn({ error: serializeError(err), jobId }, 'Failed to record forced-import-refused event');
        return null;
      })
      : null;

    return { placeholderRemoved, eventRow };
  });
}

/** Whatever the delete decision derives from is read INSIDE the section, never carried in. */
async function readPlaceholderState(db: Db, jobId: number, bookId: number): Promise<PlaceholderState> {
  const [job] = await db
    .select({ bookId: importJobs.bookId })
    .from(importJobs)
    .where(eq(importJobs.id, jobId))
    .limit(1);
  const [book] = await db
    .select({ status: books.status })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  const exists = book !== undefined;
  return { exists, deletable: job?.bookId === bookId && exists && book.status === 'importing' };
}
