import type { FastifyBaseLogger } from 'fastify';
import type { BookImportService } from '../services/book-import.service.js';
import type { AutoImportJobPayload } from '../services/import-adapters/types.js';

/**
 * Thin wrapper around BookImportService.enqueue for the 'auto' job type.
 * The transactional check + insert lives in BookImportService.enqueue;
 * this helper formats the payload and reports back as a boolean for
 * legacy callers that only need created/skipped semantics.
 *
 * Returns true if a job was created, false if an active job already exists
 * for the bookId (the partial unique index `idx_import_jobs_book_active`
 * permits exactly one pending/processing row per non-null book_id).
 */
export async function enqueueAutoImport(
  bookImportService: BookImportService,
  downloadId: number,
  bookId: number,
  nudge: () => void,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const payload: AutoImportJobPayload = { downloadId };
  const result = await bookImportService.enqueue({
    bookId,
    type: 'auto',
    metadata: JSON.stringify(payload),
  });

  if ('error' in result) {
    log.info(
      { downloadId, bookId },
      'Auto import job already enqueued for book — skipping',
    );
    return false;
  }

  log.info({ downloadId, bookId, jobId: result.jobId }, 'Auto import job enqueued');
  nudge();
  return true;
}
