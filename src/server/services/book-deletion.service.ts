import type { FastifyBaseLogger } from 'fastify';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { basename } from 'node:path';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { cleanCoverCache } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { serializeError } from '../utils/serialize-error.js';

/**
 * Disclosure of what an on-disk delete touched (#1589): how many managed files (audio + cover
 * sidecar) were removed and which FOREIGN files (e-books, PDFs, …) were intentionally preserved.
 * Foreign filenames are basenames only — never full paths.
 */
export interface FileDeletionSummary {
  deletedManaged: number;
  preservedForeign: string[];
}

/**
 * Tagged result of {@link BookDeletionService.deleteBook}. The route maps each
 * variant to an HTTP status: `deleted` → 200, `not_found` → 404,
 * `path_outside_library` → 400, `file_deletion_failed` → 500.
 *
 * `fileSummary` is present on `deleted` only when files were removed from disk
 * (`deleteFiles` true and the book had a path); it drives the "kept N files" disclosure.
 */
export type BookDeletionResult =
  | { outcome: 'deleted'; bookTitle: string; fileSummary?: FileDeletionSummary }
  | { outcome: 'not_found' }
  | { outcome: 'path_outside_library'; error: string }
  | { outcome: 'file_deletion_failed'; error: string };

export interface DeleteBookOptions {
  deleteFiles: boolean;
}

/**
 * Owns the destructive book-deletion workflow that previously lived inline in
 * `DELETE /api/books/:id`. Ordering invariants are load-bearing:
 *
 * 1. When `deleteFiles`, files are removed from disk BEFORE any DB mutation, so
 *    a file-deletion failure leaves the DB row intact (no downloads cancelled,
 *    no event recorded, no `bookService.delete`).
 * 2. Active downloads are cancelled best-effort — a per-download failure is
 *    logged and the loop continues so remaining downloads are still cancelled.
 * 3. The `deleted` event is recorded BEFORE `bookService.delete` (snapshot
 *    preserved) and is fire-and-forget: an event-history write failure must NOT
 *    block deletion or change the `deleted` result.
 * 4. Cover-cache cleanup runs best-effort AFTER a successful DB delete.
 */
export class BookDeletionService {
  constructor(
    private bookService: BookService,
    private downloadService: DownloadService,
    private downloadOrchestrator: DownloadOrchestrator,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
  ) {}

  async deleteBook(id: number, { deleteFiles }: DeleteBookOptions): Promise<BookDeletionResult> {
    // Fetch once for file deletion + event snapshot.
    const book = await this.bookService.getById(id);

    // If deleteFiles requested, delete from disk BEFORE cancelling downloads or
    // removing the DB record. A failure here aborts the whole workflow.
    let fileSummary: FileDeletionSummary | undefined;
    if (deleteFiles) {
      if (!book) return { outcome: 'not_found' };
      if (book.path) {
        const diskResult = await this.deleteFilesFromDisk(id, book.path);
        if ('failure' in diskResult) return diskResult.failure;
        fileSummary = diskResult.summary;
      }
    }

    await this.cancelActiveDownloads(id);

    // Record deleted event before DB deletion (fire-and-forget — see class doc).
    this.recordDeletedEvent(id, book);

    const deleted = await this.bookService.delete(id);
    if (!deleted) return { outcome: 'not_found' };

    // Clean up cached cover after successful DB delete (best-effort).
    cleanCoverCache(id, config.configPath, this.log).catch((error: unknown) => {
      this.log.warn({ bookId: id, error: serializeError(error) }, 'Failed to clean cover cache during deletion');
    });

    this.log.info({ id, deleteFiles }, 'Book deleted');
    return { outcome: 'deleted', bookTitle: book?.title ?? '', ...(fileSummary ? { fileSummary } : {}) };
  }

  /**
   * Delete the book's managed files from disk (#1589). Returns either a `failure` result variant
   * (so the caller aborts BEFORE any DB mutation, preserving the abort-before-DB invariant) or a
   * `summary` of what was removed/preserved on success.
   *
   * A non-empty `failedManaged` (a managed audio file `rm` rejected) is FATAL here — the DB row
   * must not be deleted while managed audio remains on disk, exactly as when `rm` threw before.
   * Preserved foreign files alone are SUCCESS and drive the "kept N files" disclosure.
   */
  private async deleteFilesFromDisk(
    id: number,
    bookPath: string,
  ): Promise<{ failure: BookDeletionResult } | { summary: FileDeletionSummary }> {
    try {
      const librarySettings = await this.settingsService.get('library');
      const result = await this.bookService.deleteBookFiles(bookPath, librarySettings.path);
      if (result.failedManaged.length > 0) {
        this.log.error({ bookId: id, failed: result.failedManaged.length }, 'Failed to delete some managed book files — aborting before DB delete');
        return { failure: { outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' } };
      }
      return {
        summary: {
          deletedManaged: result.deletedManaged.length,
          preservedForeign: result.preservedForeign.map((p) => basename(p)),
        },
      };
    } catch (error: unknown) {
      if (error instanceof PathOutsideLibraryError) {
        this.log.warn({ bookId: id, error: serializeError(error) }, 'Refused book file deletion: path outside library root');
        return { failure: { outcome: 'path_outside_library', error: error.message } };
      }
      this.log.error({ bookId: id, error: serializeError(error) }, 'Failed to delete book files');
      return { failure: { outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' } };
    }
  }

  /** Cancel all active downloads for the book, swallowing per-download failures. */
  private async cancelActiveDownloads(id: number): Promise<void> {
    const activeDownloads = await this.downloadService.getActiveByBookId(id);
    for (const download of activeDownloads) {
      try {
        await this.downloadOrchestrator.cancel(download.id);
      } catch (error: unknown) {
        this.log.warn({ downloadId: download.id, error: serializeError(error) }, 'Failed to cancel download during book deletion');
      }
    }
    if (activeDownloads.length > 0) {
      this.log.info({ bookId: id, count: activeDownloads.length }, 'Cancelled active downloads for book');
    }
  }

  /** Record the `deleted` event fire-and-forget (rejection logged, not awaited). */
  private recordDeletedEvent(id: number, book: BookWithAuthor | null): void {
    if (!book || !this.eventHistory) return;
    this.eventHistory.create({
      bookId: id,
      ...snapshotBookForEvent(book),
      eventType: 'deleted',
      source: 'manual',
    }).catch((err: unknown) => this.log.warn({ error: serializeError(err) }, 'Failed to record deleted event'));
  }
}
