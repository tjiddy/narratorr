import { and, eq, ne, or } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, downloads } from '@db/schema.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { revertBookStatus } from './book-status.js';
import { inProgressDownloadCondition, completedDisplayDownloadCondition } from './download-state.js';
import { safeEmit } from './safe-emit.js';

/**
 * What happens to the BOOK when one of its downloads reaches a terminal failure — separate from how
 * the monitor polls download clients, and the only reason this module changes.
 */

// Revert only when no other blocker exists, using the pre-grab snapshot rather than path inference.
export async function recoverBookStatus(
  db: Db,
  bookId: number,
  failedDownloadId: number,
  log: FastifyBaseLogger,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  // Completed rows still block recovery while awaiting import.
  const otherActive = await db
    .select()
    .from(downloads)
    .where(and(
      eq(downloads.bookId, bookId),
      or(inProgressDownloadCondition(), completedDisplayDownloadCondition()),
      ne(downloads.id, failedDownloadId),
    ));

  if (otherActive.length > 0) {
    log.debug({ bookId, otherActiveCount: otherActive.length }, 'Skipping book status recovery — other active downloads exist');
    return;
  }

  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) return;

  const [failedDownload] = await db
    .select({ bookStatusAtGrab: downloads.bookStatusAtGrab })
    .from(downloads)
    .where(eq(downloads.id, failedDownloadId))
    .limit(1);

  const oldStatus = book.status;
  const newStatus = await revertBookStatus(db, book, failedDownload?.bookStatusAtGrab ?? null);
  if (oldStatus !== newStatus) {
    safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: oldStatus, new_status: newStatus }, log);
  }
  log.info({ bookId, status: newStatus }, 'Book status recovered after download failure');
}

/**
 * The shape every terminal retry arm shares: record why on the failed row, then hand the book back.
 * `retry_error` joined the other three in #2622 — its row already carries the operator-facing
 * message, so keeping the book at its grab-time status only hid it from the wanted-search.
 */
export async function failTerminally(
  db: Db,
  ids: { downloadId: number; bookId: number },
  errorMessage: string,
  log: FastifyBaseLogger,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  await db.update(downloads).set({ errorMessage }).where(eq(downloads.id, ids.downloadId));
  await recoverBookStatus(db, ids.bookId, ids.downloadId, log, broadcaster);
}
