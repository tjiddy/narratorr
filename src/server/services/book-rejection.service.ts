import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import { blacklistAndRetrySearch } from './rejection-helpers.js';
import { triggerCompanionReconcile, type CompanionBookReconcileTrigger } from './companion-ebook-trigger.js';
import { preserveBookCover } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { serializeError } from '../utils/serialize-error.js';
import type { BookRowPublic } from './types.js';

export class BookRejectionService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private bookService: BookService,
    private blacklistService: BlacklistService,
    private settingsService: SettingsService,
    private eventHistory?: EventHistoryService,
    private retrySearchDeps?: RetrySearchDeps,
    private companionEbook?: CompanionBookReconcileTrigger,
  ) {}

  /** Blacklist first, reset DB before filesystem work, then clean up and record best-effort. */
  async rejectAsWrongRelease(bookId: number): Promise<void> {
    const book = await this.bookService.getById(bookId);
    if (!book) throw new BookRejectionError('Book not found', 'NOT_FOUND');
    if (book.status !== 'imported') throw new BookRejectionError('Book is not imported', 'NOT_IMPORTED');
    if (!book.lastGrabGuid && !book.lastGrabInfoHash) throw new BookRejectionError('Book has no release identifiers', 'NO_IDENTIFIERS');

    // The user explicitly requested retry, so overrideRetry bypasses automatic settings.
    await blacklistAndRetrySearch({
      identifiers: {
        infoHash: book.lastGrabInfoHash ?? undefined,
        guid: book.lastGrabGuid ?? undefined,
        title: book.title,
        bookId: book.id,
      },
      reason: 'wrong_content',
      book: { id: book.id },
      blacklistService: this.blacklistService,
      retrySearchDeps: this.retrySearchDeps,
      settingsService: this.settingsService,
      log: this.log,
      overrideRetry: true,
    });

    // Reset book fields before irreversible filesystem deletion so crashes cannot leave stale metadata.
    await this.db.update(books).set({
      status: 'wanted',
      path: null,
      size: null,
      audioCodec: null,
      audioBitrate: null,
      audioSampleRate: null,
      audioChannels: null,
      audioBitrateMode: null,
      audioFileFormat: null,
      audioFileCount: null,
      topLevelAudioFileCount: null,
      audioTotalSize: null,
      audioDuration: null,
      lastGrabGuid: null,
      lastGrabInfoHash: null,
      updatedAt: new Date(),
    }).where(eq(books.id, bookId));

    // Wanted/pathless books must short-circuit reconciliation before any companion write.
    triggerCompanionReconcile(this.companionEbook, bookId, this.log, 'Companion ebook reconcile failed after wrong-release reset');

    if (book.path) {
      try {
        await preserveBookCover(book.path, bookId, config.configPath, this.log);
        const librarySettings = await this.settingsService.get('library');
        const result = await this.bookService.deleteBookFiles(book.path, librarySettings.path);
        // Per-file failures are reported, not thrown; the prior DB reset makes them nonfatal.
        if (result.failedManaged.length > 0) {
          // Log paths so operators can remove orphaned files after the book path is cleared.
          this.log.warn({ bookId, failed: result.failedManaged.length, failedPaths: result.failedManaged }, 'Wrong release: some managed files could not be deleted (continuing)');
        }
      } catch (error: unknown) {
        if (error instanceof PathOutsideLibraryError) throw error;
        this.log.warn({ bookId, path: book.path, error: serializeError(error) }, 'Wrong release: failed to delete book files (continuing)');
      }
    }

    this.recordWrongReleaseEvent(book);

    this.log.info({ bookId, title: book.title }, 'Book rejected as wrong release');
  }

  private recordWrongReleaseEvent(book: BookRowPublic): void {
    if (!this.eventHistory) return;

    this.eventHistory.create({
      bookId: book.id,
      bookTitle: book.title,
      eventType: 'wrong_release',
      source: 'manual',
      reason: {
        lastGrabGuid: book.lastGrabGuid,
        lastGrabInfoHash: book.lastGrabInfoHash,
      },
    }).catch((error: unknown) => {
      this.log.warn({ bookId: book.id, error: serializeError(error) }, 'Wrong release: failed to record event');
    });
  }
}

export class BookRejectionError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NOT_IMPORTED' | 'NO_IDENTIFIERS',
  ) {
    super(message);
    this.name = 'BookRejectionError';
  }
}
