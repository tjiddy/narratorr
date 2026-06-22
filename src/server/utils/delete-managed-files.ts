import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import { serializeError } from './serialize-error.js';

/**
 * Three-bucket summary of a managed-file sweep:
 * - `deletedManaged`  — managed files (audio + the narratorr cover sidecar) successfully removed.
 * - `preservedForeign` — foreign files intentionally LEFT in place. NOT a failure.
 * - `failedManaged`   — managed files whose `rm` rejected (EPERM/EBUSY/…). Recorded per-file;
 *                       the helper never throws on these, so one locked file can't abort the
 *                       whole sweep or leave the folder half-judged. The CALLER decides fatality.
 *
 * All entries are absolute file paths.
 */
export interface DeleteManagedFilesResult {
  deletedManaged: string[];
  preservedForeign: string[];
  failedManaged: string[];
}

export interface DeleteManagedFilesOptions {
  /**
   * Assert `bookPath` is a true descendant of `libraryRoot` before deleting (default: true).
   * Library-rooted sites (delete, rejection, cleanupOldBookPath, handleImportFailure) keep this
   * ON. The import-move source-cleanup site deletes the download folder, which is intentionally
   * OUTSIDE the library, and passes `false` — classification still protects foreign files there.
   */
  assertInsideLibrary?: boolean;
}

/**
 * A managed file is one narratorr itself owns and may delete: an audio file (by the canonical
 * {@link AUDIO_EXTENSIONS} set — never re-listed here) or the narratorr-generated cover sidecar
 * ({@link COVER_FILE_REGEX}). Matching is case-insensitive. Everything else (e-books, PDFs, NFOs,
 * subtitles, user images under non-cover names) is FOREIGN and preserved.
 */
function isManagedFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(name).toLowerCase()) || COVER_FILE_REGEX.test(name);
}

/** Attempt to delete one managed file, recording success/failure; never throws. */
async function deleteOneManaged(filePath: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  try {
    // `force: true` suppresses ENOENT, so a missing file is a no-op — not a failure.
    await rm(filePath, { force: true });
    result.deletedManaged.push(filePath);
  } catch (error: unknown) {
    result.failedManaged.push(filePath);
    log.warn({ file: filePath, error: serializeError(error) }, 'Failed to delete managed book file — preserving folder');
  }
}

/** Remove `dir` only when it is now empty; an ENOTEMPTY (foreign files remain) leaves it in place. */
async function rmdirIfEmpty(dir: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTEMPTY/EEXIST → foreign files remain (intended); ENOENT → already gone. All fine.
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return;
    log.warn({ dir, error: serializeError(error) }, 'Failed to remove emptied book folder');
  }
}

/** Recursively classify + delete inside a directory, removing now-empty subdirectories bottom-up. */
async function sweepDir(dir: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await sweepDir(fullPath, result, log);
    } else if (isManagedFile(entry.name)) {
      await deleteOneManaged(fullPath, result, log);
    } else {
      result.preservedForeign.push(fullPath);
    }
  }
  await rmdirIfEmpty(dir, log);
}

/**
 * Delete only the files narratorr manages (audio + its cover sidecar) under `bookPath`,
 * preserving every foreign file (e-books, PDFs, subtitles, user images). Recurses into
 * subdirectories (multi-disc audio lives in disc subfolders) and `rmdir`s a folder ONLY when it
 * ends up empty — a folder still holding a foreign file is left in place.
 *
 * `bookPath` may be a directory OR a single file (manual import can pass a file-path source).
 * A missing path is a no-op (empty result), matching the old `rm(..., { force: true })` ENOENT
 * suppression.
 *
 * The single classification home for "managed vs foreign" (#1589) — reused by the book delete,
 * wrong-release rejection, import-move populated-target cleanup, `cleanupOldBookPath`, and the
 * `handleImportFailure` pre-commit target cleanup. Per-file `rm` failures are recorded in
 * `failedManaged` and never thrown; the only throw is {@link PathOutsideLibraryError} when the
 * containment guard is enabled.
 */
export async function deleteManagedBookFiles(
  bookPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
  options?: DeleteManagedFilesOptions,
): Promise<DeleteManagedFilesResult> {
  const assertInside = options?.assertInsideLibrary ?? true;
  if (assertInside) {
    try {
      assertPathInsideLibrary(bookPath, libraryRoot);
    } catch (error: unknown) {
      if (error instanceof PathOutsideLibraryError) {
        log.warn({ bookPath, libraryRoot }, 'Refusing to delete book path outside library root');
      }
      throw error;
    }
  }

  const result: DeleteManagedFilesResult = { deletedManaged: [], preservedForeign: [], failedManaged: [] };

  let stats;
  try {
    stats = await stat(bookPath);
  } catch (error: unknown) {
    // A missing path is a no-op (matches the prior `force: true` ENOENT suppression).
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  if (stats.isDirectory()) {
    await sweepDir(bookPath, result, log);
  } else if (isManagedFile(basename(bookPath))) {
    await deleteOneManaged(bookPath, result, log);
  } else {
    result.preservedForeign.push(bookPath);
  }

  return result;
}
