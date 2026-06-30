import { readdir, rename, rmdir, realpath } from 'node:fs/promises';
import { join, extname, basename, dirname, normalize, resolve, relative, isAbsolute } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { renderFilename, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { compareAudioNames } from '../../core/utils/collect-audio-files.js';
import type { NamingOptions } from '../../core/utils/naming.js';
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

/**
 * Containment decision shared by {@link assertPathInsideLibrary} (lexical relative) and
 * {@link assertRealPathInsideLibrary} (realpath-canonicalized relative): a path is OUTSIDE the
 * root when its already-computed relative path is empty (equals the root), starts with `..`
 * (an upward escape or sibling-prefix attack), or is absolute (cross-drive on Windows). The
 * caller computes `rel` — lexically or via realpath — so this predicate stays agnostic to how
 * resolution happened and the two guards keep their distinct inputs while sharing one decision.
 *
 * NOT for `cleanEmptyParents` or the import-source-outside check: those answer the opposite
 * (must-be-OUTSIDE) question with a different predicate — folding them in would be a wrong-merge.
 */
function isOutsideRoot(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || isAbsolute(rel);
}

/**
 * Throw `PathOutsideLibraryError` unless `bookPath` is a true descendant of `libraryRoot`.
 * Rejects equality, `..` escapes, sibling-prefix attacks, and (on Windows) cross-drive paths.
 */
export function assertPathInsideLibrary(bookPath: string, libraryRoot: string): void {
  const normalizedRoot = normalize(resolve(libraryRoot));
  const normalizedBook = normalize(resolve(bookPath));
  const rel = relative(normalizedRoot, normalizedBook);
  if (isOutsideRoot(rel)) {
    throw new PathOutsideLibraryError(bookPath, libraryRoot);
  }
}

/**
 * Async, symlink-aware containment guard for a DB-sourced path that is about to
 * feed a destructive op (e.g. `renameBook`'s `oldPath`). Runs the lexical
 * `assertPathInsideLibrary` check **first and unconditionally** — a lexical
 * escape is rejected even when the path doesn't exist on disk — then re-runs the
 * `relative`/`isAbsolute` containment on the `realpath`-canonicalized values to
 * catch an in-library symlink whose target escapes the root (mirrors
 * `import-preview.ts`).
 *
 * An in-library path that doesn't exist on disk surfaces as a `realpath` ENOENT,
 * which is **swallowed** — the check returns without error, leaving the caller's
 * own logic to surface the real missing-path cause (preserving today's behavior).
 * A non-ENOENT `realpath` error propagates.
 *
 * Deliberately kept separate from the synchronous `assertPathInsideLibrary`: that
 * helper's call sites pass not-yet-created target paths, on which `realpath`
 * would spuriously ENOENT — so folding realpath into it would break those flows.
 */
export async function assertRealPathInsideLibrary(bookPath: string, libraryRoot: string): Promise<void> {
  // Lexical containment first and unconditional — rejects escapes for a missing path too.
  assertPathInsideLibrary(bookPath, libraryRoot);

  let realRoot: string;
  let realBook: string;
  try {
    realRoot = await realpath(libraryRoot);
    realBook = await realpath(bookPath);
  } catch (error: unknown) {
    // In-library path absent on disk: swallow so the caller surfaces the real cause.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const rel = relative(realRoot, realBook);
  if (isOutsideRoot(rel)) {
    throw new PathOutsideLibraryError(bookPath, libraryRoot);
  }
}

/** Minimal book shape required by renameFilesWithTemplate. */
export interface RenameableBook {
  title: string;
  seriesName?: string | null;
  seriesPosition?: number | null;
  narrators?: Array<{ name: string }> | null;
  publishedDate?: string | null;
  /** Stored edition_label (#1712) — source for the `{edition}` file-naming token. */
  editionLabel?: string | null;
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
 * Number of digits needed to zero-pad sequential ordinals for `count` items.
 * `padWidth(99) === 2`, `padWidth(100) === 3`, `padWidth(1000) === 4`.
 * Mirrors the width logic in `collectMultiDiscFiles` (import-helpers.ts).
 */
export function padWidth(count: number): number {
  return String(count).length;
}

/**
 * Pure planner: list audio files in `targetPath` and compute the `{from, to}[]`
 * filename pairs the apply path would produce, without touching disk.
 *
 * Ordering is filename-based and numeric (via the shared `compareAudioNames`
 * comparator), matching the import-time sort so the import-baked sequential
 * numbering is preserved at rename time — never re-derived from array index over
 * a lexicographically-sorted list, and never from ID3 tags.
 *
 * When the rendered stems do not all disambiguate the book's files (the format
 * carries no per-file token, e.g. `{author} - {title}`, so multiple files render
 * to the same stem), a zero-padded sequential ordinal is appended to *every*
 * file including the first — `<stem> (001)`, `<stem> (002)`, … — in numeric-sort
 * order. Formats that already render unique stems (`{partName}`, `{trackNumber}`)
 * are left untouched.
 *
 * Returned pairs are bare filenames (no path component) to match the apply path's
 * `rename(join(targetPath, from), join(targetPath, to))` call site below.
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
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map(e => e.name)
    .sort(compareAudioNames);

  if (audioFiles.length === 0) return [];

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
    // Stored edition_label (#1712); null/empty renders nothing via stripEmptyWrappers.
    edition: book.editionLabel ?? undefined,
  };

  const isMultiFile = audioFiles.length > 1;

  // Render every stem first (in numeric-sort order). trackNumber follows the
  // sorted position, so once the array is numeric-sorted it is the authoritative
  // play-order ordinal feeding both {trackNumber} renders and the fallback below.
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

  // Forced sequential numbering is keyed off rendered-stem *collisions*, not the
  // absence of {trackNumber}. If any two stems collide (case-insensitive), the
  // format does not disambiguate the book's files — number them all.
  const uniqueStemCount = new Set(stems.map(s => s.toLowerCase())).size;
  const stemsCollide = isMultiFile && uniqueStemCount !== stems.length;
  const width = padWidth(audioFiles.length);

  const renames: { from: string; to: string }[] = [];
  for (let i = 0; i < audioFiles.length; i++) {
    const fileName = audioFiles[i]!;
    const ext = extname(fileName);
    const newStem = stemsCollide
      ? `${stems[i]!} (${String(i + 1).padStart(width, '0')})`
      : stems[i]!;

    const newName = `${newStem}${ext}`;
    if (newName !== fileName) {
      renames.push({ from: fileName, to: newName });
    }
  }

  return renames;
}

/**
 * Rename audio files in a directory using the file format template.
 * Returns count of files renamed. Rolls back on failure.
 */
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

  // Perform renames with rollback tracking
  const completed: { from: string; to: string }[] = [];
  try {
    for (const { from, to } of renames) {
      await rename(join(targetPath, from), join(targetPath, to));
      completed.push({ from, to });
      // Shield rename loop from progress-callback failures — SSE/broadcaster
      // errors should never cause rollback of successfully-renamed files.
      try {
        onProgress?.(completed.length, renames.length);
      } catch (progressError: unknown) {
        log.warn({ error: serializeError(progressError) }, 'onProgress callback threw during rename; continuing');
      }
      log.debug({ from, to }, 'Renamed file using template');
    }
  } catch (error: unknown) {
    // Attempt rollback
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
