import { readdir, rename, rmdir, realpath } from 'node:fs/promises';
import { join, extname, basename, dirname, normalize, resolve, relative, isAbsolute } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { renderFilename, toLastFirst, toSortTitle, AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/index.js';
import { compareAudioNames, disambiguateStems } from '@core/utils/collect-audio-files.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { extractYear } from './import-helpers.js';
import { serializeError } from './serialize-error.js';


export class PathOutsideLibraryError extends Error {
  readonly code = 'PATH_OUTSIDE_LIBRARY' as const;
  constructor(
    public readonly bookPath: string,
    public readonly libraryRoot: string,
  ) {
    super(`Path "${bookPath}" is not inside library root "${libraryRoot}"`);
    this.name = 'PathOutsideLibraryError';
  }
}

/** Equality, upward escapes, and Windows cross-drive paths are outside the root. */
function isOutsideRoot(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || isAbsolute(rel);
}

/** Require `bookPath` to be a true descendant, not equal to `libraryRoot`. */
export function assertPathInsideLibrary(bookPath: string, libraryRoot: string): void {
  const normalizedRoot = normalize(resolve(libraryRoot));
  const normalizedBook = normalize(resolve(bookPath));
  const rel = relative(normalizedRoot, normalizedBook);
  if (isOutsideRoot(rel)) {
    throw new PathOutsideLibraryError(bookPath, libraryRoot);
  }
}

/**
 * Reject lexical escapes before resolving symlinks. Missing in-library paths pass so the
 * destructive caller can report its own ENOENT; other realpath failures propagate.
 */
export async function assertRealPathInsideLibrary(bookPath: string, libraryRoot: string): Promise<void> {
  assertPathInsideLibrary(bookPath, libraryRoot);

  let realRoot: string;
  let realBook: string;
  try {
    realRoot = await realpath(libraryRoot);
    realBook = await realpath(bookPath);
  } catch (error: unknown) {
    // Let the caller classify a missing in-library path.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const rel = relative(realRoot, realBook);
  if (isOutsideRoot(rel)) {
    throw new PathOutsideLibraryError(bookPath, libraryRoot);
  }
}

/** Symlink-aware containment that propagates ENOENT for serve-time file verification. */
export async function assertRealPathInsideLibraryStrict(bookPath: string, libraryRoot: string): Promise<void> {
  assertPathInsideLibrary(bookPath, libraryRoot);

  const realRoot = await realpath(libraryRoot);
  const realBook = await realpath(bookPath);

  if (isOutsideRoot(relative(realRoot, realBook))) {
    throw new PathOutsideLibraryError(bookPath, libraryRoot);
  }
}

export interface RenameableBook {
  title: string;
  seriesName?: string | null;
  seriesPosition?: number | null;
  narrators?: Array<{ name: string }> | null;
  publishedDate?: string | null;
  /** Source for the `{edition}` token. */
  editionLabel?: string | null;
}

/** Remove empty ancestors up to, but never including, `libraryRoot`. */
export async function cleanEmptyParents(
  bookPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const normalizedRoot = normalize(resolve(libraryRoot));
  const normalizedBook = normalize(resolve(bookPath));

  // startsWith would misclassify sibling prefixes such as `/library2`.
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

export function padWidth(count: number): number {
  return String(count).length;
}

export interface BookNamingContext {
  bookTokens?: Record<string, string | number | undefined | null>;
  namingOptions?: NamingOptions;
  fileFormat?: string;
}

/** Omit empty formats so audio-processor retains its filename fallback. */
export function buildNamingContext(
  book: RenameableBook | null | undefined,
  authorName: string | null,
  fileFormat?: string,
  namingOptions?: NamingOptions,
): BookNamingContext {
  if (!book) return {};
  return {
    bookTokens: buildBookNameTokens(book, authorName),
    ...(namingOptions && { namingOptions }),
    ...(fileFormat ? { fileFormat } : {}),
  };
}

/** Shared book-level token mapping for rename and merge; `??` preserves position zero. */
export function buildBookNameTokens(
  book: RenameableBook,
  authorName: string | null,
): Record<string, string | number | undefined | null> {
  const author = authorName || 'Unknown Author';
  const primaryNarrator = book.narrators?.[0]?.name;
  return {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: primaryNarrator || undefined,
    narratorLastFirst: primaryNarrator ? toLastFirst(primaryNarrator) : undefined,
    year: extractYear(book.publishedDate),
    edition: book.editionLabel ?? undefined,
  };
}

/**
 * Plan bare-filename renames in numeric play order. Colliding rendered stems receive
 * zero-padded ordinals on every file; already-unique stems remain unchanged.
 */
export async function planFileRenames(
  targetPath: string,
  fileFormat: string,
  book: RenameableBook,
  authorName: string | null,
  options?: NamingOptions,
): Promise<{ from: string; to: string }[]> {
  const entries = await readdir(targetPath, { withFileTypes: true });
  const audioFiles = entries
    .filter(e => e.isFile() && !isHiddenName(e.name) && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort(compareAudioNames);

  if (audioFiles.length === 0) return [];

  const baseTokens = buildBookNameTokens(book, authorName);

  const isMultiFile = audioFiles.length > 1;

  // Numeric sort defines the authoritative play-order ordinal.
  const stems = audioFiles.map((fileName, i) => {
    const ext = extname(fileName);
    const tokens = {
      ...baseTokens,
      ...(isMultiFile && {
        trackNumber: i + 1,
        trackTotal: audioFiles.length,
        partName: basename(fileName, ext),
      }),
    };
    return renderFilename(fileFormat, tokens, options);
  });

  // Collisions, not token presence, trigger sequential suffixes.
  const finalStems = disambiguateStems(stems);

  const renames: { from: string; to: string }[] = [];
  for (let i = 0; i < audioFiles.length; i++) {
    const fileName = audioFiles[i]!;
    const ext = extname(fileName);
    const newName = `${finalStems[i]!}${ext}`;
    if (newName !== fileName) {
      renames.push({ from: fileName, to: newName });
    }
  }

  return renames;
}

/** Rename planned audio files and roll completed renames back on failure. */
export async function renameFilesWithTemplate(
  targetPath: string,
  fileFormat: string,
  book: RenameableBook,
  authorName: string | null,
  log: FastifyBaseLogger,
  options?: NamingOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  const renames = await planFileRenames(targetPath, fileFormat, book, authorName, options);
  if (renames.length === 0) return 0;

  const completed: { from: string; to: string }[] = [];
  try {
    for (const { from, to } of renames) {
      await rename(join(targetPath, from), join(targetPath, to));
      completed.push({ from, to });
      // Shield successful renames from progress-callback failures and rollback.
      try {
        onProgress?.(completed.length, renames.length);
      } catch (progressError: unknown) {
        log.warn({ error: serializeError(progressError) }, 'onProgress callback threw during rename; continuing');
      }
      log.debug({ from, to }, 'Renamed file using template');
    }
  } catch (error: unknown) {
    log.error({ error: serializeError(error), completed: completed.length, total: renames.length }, 'Rename failed mid-operation, attempting rollback');
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
