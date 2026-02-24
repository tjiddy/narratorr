import { mkdir, readdir, rename, rmdir, cp, rm, stat } from 'node:fs/promises';
import { join, extname, basename, dirname, normalize, resolve, relative } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { renderFilename, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '@narratorr/core/utils';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import { buildTargetPath } from './import.service.js';

export interface RenameResult {
  oldPath: string;
  newPath: string;
  message: string;
  filesRenamed: number;
}

/** Extract a 4-digit year from a date string. */
function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

export class RenameService {
  constructor(
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
  ) {}

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
      filesRenamed = await this.renameFilesWithTemplate(
        currentPath,
        librarySettings.fileFormat,
        book,
        authorName,
      );
    }

    // Determine result message
    if (!pathChanged && filesRenamed === 0) {
      return { oldPath, newPath: oldPath, message: 'Already organized', filesRenamed: 0 };
    }

    // Clean up empty parent directories after successful move
    if (pathChanged) {
      await this.cleanEmptyParents(oldPath, librarySettings.path);
    }

    this.log.info({ bookId, oldPath, newPath: currentPath, filesRenamed }, 'Book renamed');

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

  /** Rename audio files in a directory using the file format template. Returns count of files renamed. */
  async renameFilesWithTemplate(
    targetPath: string,
    fileFormat: string,
    book: BookWithAuthor,
    authorName: string | null,
  ): Promise<number> {
    const entries = await readdir(targetPath, { withFileTypes: true });
    const audioFiles = entries
      .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map(e => e.name)
      .sort();

    if (audioFiles.length === 0) return 0;

    const author = authorName || 'Unknown Author';
    const baseTokens: Record<string, string | number | undefined | null> = {
      author,
      authorLastFirst: toLastFirst(author),
      title: book.title,
      titleSort: toSortTitle(book.title),
      series: book.seriesName || undefined,
      seriesPosition: book.seriesPosition ?? undefined,
      narrator: book.narrator || undefined,
      narratorLastFirst: book.narrator ? toLastFirst(book.narrator) : undefined,
      year: extractYear(book.publishedDate),
    };

    const renames: { from: string; to: string }[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < audioFiles.length; i++) {
      const fileName = audioFiles[i];
      const ext = extname(fileName);
      const tokens = {
        ...baseTokens,
        trackNumber: i + 1,
        trackTotal: audioFiles.length,
        partName: basename(fileName, ext),
      };
      let newStem = renderFilename(fileFormat, tokens);

      if (seen.has(newStem.toLowerCase())) {
        newStem = `${newStem} (${i + 1})`;
      }
      seen.add(newStem.toLowerCase());

      const newName = `${newStem}${ext}`;
      if (newName !== fileName) {
        renames.push({ from: fileName, to: newName });
      }
    }

    // Perform renames with rollback tracking
    const completed: { from: string; to: string }[] = [];
    try {
      for (const { from, to } of renames) {
        await rename(join(targetPath, from), join(targetPath, to));
        completed.push({ from, to });
        this.log.debug({ from, to }, 'Renamed file using template');
      }
    } catch (error) {
      // Attempt rollback
      this.log.error({ error, completed: completed.length, total: renames.length }, 'Rename failed mid-operation, attempting rollback');
      for (const { from, to } of completed.reverse()) {
        try {
          await rename(join(targetPath, to), join(targetPath, from));
        } catch (rollbackError) {
          this.log.error({ rollbackError, file: to }, 'Rollback failed for file');
        }
      }
      throw error;
    }

    return renames.length;
  }

  /**
   * Walk up from bookPath removing empty directories, stopping at libraryRoot.
   * Only runs when bookPath is a normalized descendant of libraryRoot.
   */
  private async cleanEmptyParents(bookPath: string, libraryRoot: string): Promise<void> {
    const normalizedRoot = normalize(resolve(libraryRoot));
    const normalizedBook = normalize(resolve(bookPath));

    const rel = relative(normalizedRoot, normalizedBook);
    if (!rel || rel.startsWith('..') || resolve(rel) === resolve(normalizedBook)) {
      this.log.debug({ bookPath, libraryRoot }, 'Book path not under library root, skipping parent cleanup');
      return;
    }

    let current = dirname(normalizedBook);
    while (current !== normalizedRoot && current.length > normalizedRoot.length) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) break;
        await rmdir(current);
        this.log.debug({ path: current }, 'Removed empty parent directory');
        current = dirname(current);
      } catch {
        break;
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
