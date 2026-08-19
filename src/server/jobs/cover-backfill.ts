import { and, eq, like, isNotNull } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@db/schema.js';
import { downloadRemoteCoverWithinAdmissionLock } from '../services/cover-download.js';
import type { CoverWriteOutcome } from '../services/cover-write.js';
import type { ConnectorService } from '../services/connector.service.js';
import { withBookAdmissionLock } from '../utils/book-admission-lock.js';
import { canonicalPath } from '../utils/path-identity.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { serializeError } from '../utils/serialize-error.js';


/**
 * Caller must hold the admission lock for `bookId`. Re-reads the row inside the section: the batch
 * query is a pre-lock snapshot by construction, so a book renamed or deleted since it ran must not
 * get a `cover.<ext>` written into the folder it no longer owns.
 */
async function revalidateThenDownload(
  bookId: number,
  snapshotPath: string,
  snapshotCoverUrl: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<CoverWriteOutcome | 'stale'> {
  const rows = await db
    .select({ path: books.path, coverUrl: books.coverUrl })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const fresh = rows[0];
  if (!fresh?.path || canonicalPath(fresh.path) !== canonicalPath(snapshotPath) || fresh.coverUrl !== snapshotCoverUrl) {
    log.debug(
      { bookId, snapshotPath, freshPath: fresh?.path ?? null },
      'Cover backfill: book changed since the batch query — skipping',
    );
    return 'stale';
  }
  return downloadRemoteCoverWithinAdmissionLock(bookId, fresh.path, snapshotCoverUrl, db, log);
}

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
  let stale = 0;

  for (const book of candidates) {
    try {
      // Per book inside the loop, never once around the sweep: one acquisition around the whole
      // batch would hold every book in the library for the length of the run.
      const outcome = await withBookAdmissionLock(book.id, () =>
        revalidateThenDownload(book.id, book.path!, book.coverUrl!, db, log));
      if (outcome === 'written') {
        downloaded++;
        enqueueBookRefresh(connectorService, log, 'metadata', {
          bookId: book.id, title: book.title, authorName: null, libraryPath: book.path!,
        });
      } else if (outcome === 'stale') {
        // Not a failure: the book legitimately moved on, and the operator has nothing to fix.
        stale++;
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
    { downloaded, failed, stale, total: candidates.length, elapsedLabel: 'cover-backfill' },
    'Cover backfill complete',
  );
}
