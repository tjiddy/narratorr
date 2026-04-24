import { eq, and, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs } from '../../db/schema.js';
import type { AutoImportJobPayload } from '../services/import-adapters/types.js';

/**
 * Shared helper: create an auto import_jobs row and nudge the worker.
 * Called by all 3 auto-import entrypoints (quality gate, approve route, batch cron).
 * Includes duplicate protection — skips if a pending/processing auto job already exists for this download.
 * Returns true if a job was created, false if skipped (duplicate).
 */
export async function enqueueAutoImport(
  db: Db,
  downloadId: number,
  bookId: number,
  nudge: () => void,
  log: FastifyBaseLogger,
): Promise<boolean> {
  // Duplicate protection: check for existing pending/processing auto jobs
  const existingJobs = await db
    .select({ id: importJobs.id, metadata: importJobs.metadata })
    .from(importJobs)
    .where(and(
      eq(importJobs.type, 'auto'),
      inArray(importJobs.status, ['pending', 'processing']),
    ));

  for (const job of existingJobs) {
    try {
      const payload: AutoImportJobPayload = JSON.parse(job.metadata);
      if (payload.downloadId === downloadId) {
        log.debug({ downloadId, existingJobId: job.id }, 'Auto import job already exists for download — skipping');
        return false;
      }
    } catch {
      // Malformed metadata — skip
    }
  }

  const payload: AutoImportJobPayload = { downloadId };

  await db.insert(importJobs).values({
    bookId,
    type: 'auto',
    status: 'pending',
    phase: 'queued',
    metadata: JSON.stringify(payload),
  });

  log.info({ downloadId, bookId }, 'Auto import job enqueued');
  nudge();

  return true;
}
