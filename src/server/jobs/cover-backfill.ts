import { and, like, isNotNull } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@db/schema.js';
import { downloadRemoteCover } from '../services/cover-download.js';
import type { ConnectorService } from '../services/connector.service.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { serializeError } from '../utils/serialize-error.js';


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
        // 'skipped' cannot occur because the query requires a remote coverUrl.
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
