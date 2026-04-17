import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookService } from './book.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import { preserveBookCover } from '../utils/cover-cache.js';
import { config } from '../config.js';
import { serializeError } from '../utils/serialize-error.js';


type BookRow = typeof books.$inferSelect;

export class BookRejectionService {
  constructor(
    private db: Db,
    private log: FastifyBaseLogger,
    private bookService: BookService,
    private blacklistService: BlacklistService,
    private settingsService: SettingsService,
    private eventHistory?: EventHistoryService,
    private retrySearchDeps?: RetrySearchDeps,
  ) {}

  /**
   * Reject an imported book as wrong release:
   * 1. Blacklist the release (shared helper)
   * 2. Reset book fields immediately after blacklist (DB-1: before irreversible FS ops)
   * 3. Delete book files from disk (best-effort)
   * 4. Record wrong_release event
   * 5. Fire-and-forget re-search (shared helper)
   */
  async rejectAsWrongRelease(bookId: number): Promise<void> {
    const book = await this.bookService.getById(bookId);
    if (!book) throw new BookRejectionError('Book not found', 'NOT_FOUND');
    if (book.status !== 'imported') throw new BookRejectionError('Book is not imported', 'NOT_IMPORTED');
    if (!book.lastGrabGuid && !book.lastGrabInfoHash) throw new BookRejectionError('Book has no release identifiers', 'NO_IDENTIFIERS');

    // 1. Blacklist + 5. Re-search (fire-and-forget, overrideRetry since user explicitly requested)
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

    // 2. Reset book fields — immediately after blacklist, before irreversible FS deletion (DB-1)
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

    // 3. Preserve cover + delete book files (best-effort — after DB reset so crash won't leave stale state)
    if (book.path) {
      try {
        await preserveBookCover(book.path, bookId, config.configPath, this.log);
        const librarySettings = await this.settingsService.get('library');
        await this.bookService.deleteBookFiles(book.path, librarySettings.path);
      } catch (error: unknown) {
        this.log.warn({ bookId, path: book.path, error: serializeError(error) }, 'Wrong release: failed to delete book files (continuing)');
      }
    }

    // 4. Record event (fire-and-forget)
    this.recordWrongReleaseEvent(book);

    this.log.info({ bookId, title: book.title }, 'Book rejected as wrong release');
  }

  private recordWrongReleaseEvent(book: BookRow): void {
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
