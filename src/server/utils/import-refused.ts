import { eq, and } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs, books } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import type { PhaseHistoryEntry } from '../../shared/schemas/import-job.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import { buildForcedImportRefusedReason, type OwnedRecordingError } from '../services/book.service.js';
import { safeEmit } from './safe-emit.js';
import { serializeError } from './serialize-error.js';

export interface RefusedDispositionDeps {
  db: Db;
  broadcaster: EventBroadcasterService | null;
  /** Optional: records the durable refusal event. Omitted in unit tests that don't assert it. */
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

/**
 * Terminal disposition for a forced import the copy-time collision fence refused (#1736).
 * Reuses the existing terminal values (job `failed`/`failed`, the `import_failed` event + SSE)
 * — no new job/book status or SSE event type — but (a) DELETES the speculative placeholder book
 * created at enqueue (guarded to THIS job's book and only while still `importing`, so a
 * pre-existing owned book is never touched) and (b) enriches the event/SSE with a structured
 * `forced-import-refused` reason. After the delete, `import_jobs.book_id` / `book_events.book_id`
 * are nulled by their `onDelete: set null` FK; the SSE still carries the PRE-delete placeholder
 * `book_id` so the client can evict that book card from its cache.
 */
export async function finalizeForcedImportRefusal(deps: RefusedDispositionDeps, args: RefusedDispositionArgs): Promise<void> {
  const { db, broadcaster, eventHistory, log } = deps;
  const { jobId, bookId, currentPhase, bookTitle, error, phaseHistory } = args;
  const now = new Date();
  const refusalReason = buildForcedImportRefusedReason(error);
  const errorMessage = refusalReason.existingBookId != null
    ? `force refused: target owned by book #${refusalReason.existingBookId} (${error.reason})`
    : `force refused: target has audio on disk with no identifiable owner (${error.reason})`;

  await db.transaction(async (tx) => {
    await tx.update(importJobs).set({
      status: 'failed',
      phase: 'failed',
      lastError: JSON.stringify({ message: errorMessage, type: 'OwnedRecordingError', refusal: refusalReason }),
      ...(phaseHistory ? { phaseHistory: JSON.stringify(phaseHistory) } : {}),
      completedAt: now,
      updatedAt: now,
    }).where(eq(importJobs.id, jobId));

    // Delete the speculative placeholder (created `importing` before enqueue), replacing the
    // generic `importing → failed` transition. Guarded to this job's book AND `importing` only,
    // so a pre-existing owned book that happens to be linked is never deleted.
    if (bookId != null) {
      await tx.delete(books).where(and(eq(books.id, bookId), eq(books.status, 'importing')));
    }
  });

  // Durable refusal event on the existing `import_failed` channel — self-describing via the
  // structured reason. Best-effort; a missing eventHistory just skips the event row.
  // `bookId: null` — the placeholder was just deleted, so the event preserves a human-readable
  // `bookTitle` + the structured reason in its own columns and does not link to a dead row (with
  // FK enforcement ON, inserting the deleted id would violate the FK anyway). Matches the F7
  // post-delete linkage contract (`book_events.book_id` resolves to null).
  eventHistory?.create({
    bookId: null,
    bookTitle,
    eventType: 'import_failed',
    source: 'manual',
    reason: { error: errorMessage, refusal: refusalReason },
  }).catch((err: unknown) => log.warn({ error: serializeError(err), jobId }, 'Failed to record forced-import-refused event'));

  safeEmit(broadcaster, 'import_failed', {
    job_id: jobId,
    book_id: bookId,
    book_title: bookTitle,
    phase: currentPhase,
    error_message: errorMessage,
    refusal_reason: refusalReason,
  }, log);
}
