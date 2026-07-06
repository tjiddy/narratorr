import { and, like, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { downloadRemoteCover } from '../services/cover-download.js';
import type { ConnectorService } from '../services/connector.service.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { serializeError } from '../utils/serialize-error.js';


/**
 * Startup backfill: download covers for imported books that still have remote coverUrl values.
 * Runs once after boot. Sequential processing with per-item error isolation. Fires a `'metadata'`
 * connector refresh per book whose cover actually materialized (`'written'`, including a post-rename
 * DB-update failure) so a downstream media server picks up the new folder cover.
 */
export async function runCoverBackfill(db: Db, log: FastifyBaseLogger, connectorService?: ConnectorService): Promise<void> {
  const candidates = await db
    .select({ id: books.id, coverUrl: books.coverUrl, path: books.path, title: books.title })
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
      const outcome = await downloadRemoteCover(
        book.id, book.path!, book.coverUrl!, db, log,
      );
      if (outcome === 'written') {
        downloaded++;
        enqueueBookRefresh(connectorService, log, 'metadata', {
          bookId: book.id, title: book.title, authorName: null, libraryPath: book.path!,
        });
      } else {
        // 'skipped' cannot occur here (the WHERE gates a remote coverUrl); 'failed' is a real failure.
        failed++;
        log.warn({ bookId: book.id }, 'Cover backfill: download returned failure');
      }
    } catch (error: unknown) {
      failed++;
      log.warn({ error: serializeError(error), bookId: book.id }, 'Cover backfill: unexpected error during download');
    }
  }

  log.info(
    { downloaded, failed, total: candidates.length, elapsedLabel: 'cover-backfill' },
    'Cover backfill complete',
  );
}
