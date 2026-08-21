import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { DownloadService, DownloadWithBook } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { ImportListExclusionService, ExclusionRecordResult } from './import-list-exclusion.service.js';
import type { BookEventRow } from './types.js';
import { basename } from 'node:path';
import { PathOutsideLibraryError } from '../utils/paths.js';
import { ClaimKeyChurnError, withFreshClaimLock } from '../utils/claim-lock.js';
import { withBookAdmissionLock } from './book-admission.js';
import { findOtherPathOwner } from '../utils/path-identity.js';
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

/** Counts for an operator-initiated sweep; the two skip classes are logged rather than counted. */
export interface BulkDeletionSummary {
  deleted: number;
  failed: number;
}

/** What the deletion transaction landed, handed back so their effects and logs run after commit. */
interface CommittedDeletion {
  exclusion: ExclusionRecordResult | null;
  /** Add-ledger rows the tombstone absorbed, so the undo page shows one entry, not two (#2530). */
  releasedAddLedgerRows: number;
  event: BookEventRow | null;
  activeDownloads: DownloadWithBook[];
}

/**
 * Rolls the deletion transaction back when the row vanished between hydration and the delete.
 * Never escapes `deleteBook`, which maps it to the `not_found` arm.
 */
class BookRowVanishedError extends Error {}

/** Either the deletion aborted with its own outcome, or the transaction landed. */
type StagedDeletion =
  | { failure: BookDeletionResult }
  | { committed: CommittedDeletion; fileSummary: FileDeletionSummary | undefined };

/**
 * Disk deletion must succeed before DB mutation. Every durable artifact — the import-list
 * exclusion, the `deleted` event and the row itself — then commits together or not at all, so a
 * failure can never strand an exclusion or an Activity entry describing a book that is still here.
 * Download cancellation and cover-cache cleanup are network/filesystem work and stay best-effort,
 * after the commit.
 */
export class BookDeletionService {
  constructor(
    private db: Db,
    private bookService: BookService,
    private downloadService: DownloadService,
    private downloadOrchestrator: DownloadOrchestrator,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private exclusions?: ImportListExclusionService,
  ) {}

  /**
   * Admission outside the claim keys. The claim protocol already serializes deletion against rename
   * and the other destroyers; the outer acquisition adds everything else — a merge, an import, a
   * retag or a cover write can no longer be mid-flight in the folder this is about to sweep.
   * `withFreshClaimLock`'s re-acquire loop and its `ClaimKeyChurnError` arm are unchanged.
   */
  async deleteBook(id: number, options: DeleteBookOptions): Promise<BookDeletionResult> {
    return withBookAdmissionLock(id, () => this.deleteBookWithinAdmissionLock(id, options));
  }

  /** Caller must hold the admission lock for `id`. Public so `deleteMissingBooks`, which acquires
   * per book itself, can reach it without nesting a second acquisition on the same id. */
  async deleteBookWithinAdmissionLock(id: number, { deleteFiles }: DeleteBookOptions): Promise<BookDeletionResult> {
    const book = await this.bookService.getById(id);

    // Abort before any DB mutation if on-disk deletion fails.
    const staged = deleteFiles
      ? book
        ? await this.sweepAndCommitUnderClaim(id, book)
        : { failure: { outcome: 'not_found' } as const }
      : await this.commitStage(id, book, undefined);
    if ('failure' in staged) return staged.failure;

    this.reportCommitted(id, staged.committed);
    await this.cancelDownloads(id, staged.committed.activeDownloads);

    cleanCoverCache(id, config.configPath, this.log).catch((error: unknown) => {
      this.log.warn({ bookId: id, error: serializeError(error) }, 'Failed to clean cover cache during deletion');
    });

    this.log.info({ id, deleteFiles, title: book?.title ?? null }, 'Book deleted');
    return { outcome: 'deleted', bookTitle: book?.title ?? '', ...(staged.fileSummary ? { fileSummary: staged.fileSummary } : {}) };
  }

