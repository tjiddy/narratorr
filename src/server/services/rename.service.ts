import { mkdir, rename, cp, rm, stat } from 'node:fs/promises';
import { dirname, normalize, resolve } from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { ConnectorService } from './connector.service.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { assertRealPathInsideLibrary, cleanEmptyParents, planFileRenames, renameFilesWithTemplate } from '../utils/paths.js';
import { toNamingOptions } from '@core/utils/naming.js';
import { computeFolderTarget, toLibraryRelative } from '../utils/rename-target.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { serializeError } from '../utils/serialize-error.js';


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

    if (pathChanged) {
      await this.checkConflict(targetPath, bookId);
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

  async renameBook(bookId: number): Promise<RenameResult> {
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

    // Reject corrupt/escaped paths before recovery, moves, EXDEV deletion, or in-place renames.
    // This is realpath-aware for symlinks but leaves missing paths to the existing recovery surface.
    await assertRealPathInsideLibrary(oldPath, librarySettings.path);

    // Recover commit-pending state before any mutation; moving can orphan its marker and an
    // in-place rename can re-arm it. Recovery failure aborts with disk state intact.
    await recoverInterruptedCommit(oldPath, librarySettings.path, this.log);

    if (pathChanged) {
      await this.checkConflict(targetPath, bookId);
    }

    if (pathChanged) {
      await this.moveBookFolder(oldPath, targetPath);
    }

    const currentPath = pathChanged ? targetPath : oldPath;

    // Persist the folder move before file renames so a rename failure cannot desynchronize book.path.
    if (pathChanged) {
      await this.bookService.update(bookId, { path: targetPath });
    }

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

  private async checkConflict(targetPath: string, bookId: number): Promise<void> {
    let exists = false;
    try {
      await stat(targetPath);
      exists = true;
    } catch {
      // A missing target cannot conflict.
    }

    if (!exists) return;

    const normalizedTarget = normalize(resolve(targetPath));
    const conflicting = await this.db
      .select({ id: books.id, title: books.title, path: books.path })
      .from(books)
      .where(and(
        ne(books.id, bookId),
        eq(books.path, normalizedTarget),
      ))
      .limit(1);

    if (conflicting.length > 0) {
      const other = conflicting[0]!;
      throw new RenameError(
        `Target path already belongs to "${other.title}" (book #${other.id})`,
        'CONFLICT',
        { conflictingBook: { id: other.id, title: other.title } },
      );
    }
  }

  private async moveBookFolder(oldPath: string, newPath: string): Promise<void> {
    await mkdir(dirname(newPath), { recursive: true });

    try {
      await rename(oldPath, newPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        this.log.info({ oldPath, newPath }, 'Cross-volume move — falling back to copy+delete');
        await mkdir(newPath, { recursive: true });
        await cp(oldPath, newPath, { recursive: true });
        await rm(oldPath, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  }

}

export interface RenameErrorDetails {
  conflictingBook: { id: number; title: string };
}

export class RenameError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'CONFLICT',
    public details?: RenameErrorDetails,
  ) {
    super(message);
    this.name = 'RenameError';
  }
}
