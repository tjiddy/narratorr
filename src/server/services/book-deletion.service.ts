import type { FastifyBaseLogger } from 'fastify';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { ImportListExclusionService } from './import-list-exclusion.service.js';
import { basename } from 'node:path';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { cleanCoverCache } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { serializeError } from '../utils/serialize-error.js';

/** Managed deletion counts and preserved foreign basenames; never expose full foreign paths. */
export interface FileDeletionSummary {
  deletedManaged: number;
  preservedForeign: string[];
}

/** Tagged workflow result; fileSummary exists only when an on-disk deletion ran. */
export type BookDeletionResult =
  | { outcome: 'deleted'; bookTitle: string; fileSummary?: FileDeletionSummary }
  | { outcome: 'not_found' }
  | { outcome: 'path_outside_library'; error: string }
  | { outcome: 'file_deletion_failed'; error: string };

export interface DeleteBookOptions {
  deleteFiles: boolean;
}

/**
 * Disk deletion must succeed before DB mutation, and the import-list exclusion before every other
 * side effect. Download cancellation and event/cache side effects are best-effort; record the event
 * before DB deletion to preserve its snapshot.
 */
export class BookDeletionService {
  constructor(
    private bookService: BookService,
    private downloadService: DownloadService,
    private downloadOrchestrator: DownloadOrchestrator,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private exclusions?: ImportListExclusionService,
  ) {}

  async deleteBook(id: number, { deleteFiles }: DeleteBookOptions): Promise<BookDeletionResult> {
    const book = await this.bookService.getById(id);

    // Abort before any DB mutation if on-disk deletion fails.
    let fileSummary: FileDeletionSummary | undefined;
    if (deleteFiles) {
      if (!book) return { outcome: 'not_found' };
      if (book.path) {
        const diskResult = await this.deleteFilesFromDisk(id, book.path);
        if ('failure' in diskResult) return diskResult.failure;
        fileSummary = diskResult.summary;
      }
    }

    // Immediately after the disk step and before every other side effect. Later, a rejection would
    // leave the book present with its downloads already cancelled and a `deleted` event already in
    // Activity; earlier, a disk failure would permanently exclude a book still in the library.
    await this.recordImportListExclusion(book);

    await this.cancelActiveDownloads(id);

    this.recordDeletedEvent(id, book);

    const deleted = await this.bookService.delete(id);
    if (!deleted) return { outcome: 'not_found' };

    cleanCoverCache(id, config.configPath, this.log).catch((error: unknown) => {
      this.log.warn({ bookId: id, error: serializeError(error) }, 'Failed to clean cover cache during deletion');
    });

    this.log.info({ id, deleteFiles }, 'Book deleted');
    return { outcome: 'deleted', bookTitle: book?.title ?? '', ...(fileSummary ? { fileSummary } : {}) };
  }

  /** Managed-file failures are fatal; foreign files are preserved and reported by basename. */
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

  /** Attempt every active cancellation, logging individual failures. */
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

  /**
   * Remember an import-list book so no list re-adds it. Awaited, unlike the event below: it is the
   * durable artifact the next sync's gate reads, so a rejection aborts the deletion.
   *
   * Only import-list provenance triggers it. An exclusion counteracts an automated re-add and
   * nothing re-adds a manually-added book, so the narrowest trigger is the right one — an invisible
   * permanent block is worse than the re-add loop. Known consequence: `books.import_list_id` is
   * `onDelete: 'set null'`, so deleting the LIST first erases the provenance and a later book
   * delete records nothing.
   */
  private async recordImportListExclusion(book: BookWithAuthor | null): Promise<void> {
    if (!book || !this.exclusions || book.importListId === null) return;
    const exclusion = await this.exclusions.recordExclusion(
      { title: book.title, asin: book.asin, authorName: book.authors[0]?.name ?? null },
      { importListId: book.importListId, importListName: book.importListName ?? null },
    );
    this.log.info({ bookId: book.id, exclusionId: exclusion.id }, 'Recorded import list exclusion for deleted book');
  }

  /** Start the event write without blocking deletion; log rejection. */
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