  /**
   * The disk sweep and the row delete share one claim on the folder, so a rename cannot land in it
   * between them, and the path swept is the one the row names NOW — `deleteBook` hydrates its row,
   * awaits, and would otherwise sweep from that stale read even with no second request in flight.
   */
  private async sweepAndCommitUnderClaim(id: number, book: BookWithAuthor): Promise<StagedDeletion> {
    try {
      return await withFreshClaimLock(
        async () => (await this.bookService.getById(id))?.path ?? null,
        async (lockedPath) => {
          if (lockedPath === null) return this.commitStage(id, book, undefined);
          const disk = await this.sweepClaimedFolder(id, lockedPath);
          if ('failure' in disk) return disk;
          return this.commitStage(id, book, disk.summary);
        },
      );
    } catch (error: unknown) {
      if (!(error instanceof ClaimKeyChurnError)) throw error;
      // Sustained churn takes the existing pre-commit failure arm, so the book is never deleted
      // with its files stranded.
      this.log.error({ bookId: id, error: serializeError(error) }, 'Book path kept changing during deletion — aborting before DB delete');
      return { failure: { outcome: 'file_deletion_failed', error: 'Failed to delete book files from disk' } };
    }
  }

  /**
   * Refusing when a different row owns the folder is not merely defensive: a database predating
   * #2301 can already hold two rows naming one folder, and sweeping for one destroys the other's
   * content with no race required. The book still deletes — the files simply belong elsewhere.
   */
  private async sweepClaimedFolder(
    id: number,
    lockedPath: string,
  ): Promise<{ failure: BookDeletionResult } | { summary: FileDeletionSummary }> {
    const owner = await findOtherPathOwner(this.db, lockedPath, id);
    if (owner) {
      this.log.warn({ bookId: id, path: lockedPath, ownerBookId: owner.id }, 'Skipped book file deletion — another book owns this folder');
      return { summary: { deletedManaged: 0, preservedForeign: [] } };
    }
    return this.deleteFilesFromDisk(id, lockedPath);
  }

  private async commitStage(
    id: number,
    book: BookWithAuthor | null,
    fileSummary: FileDeletionSummary | undefined,
  ): Promise<StagedDeletion> {
    try {
      return { committed: await this.commitDeletion(id, book), fileSummary };
    } catch (error: unknown) {
      if (error instanceof BookRowVanishedError) return { failure: { outcome: 'not_found' } };
      throw error;
    }
  }

  /**
   * Delete every book still holding `missing` at its turn, through the single-book routine so the
   * exclusion decision, the `deleted` event, cancellation and cache cleanup have exactly one
   * implementation. Sequential and transaction-free: `deleteBook` owns one transaction per book,
   * and a wrapping one would nest and throw.
   *
   * The admission lock is taken PER BOOK inside the loop, never once around the sweep: one long
   * hold would stall every other mutator in the library, and the batch has no shared state to
   * protect. The status re-check moves inside each acquisition — outside it, a merge or import
   * holding the book could promote it out of `missing` after the check and before the delete.
   *
   * `deleteFiles: false` is load-bearing — a `missing` book's files are already gone from disk.
   */
  async deleteMissingBooks(): Promise<BulkDeletionSummary> {
    // The one batch-level operation: with no list of ids there is no sweep to isolate failures in.
    const ids = await this.bookService.findIdsByStatus('missing');
    const summary: BulkDeletionSummary = { deleted: 0, failed: 0 };

    for (const id of ids) {
      try {
        const result = await withBookAdmissionLock(id, async () => {
          // A concurrent library scan legitimately restores `missing → imported` when the path
          // reappears; deleting that book would drop a row whose files are back AND exclude it.
          const status = await this.bookService.getStatusById(id);
          if (status !== 'missing') {
            this.log.info({ bookId: id, status }, 'Skipped book that is no longer missing');
            return null;
          }
          return this.deleteBookWithinAdmissionLock(id, { deleteFiles: false });
        });
        if (result) this.countOutcome(id, result, summary);
      } catch (error: unknown) {
        summary.failed++;
        this.log.error({ bookId: id, error: serializeError(error) }, 'Failed to delete missing book');
      }
    }

    return summary;
  }

