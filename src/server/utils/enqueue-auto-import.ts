import type { FastifyBaseLogger } from 'fastify';
import type { BookImportService } from '../services/book-import.service.js';
import type { AutoImportJobPayload } from '../services/import-adapters/types.js';

// BookImportService owns transaction/deduplication; preserve the legacy created/skipped boolean.
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
