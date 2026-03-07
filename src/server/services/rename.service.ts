import { mkdir, rename, cp, rm, stat } from 'node:fs/promises';
import { dirname, normalize, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { buildTargetPath } from './import.service.js';
import { cleanEmptyParents, renameFilesWithTemplate } from '../utils/paths.js';

export interface RenameResult {
  oldPath: string;
  newPath: string;
  message: string;
  filesRenamed: number;
}

export class RenameService {
  constructor(
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
  ) {}

  /** Fire-and-forget event recording. */
  private emitEvent(bookId: number, book: { title: string; author?: { name: string } }, oldPath: string, newPath: string, filesRenamed: number): void {
    this.eventHistory?.create({
      bookId,
      bookTitle: book.title,
      authorName: book.author?.name,
      eventType: 'renamed',
      source: 'manual',
      reason: { oldPath, newPath, filesRenamed },
    }).catch((err) => this.log.warn(err, 'Failed to record renamed event'));
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

    // Build the target path from current metadata
    const authorName = book.author?.name ?? null;
    const targetPath = buildTargetPath(
      librarySettings.path,
      librarySettings.folderFormat,
      book,
      authorName,
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
      );
    }

    // Determine result message
    if (!pathChanged && filesRenamed === 0) {
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

    // Target exists on disk — check if it belongs to a different book
    const allBooks = await this.bookService.getAll();
    const conflicting = allBooks.find(
      (b) => b.id !== bookId && b.path && normalize(resolve(b.path)) === normalize(resolve(targetPath)),
    );

    if (conflicting) {
      throw new RenameError(
        `Target path already belongs to "${conflicting.title}" (book #${conflicting.id})`,
        'CONFLICT',
      );
    }
  }

  /** Move book folder to new location. Handles EXDEV (cross-volume) with copy+delete fallback. */
  private async moveBookFolder(oldPath: string, newPath: string): Promise<void> {
    await mkdir(dirname(newPath), { recursive: true });

    try {
      await rename(oldPath, newPath);
    } catch (error) {
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

export class RenameError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'CONFLICT',
  ) {
    super(message);
    this.name = 'RenameError';
  }
}