  /** Only an operational failure counts; a book that vanished on its own was never this sweep's work. */
  private countOutcome(id: number, result: BookDeletionResult, summary: BulkDeletionSummary): void {
    if (result.outcome === 'deleted') {
      summary.deleted++;
    } else if (result.outcome === 'not_found') {
      this.log.debug({ bookId: id }, 'Missing book vanished before the sweep deleted it');
    } else {
      // Unreachable with deleteFiles: false — the disk arm never runs. Counted rather than ignored.
      summary.failed++;
      this.log.warn({ bookId: id, outcome: result.outcome }, 'Unexpected disk outcome sweeping missing books');
    }
  }

  /**
   * The exclusion write comes first so a rejection aborts the deletion having done nothing else,
   * and the event insert precedes the row delete because `book_events.book_id` is ON DELETE SET
   * NULL — inserted afterwards it would violate the foreign key. The active-download lookup is an
   * ordinary read and belongs here; the cancellations it feeds are network I/O and do not.
   */
  private async commitDeletion(id: number, book: BookWithAuthor | null): Promise<CommittedDeletion> {
    return this.db.transaction(async (tx) => {
      const exclusion = await this.recordImportListExclusion(book, tx);
      const releasedAddLedgerRows = await this.releaseAddLedger(book, tx);
      const activeDownloads = await this.downloadService.getActiveByBookId(id, tx);
      const event = await this.recordDeletedEvent(id, book, tx);

      const deleted = await this.bookService.delete(id, tx);
      if (!deleted) throw new BookRowVanishedError();

      return { exclusion, releasedAddLedgerRows, event, activeDownloads };
    });
  }

  /** The post-commit half of every side-effect-free arm inside the transaction. */
  private reportCommitted(id: number, committed: CommittedDeletion): void {
    if (committed.exclusion && this.exclusions) {
      this.exclusions.logRecorded(committed.exclusion);
      this.log.info({ bookId: id, exclusionId: committed.exclusion.row.id }, 'Recorded import list exclusion for deleted book');
    }
    if (committed.releasedAddLedgerRows > 0) {
      this.log.info({ bookId: id, removed: committed.releasedAddLedgerRows }, 'Released import list add-ledger rows for deleted book');
    }
    if (committed.event && this.eventHistory) this.eventHistory.logRecorded(committed.event);
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
  private async cancelDownloads(id: number, activeDownloads: DownloadWithBook[]): Promise<void> {
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
  private async recordImportListExclusion(
    book: BookWithAuthor | null,
    tx: DbOrTx,
  ): Promise<ExclusionRecordResult | null> {
    if (!book || !this.exclusions || book.importListId === null) return null;
    return this.exclusions.recordExclusion(
      { title: book.title, asin: book.asin, authorName: book.authors[0]?.name ?? null },
      { importListId: book.importListId, importListName: book.importListName ?? null },
      'deleted',
      tx,
    );
  }

  /**
   * Absorb the add-ledger row the tombstone now stands for, in the same transaction (#2530).
   *
   * Two rows for one book would make the undo page lie: removing the visible one would leave the
   * other still refusing — the invisible permanent block the narrow trigger above exists to avoid.
   * Same trigger as the tombstone, so a manually-added book is untouched.
   */
  private async releaseAddLedger(book: BookWithAuthor | null, tx: DbOrTx): Promise<number> {
    if (!book || !this.exclusions || book.importListId === null) return 0;
    return this.exclusions.removeAdded(
      { title: book.title, asin: book.asin, authorName: book.authors[0]?.name ?? null },
      tx,
    );
  }

  /** The one arm that must not roll the transaction back: awaited so its row commits with the
   * deletion, caught so a failed event write still lets the deletion land. */
  private async recordDeletedEvent(
    id: number,
    book: BookWithAuthor | null,
    tx: DbOrTx,
  ): Promise<BookEventRow | null> {
    if (!book || !this.eventHistory) return null;
    return this.eventHistory.create({
      bookId: id,
      ...snapshotBookForEvent(book),
      eventType: 'deleted',
      source: 'manual',
    }, tx).catch((err: unknown) => {
      this.log.warn({ error: serializeError(err) }, 'Failed to record deleted event');
      return null;
    });
  }
}
