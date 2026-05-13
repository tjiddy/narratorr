import { mkdir, rename, cp, rm, stat } from 'node:fs/promises';
import { dirname, normalize, resolve, relative } from 'node:path';
import { and, eq, ne } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { cleanEmptyParents, planFileRenames, renameFilesWithTemplate } from '../utils/paths.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { serializeError } from '../utils/serialize-error.js';


export interface RenameResult {
  oldPath: string;
  newPath: string;
  message: string;
  filesRenamed: number;
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
  ) {}

  /** Fire-and-forget event recording. */
  private emitEvent(bookId: number, book: { title: string; authors?: Array<{ name: string }> }, oldPath: string, newPath: string, filesRenamed: number): void {
    this.eventHistory?.create({
      bookId,
      ...snapshotBookForEvent(book),
      eventType: 'renamed',
      source: 'manual',
      reason: { oldPath, newPath, filesRenamed },
    }).catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record renamed event'));
  }

  /**
   * Pure planner — returns the folder move + file renames that `renameBook` would
   * apply, without touching disk or DB. Used by `GET /api/books/:id/rename/preview`
   * and internally by `renameBook` to keep preview/apply in lockstep.
   */
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
    const targetPath = buildTargetPath(
      librarySettings.path,
      librarySettings.folderFormat,
      book,
      authorName,
      namingOptions,
    );

    const oldPath = book.path;
    const pathChanged = normalize(resolve(oldPath)) !== normalize(resolve(targetPath));

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
      // Preview reads the source folder (book.path); apply reads the same files
      // after the folder move. The folder move doesn't add/remove files, so the
      // bare-filename pairs match either way.
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
   * Rename/reorganize a book's files to match current metadata + format templates.
   * Moves folder (if path changed) and renames files (if file format applies).
   */
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

    // Build the target path from current metadata
    const authorName = book.authors?.[0]?.name ?? null;
    const targetPath = buildTargetPath(
      librarySettings.path,
      librarySettings.folderFormat,
      book,
      authorName,
      namingOptions,
    );

    const oldPath = book.path;
    const pathChanged = normalize(resolve(oldPath)) !== normalize(resolve(targetPath));

    // Check for conflicts: another book at the target path
    if (pathChanged) {
      await this.checkConflict(targetPath, bookId);
    }

    // Move folder if path changed
    if (pathChanged) {
      await this.moveBookFolder(oldPath, targetPath);
    }

    const currentPath = pathChanged ? targetPath : oldPath;

    // Update book.path in DB immediately after folder move so it stays in sync
    // even if file rename below fails
    if (pathChanged) {
      await this.bookService.update(bookId, { path: targetPath });
    }

    // Rename files using file format template
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

    // Determine result message
    if (!pathChanged && filesRenamed === 0) {
      this.log.debug({ bookId }, 'Book already organized — skipping rename');
      return { oldPath, newPath: oldPath, message: 'Already organized', filesRenamed: 0 };
    }

    // Clean up empty parent directories after successful move
    if (pathChanged) {
      await cleanEmptyParents(oldPath, librarySettings.path, this.log);
    }

    this.log.info({ bookId, oldPath, newPath: currentPath, filesRenamed }, 'Book renamed');

    this.emitEvent(bookId, book, oldPath, currentPath, filesRenamed);

    return {
      oldPath,
      newPath: currentPath,
      message: pathChanged ? `Moved from ${oldPath} to ${currentPath}` : `Renamed ${filesRenamed} file(s)`,
      filesRenamed,
    };
  }

  /** Check if target path belongs to a different book. */
  private async checkConflict(targetPath: string, bookId: number): Promise<void> {
    let exists = false;
    try {
      await stat(targetPath);
      exists = true;
    } catch {
      // Target doesn't exist — no conflict
    }

    if (!exists) return;

    // Target exists on disk — check if it belongs to a different book (targeted query)
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

  /** Move book folder to new location. Handles EXDEV (cross-volume) with copy+delete fallback. */
  private async moveBookFolder(oldPath: string, newPath: string): Promise<void> {
    await mkdir(dirname(newPath), { recursive: true });

    try {
      await rename(oldPath, newPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        // Cross-volume: copy then delete
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

/**
 * Convert an absolute folder path to its library-root-relative form, using
 * POSIX separators for parity with how paths are stored and rendered elsewhere.
 * Falls back to the original path if it's not actually inside the library root.
 */
function toLibraryRelative(absPath: string, libraryRoot: string): string {
  const rel = relative(normalize(resolve(libraryRoot)), normalize(resolve(absPath)));
  if (!rel || rel.startsWith('..')) return absPath;
  return rel.split('\\').join('/');
}
