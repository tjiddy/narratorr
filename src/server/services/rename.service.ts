import { mkdir, rename, cp } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { ConnectorService } from './connector.service.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { assertRealPathInsideLibrary, cleanEmptyParents, planFileRenames, renameFilesWithTemplate } from '../utils/paths.js';
import { toNamingOptions } from '@core/utils/naming.js';
import { removeTree } from '@core/utils/remove-tree.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { computeFolderTarget, toLibraryRelative } from '../utils/rename-target.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { sidecarLockKey } from '../utils/opf-writer.js';
import { withPathWriteLock, withPathWriteLocks } from '../utils/path-write-lock.js';
import { claimLockKey } from '../utils/claim-lock.js';
import { withBookAdmissionLock } from './book-admission.js';
import { beginRootCommit } from './library-root-gate.js';
import { canonicalPath } from '../utils/path-identity.js';
import { assertNoOtherOwner, classifyTargetOccupancy, clearVerifiedEmptyTarget, type TargetOccupancy } from '../utils/rename-target-guard.js';
import { RenameError } from '../utils/rename-error.js';
import { serializeError } from '../utils/serialize-error.js';

export { RenameError } from '../utils/rename-error.js';
export type { RenameErrorDetails } from '../utils/rename-error.js';


export interface RenameResult {
  oldPath: string;
  newPath: string;
  message: string;
  filesRenamed: number;
}

/** Structural change predicate shared by callers; never couple behavior to the display message. */
export function didRenameChangeAnything(result: RenameResult): boolean {
  return result.newPath !== result.oldPath || result.filesRenamed > 0;
}

export interface RenamePlan {
  libraryRoot: string;
  folderFormat: string;
  fileFormat: string;
  folderMove: { from: string; to: string } | null;
  fileRenames: { from: string; to: string }[];
}

export class RenameService {
  constructor(
    private db: Db,
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private connectorService?: ConnectorService,
  ) {}

  private enqueueConnectorRefresh(bookId: number, title: string, authorName: string | null, libraryPath: string): void {
    if (!this.connectorService) return;
    fireAndForget(
      this.connectorService.notifyRefresh('rename', [{ bookId, title, authorName, libraryPath }]),
      this.log,
      'Failed to enqueue connector refresh on rename',
    );
  }

  private emitEvent(bookId: number, book: { title: string; authors?: Array<{ name: string }> }, oldPath: string, newPath: string, filesRenamed: number): void {
    this.eventHistory?.create({
      bookId,
      ...snapshotBookForEvent(book),
      eventType: 'renamed',
      source: 'manual',
      reason: { oldPath, newPath, filesRenamed },
    }).catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record renamed event'));
  }

  /** Pure plan shared by preview and apply; performs no disk or DB writes. */
  async planRename(bookId: number): Promise<RenamePlan> {
    const book = await this.bookService.getById(bookId);
    if (!book) {
      throw new RenameError('Book not found', 'NOT_FOUND');
    }
    if (!book.path) {
      throw new RenameError('Book has no path — not imported yet', 'NO_PATH');
    }

    const librarySettings = await this.settingsService.get('library');
    const namingOptions = toNamingOptions(librarySettings);

    const authorName = book.authors?.[0]?.name ?? null;
    const { targetPath, changed: pathChanged } = computeFolderTarget(
      { ...book, path: book.path },
      authorName,
      librarySettings,
      namingOptions,
    );

    const oldPath = book.path;

    // Advisory only, and deliberately lock-free: the apply path re-checks under the lock, which is
    // the check that decides. This is what lets the modal warn before the operator commits.
    if (pathChanged) {
      await assertNoOtherOwner(this.db, targetPath, bookId);
      await classifyTargetOccupancy(targetPath);
    }

    const folderMove = pathChanged
      ? {
          from: toLibraryRelative(oldPath, librarySettings.path),
          to: toLibraryRelative(targetPath, librarySettings.path),
        }
      : null;

    let fileRenames: { from: string; to: string }[] = [];
    if (librarySettings.fileFormat) {
      // Preview reads before the folder move, but the move cannot change bare-filename pairs.
      fileRenames = await planFileRenames(
        oldPath,
        librarySettings.fileFormat,
        book,
        authorName,
        namingOptions,
      );
    }

    return {
      libraryRoot: librarySettings.path,
      folderFormat: librarySettings.folderFormat,
      fileFormat: librarySettings.fileFormat,
      folderMove,
      fileRenames,
    };
  }

