import { readdir, rename, rmdir } from 'node:fs/promises';
import { join, extname, basename, dirname, normalize, resolve, relative } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { renderFilename, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import type { NamingOptions } from '../../core/utils/naming.js';

/** Minimal book shape required by renameFilesWithTemplate. */
export interface RenameableBook {
  title: string;
  seriesName?: string | null;
  seriesPosition?: number | null;
  narrators?: Array<{ name: string }> | null;
  publishedDate?: string | null;
}

/** Extract a 4-digit year from a date string like "2010-11-02" or "2010". */
function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

/**
 * Walk up from bookPath removing empty directories, stopping at libraryRoot.
 * Only runs when bookPath is a normalized descendant of libraryRoot.
 */
export async function cleanEmptyParents(
  bookPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const normalizedRoot = normalize(resolve(libraryRoot));
  const normalizedBook = normalize(resolve(bookPath));

  // Use relative path to verify true ancestry — startsWith('/library') would match '/library2'
  const rel = relative(normalizedRoot, normalizedBook);
  if (!rel || rel.startsWith('..') || resolve(rel) === resolve(normalizedBook)) {
    log.debug({ bookPath, libraryRoot }, 'Book path not under library root, skipping parent cleanup');
    return;
  }

  let current = dirname(normalizedBook);
  while (current !== normalizedRoot && current.length > normalizedRoot.length) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) break;
      await rmdir(current);
      log.debug({ path: current }, 'Removed empty parent directory');
      current = dirname(current);
    } catch {
      break;
    }
  }
}

/**
 * Rename audio files in a directory using the file format template.
 * Returns count of files renamed. Rolls back on failure.
 */
// eslint-disable-next-line complexity -- rename pipeline with rollback, covers all file formats
export async function renameFilesWithTemplate(
  targetPath: string,
  fileFormat: string,
  book: RenameableBook,
  authorName: string | null,
  log: FastifyBaseLogger,
  options?: NamingOptions,
): Promise<number> {
  const entries = await readdir(targetPath, { withFileTypes: true });
  const audioFiles = entries
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort();

  if (audioFiles.length === 0) return 0;

  const author = authorName || 'Unknown Author';
  const primaryNarrator = book.narrators?.[0]?.name;
  const baseTokens: Record<string, string | number | undefined | null> = {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: primaryNarrator || undefined,
    narratorLastFirst: primaryNarrator ? toLastFirst(primaryNarrator) : undefined,
    year: extractYear(book.publishedDate),
  };

  const renames: { from: string; to: string }[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < audioFiles.length; i++) {
    const fileName = audioFiles[i];
    const ext = extname(fileName);
    const tokens = {
      ...baseTokens,
      ...(audioFiles.length > 1 && {
        trackNumber: i + 1,
        trackTotal: audioFiles.length,
        partName: basename(fileName, ext),
      }),
    };
    let newStem = renderFilename(fileFormat, tokens, options);

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
      log.debug({ from, to }, 'Renamed file using template');
    }
  } catch (error: unknown) {
    // Attempt rollback
    log.error({ error, completed: completed.length, total: renames.length }, 'Rename failed mid-operation, attempting rollback');
    for (const { from, to } of completed.reverse()) {
      try {
        await rename(join(targetPath, to), join(targetPath, from));
      } catch (rollbackError: unknown) {
        log.error({ rollbackError, file: to }, 'Rollback failed for file');
      }
    }
    throw error;
  }

  return renames.length;
}
