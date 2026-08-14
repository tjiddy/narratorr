import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { ClaimKeyChurnError, withFreshClaimLock } from '../utils/claim-lock.js';
import { findOtherPathOwner } from '../utils/path-identity.js';
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

/**
 * The rejected release left the book while the blacklist and retry search were in flight. Never
 * escapes `rejectAsWrongRelease`, which returns having done the non-destructive half.
 */
class RejectionSubjectGoneError extends Error {}

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

    try {
      // The claim is chosen from a read taken AFTER the blacklist/retry await, and the reset and
      // the file deletion share it — so the deliberate reset-before-irreversible-fs-step ordering
      // survives while its window stops being observable by a rename.
      await withFreshClaimLock(
        () => this.resolveRejectionPath(bookId, book),
        async (lockedPath) => {
          await this.resetBookRow(bookId);
          await this.sweepClaimedFolder(bookId, lockedPath);
        },
      );
    } catch (error: unknown) {
      if (error instanceof RejectionSubjectGoneError) return;
      if (error instanceof ClaimKeyChurnError) {
        // Non-fatal, exactly like a per-file deletion failure: only the sweep is abandoned, and
        // the book is still reset to wanted.
        this.log.warn({ bookId, error: serializeError(error) }, 'Wrong release: book path kept changing, skipped file deletion (continuing)');
        await this.resetBookRow(bookId);
      } else {
        throw error;
      }
    }

    this.recordWrongReleaseEvent(book);

    this.log.info({ bookId, title: book.title }, 'Book rejected as wrong release');
  }

  /**
   * Identity before path. Following the path alone is not safe: if a replacement release imports
   * during the blacklist await, the fresh row carries new identifiers and a new folder, and
   * following it would reset and delete the REPLACEMENT — destroying content the operator never
   * rejected. The blacklist and retry search have already been applied to the rejected release,
   * which is what the operator asked for; only the destructive half is abandoned.
   */
  private async resolveRejectionPath(bookId: number, snapshot: BookRowPublic): Promise<string | null> {
    const fresh = await this.bookService.getById(bookId);
    const stillTheRejectedRelease =
      fresh != null &&
      fresh.status === 'imported' &&
      fresh.lastGrabGuid === snapshot.lastGrabGuid &&
      fresh.lastGrabInfoHash === snapshot.lastGrabInfoHash;

    if (!stillTheRejectedRelease) {
      this.log.warn(
        {
          bookId,
          rejected: { guid: snapshot.lastGrabGuid, infoHash: snapshot.lastGrabInfoHash },
          current: fresh ? { guid: fresh.lastGrabGuid, infoHash: fresh.lastGrabInfoHash, status: fresh.status } : null,
        },
        'Wrong release: the rejected release is no longer on this book — skipping reset and file deletion',
      );
      throw new RejectionSubjectGoneError();
    }
    return fresh.path;
  }

  /** Idempotent, so it is safe on the re-acquire-exhaustion arm where no sweep ever runs. */
  private async resetBookRow(bookId: number): Promise<void> {
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
  }

  /**
   * A folder a different row owns is not this rejection's to destroy — this issue's own absence
   * is what produces duplicate-path pairs, so the case is reachable without any race.
   */
  private async sweepClaimedFolder(bookId: number, lockedPath: string | null): Promise<void> {
    if (!lockedPath) return;

    try {
      // Inside the same catch as the sweep: an ownership lookup that fails must be as nonfatal as
      // a file that will not delete, and it fails toward not deleting.
      const owner = await findOtherPathOwner(this.db, lockedPath, bookId);
      if (owner) {
        this.log.warn({ bookId, path: lockedPath, ownerBookId: owner.id }, 'Wrong release: another book owns this folder — skipping file deletion (continuing)');
        return;
      }

      await preserveBookCover(lockedPath, bookId, config.configPath, this.log);
      const librarySettings = await this.settingsService.get('library');
      const result = await this.bookService.deleteBookFiles(lockedPath, librarySettings.path);
      // Per-file failures are reported, not thrown; the prior DB reset makes them nonfatal.
      if (result.failedManaged.length > 0) {
        // Log paths so operators can remove orphaned files after the book path is cleared.
        this.log.warn({ bookId, failed: result.failedManaged.length, failedPaths: result.failedManaged }, 'Wrong release: some managed files could not be deleted (continuing)');
      }
    } catch (error: unknown) {
      if (error instanceof PathOutsideLibraryError) throw error;
      this.log.warn({ bookId, path: lockedPath, error: serializeError(error) }, 'Wrong release: failed to delete book files (continuing)');
    }
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