  /**
   * Admission first, then the claim keys — the outermost-to-innermost order every mutator shares.
   * Without the outer acquisition the claim keys exclude only the four claim-protocol participants,
   * so a merge, import, retag or cover write would still land in a folder this rename is moving.
   *
   * The claim span still opens BEFORE `recoverInterruptedCommit`, not at the conflict check:
   * recovery is not a read — with no marker present it recursively deletes the target's staging and
   * backup siblings, and with one present it restores a backup into the target.
   *
   * Source and target are taken in one sorted acquisition, so two renames with mirrored
   * source/target cannot deadlock.
   */
  async renameBook(bookId: number): Promise<RenameResult> {
    return withBookAdmissionLock(bookId, () => this.renameWithinAdmissionLock(bookId));
  }

  /** Caller must hold the admission lock for `bookId`. */
  private async renameWithinAdmissionLock(bookId: number): Promise<RenameResult> {
    // Rename derives its target from the library root, so it registers as a root-dependent commit
    // and takes the canonical root from the gate rather than reading settings for itself.
    const rootCommit = await beginRootCommit(this.settingsService);
    try {
      const ctx = await this.planApply(bookId, rootCommit.library);
      const keys = ctx.pathChanged
        ? [claimLockKey(ctx.oldPath), claimLockKey(ctx.targetPath)]
        : [claimLockKey(ctx.oldPath)];
      return await withPathWriteLocks(keys, () => this.applyRename(ctx));
    } finally {
      rootCommit.release();
    }
  }

  private async planApply(bookId: number, librarySettings: AppSettings['library']): Promise<ApplyContext> {
    const book = await this.bookService.getById(bookId);
    if (!book) {
      throw new RenameError('Book not found', 'NOT_FOUND');
    }
    if (!book.path) {
      throw new RenameError('Book has no path — not imported yet', 'NO_PATH');
    }

    const namingOptions = toNamingOptions(librarySettings);
    const authorName = book.authors?.[0]?.name ?? null;
    const { targetPath, changed: pathChanged } = computeFolderTarget(
      { ...book, path: book.path },
      authorName,
      librarySettings,
      namingOptions,
    );

    return { bookId, book, librarySettings, namingOptions, authorName, oldPath: book.path, targetPath, pathChanged };
  }

  private async applyRename(ctx: ApplyContext): Promise<RenameResult> {
    const { bookId, book, librarySettings, namingOptions, authorName, oldPath, targetPath, pathChanged } = ctx;

    // The row was read before the lock — that read is what produced the plan and therefore the key
    // — so a queued rename can wake behind a completed rename, deletion or rejection.
    await this.assertPlanStillFresh(bookId, oldPath);

    // Reject corrupt/escaped paths before recovery, moves, EXDEV deletion, or in-place renames.
    // This is realpath-aware for symlinks but leaves missing paths to the existing recovery surface.
    await assertRealPathInsideLibrary(oldPath, librarySettings.path);

    // Recover commit-pending state before any mutation; moving can orphan its marker and an
    // in-place rename can re-arm it. Recovery failure aborts with disk state intact.
    await recoverInterruptedCommit(oldPath, librarySettings.path, this.log);

    if (pathChanged) {
      await assertNoOtherOwner(this.db, targetPath, bookId);
      const occupancy = await classifyTargetOccupancy(targetPath);
      await this.moveBookFolder(oldPath, targetPath, occupancy);
      // Persist the move before file renames so a rename failure cannot desynchronize book.path.
      await this.bookService.update(bookId, { path: targetPath });
    }

    const currentPath = pathChanged ? targetPath : oldPath;

    let filesRenamed = 0;
    if (librarySettings.fileFormat) {
      filesRenamed = await renameFilesWithTemplate(
        currentPath,
        librarySettings.fileFormat,
        book,
        authorName,
        this.log,
        namingOptions,
      );
    }

    if (!pathChanged && filesRenamed === 0) {
      this.log.debug({ bookId }, 'Book already organized — skipping rename');
      return { oldPath, newPath: oldPath, message: 'Already organized', filesRenamed: 0 };
    }

    if (pathChanged) {
      await cleanEmptyParents(oldPath, librarySettings.path, this.log);
    }

    this.log.info({ bookId, oldPath, newPath: currentPath, filesRenamed }, 'Book renamed');

    this.emitEvent(bookId, book, oldPath, currentPath, filesRenamed);

    this.enqueueConnectorRefresh(bookId, book.title, authorName, currentPath);

    return {
      oldPath,
      newPath: currentPath,
      message: pathChanged ? `Moved from ${oldPath} to ${currentPath}` : `Renamed ${filesRenamed} file(s)`,
      filesRenamed,
    };
  }

