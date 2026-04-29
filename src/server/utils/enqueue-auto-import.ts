import { eq, and, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { importJobs } from '../../db/schema.js';
import { autoImportJobPayloadSchema, type AutoImportJobPayload } from '../services/import-adapters/types.js';
import { serializeError } from './serialize-error.js';

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
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(job.metadata);
    } catch (err) {
      log.warn({ existingJobId: job.id, error: serializeError(err) }, 'Skipping auto job with unparseable metadata during duplicate scan');
      continue;
    }
    const result = autoImportJobPayloadSchema.safeParse(parsedJson);
    if (!result.success) {
      log.warn({ existingJobId: job.id, error: serializeError(result.error) }, 'Skipping auto job with malformed metadata shape during duplicate scan');
      continue;
    }
    if (result.data.downloadId === downloadId) {
      log.debug({ downloadId, existingJobId: job.id }, 'Auto import job already exists for download — skipping');
      return false;
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
