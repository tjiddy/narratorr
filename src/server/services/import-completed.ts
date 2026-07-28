import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs, books } from '@db/schema.js';
import type { Db } from '@db/index.js';
import type { PhaseHistoryEntry } from '@shared/schemas/import-job.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { safeEmit } from '../utils/safe-emit.js';

export interface CompletedDispositionDeps {
  db: Db;
  broadcaster: EventBroadcasterService | null;
  log: FastifyBaseLogger;
}

export interface CompletedDispositionArgs {
  jobId: number;
  bookId: number | null;
  bookTitle: string;
  phaseHistory: PhaseHistoryEntry[];
  /** `Date.now()` captured when the job was picked up — the elapsed-time origin. */
  startTime: number;
}

/**
 * Resolve the canonical book title from the `books` row for SSE emit.
 * Falls back to `fallback` when bookId is null, the row is missing, or the
 * lookup throws — preserves the quiet-path semantics for this high-volume
 * code (no error logs on failure).
 */
export async function resolveBookTitle(db: Db, bookId: number | null, fallback: string): Promise<string> {
  if (bookId === null) return fallback;
  try {
    const rows = await db
      .select({ title: books.title })
      .from(books)
      .where(eq(books.id, bookId))
      .limit(1);
    return rows[0]?.title ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Terminal disposition for an import job the adapter processed successfully (#1960 AC2).
 * Extracted from `ImportQueueWorker.processJob`'s success tail — same deps/args shape as
 * `finalizeForcedImportRefusal`, its sibling on the failure side — so the worker stays under
 * its 400-line cap while the companion-ebook trigger seam lands beside it.
 *
 * Behaviour is byte-for-byte what the worker did inline: close the open phase entry, persist
 * the completion UPDATE, compute elapsed time, resolve the canonical title, emit
 * `import_complete`, and log the success line. It does NOT trigger the companion reconcile —
 * that seam is the worker's, sited so it cannot fail the job (AC7).
 */
export async function finalizeCompletedImport(
  deps: CompletedDispositionDeps,
  args: CompletedDispositionArgs,
): Promise<void> {
  const { db, broadcaster, log } = deps;
  const { jobId, bookId, bookTitle, phaseHistory, startTime } = args;

  // Close current phase entry
  if (phaseHistory.length > 0) {
    const last = phaseHistory[phaseHistory.length - 1]!;
    if (last.completedAt === undefined) {
      last.completedAt = Date.now();
    }
  }

  const now = new Date();
  await db.update(importJobs).set({
    status: 'completed',
    phase: 'done',
    phaseHistory: JSON.stringify(phaseHistory),
    completedAt: now,
    updatedAt: now,
  }).where(eq(importJobs.id, jobId));

  const elapsedMs = Date.now() - startTime;
  const resolvedTitle = await resolveBookTitle(db, bookId, bookTitle);
  safeEmit(broadcaster, 'import_complete', {
    download_id: null,
    book_id: bookId,
    book_title: resolvedTitle,
    job_id: jobId,
    elapsed_ms: elapsedMs,
  }, log);

  log.info({ jobId, elapsedMs }, 'Import job completed successfully');
}
