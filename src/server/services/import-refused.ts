import { eq, and } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs, books } from '@db/schema.js';
import type { Db } from '@db/index.js';
import type { PhaseHistoryEntry } from '@shared/schemas/import-job.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { buildForcedImportRefusedReason, type OwnedRecordingError } from './book.service.js';
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

/**
 * Fail a forced import refused by the collision fence. Delete only its importing placeholder;
 * durable FKs become null, while SSE retains the old id so clients can evict the placeholder card.
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

    // Guard by id and importing status so an existing owned book cannot be removed.
    if (bookId != null) {
      await tx.delete(books).where(and(eq(books.id, bookId), eq(books.status, 'importing')));
    }
  });

  // The placeholder is gone, so the best-effort durable event stays unlinked and carries context.
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
