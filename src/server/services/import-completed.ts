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
  /** Elapsed-time origin captured when the worker picks up the job. */
  startTime: number;
}

/** Resolve the canonical SSE title, quietly falling back on any lookup failure. */
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

export async function finalizeCompletedImport(
  deps: CompletedDispositionDeps,
  args: CompletedDispositionArgs,
): Promise<void> {
  const { db, broadcaster, log } = deps;
  const { jobId, bookId, bookTitle, phaseHistory, startTime } = args;

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