  /**
   * Every arm aborts with no disk and no DB mutation. The three codes are deliberately distinct:
   * a deleted book keeps the pre-lock read's 404 and a pathless one its 400, so `STALE_PATH` means
   * only "the plan was built against a path this row no longer holds". Rename does not re-acquire
   * on the new path — a changed row means a changed plan, and the operator re-runs it.
   */
  private async assertPlanStillFresh(bookId: number, oldPath: string): Promise<void> {
    const fresh = await this.bookService.getById(bookId);
    if (!fresh) {
      throw new RenameError('Book not found', 'NOT_FOUND');
    }
    if (!fresh.path) {
      throw new RenameError('Book has no path — not imported yet', 'NO_PATH');
    }
    if (canonicalPath(fresh.path) !== canonicalPath(oldPath)) {
      throw new RenameError(
        `Book path changed to "${fresh.path}" while the rename was queued`,
        'STALE_PATH',
      );
    }
  }

  private async moveBookFolder(oldPath: string, newPath: string, occupancy: TargetOccupancy): Promise<void> {
    // POSIX rename(2) replaces an existing empty directory and Windows' MoveFileEx does not, so
    // clear it here — inside the same held claim — rather than depending on the platform.
    if (occupancy === 'empty-directory') await clearVerifiedEmptyTarget(newPath);

    await mkdir(dirname(newPath), { recursive: true });

    try {
      await rename(oldPath, newPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        this.log.info({ oldPath, newPath }, 'Cross-volume move — falling back to copy+delete');
        await mkdir(newPath, { recursive: true });
        // `rename(2)` above moves metadata.opf and metadata.opf.bak together or not at all; this
        // fallback walks entries one at a time and can copy the backup at generation N−1, let the
        // sidecar writer advance both, copy the sidecar at N+1, then delete the only copy of N.
        // Hold the OLD sidecar key across the whole reproduction — released before the books.path
        // commit, so a queued writer targets the vacated folder and fails rather than splitting it.
        await withPathWriteLock(sidecarLockKey(oldPath), async () => {
          await cp(oldPath, newPath, { recursive: true });
          // removeTree's retry extends this hold by at most 600 ms of backoff plus three
          // extra walks, whatever the folder's depth — its own bound, not fs.rm's. The key
          // is one book's sidecar, so only another writer to THIS book waits.
          await removeTree(oldPath);
        });
      } else {
        throw error;
      }
    }
  }

}

/** The plan built from the pre-lock row read, re-verified once the claim keys are held. */
interface ApplyContext {
  bookId: number;
  book: NonNullable<Awaited<ReturnType<BookService['getById']>>>;
  librarySettings: AppSettings['library'];
  namingOptions: ReturnType<typeof toNamingOptions>;
  authorName: string | null;
  oldPath: string;
  targetPath: string;
  pathChanged: boolean;
}
