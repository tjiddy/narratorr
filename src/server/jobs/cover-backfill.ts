import { and, like, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { downloadRemoteCover } from '../services/cover-download.js';

/**
 * Startup backfill: download covers for imported books that still have remote coverUrl values.
 * Runs once after boot. Sequential processing with per-item error isolation.
 */
export async function runCoverBackfill(db: Db, log: FastifyBaseLogger): Promise<void> {
  const candidates = await db
    .select({ id: books.id, coverUrl: books.coverUrl, path: books.path })
    .from(books)
    .where(and(
      like(books.coverUrl, 'http%'),
      isNotNull(books.path),
    ));

  if (candidates.length === 0) {
    log.debug('Cover backfill: no books with remote covers to download');
    return;
  }

  log.info({ total: candidates.length }, 'Cover backfill: starting download of remote covers');

  let downloaded = 0;
  let failed = 0;

  for (const book of candidates) {
    try {
      const success = await downloadRemoteCover(
        book.id, book.path!, book.coverUrl!, db, log,
      );
      if (success) {
        downloaded++;
      } else {
        failed++;
        log.warn({ bookId: book.id }, 'Cover backfill: download returned failure');
      }
    } catch (error: unknown) {
      failed++;
      log.warn({ error, bookId: book.id }, 'Cover backfill: unexpected error during download');
    }
  }

  log.info(
    { downloaded, failed, total: candidates.length, elapsedLabel: 'cover-backfill' },
    'Cover backfill complete',
  );
}
