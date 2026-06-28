import { readdir, readFile, rm, rmdir, lstat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { OPF_FILE_REGEX, hasNarratorrMarker } from '../../core/utils/opf-regex.js';
import { assertRealPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
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
   * Assert `bookPath` is a true descendant of `libraryRoot` before deleting (default: true),
   * using the symlink-aware {@link assertRealPathInsideLibrary} so an in-library symlink whose
   * realpath escapes the root is rejected (#1591). The guarded-mode site is the book delete
   * (`book.service.ts`). `cleanupOldBookPath` and `handleImportFailure` pass `false` and run the
   * same realpath pre-assert externally; the import-move source-cleanup sites delete the download
   * folder, which is intentionally OUTSIDE the library, and pass `false` with no pre-assert.
   * Classification still protects foreign files in every mode.
   */
  assertInsideLibrary?: boolean;
}

/**
 * A managed file is one narratorr itself owns and may delete: an audio file (by the canonical
 * {@link AUDIO_EXTENSIONS} set — never re-listed here) or the narratorr-generated cover sidecar
 * ({@link COVER_FILE_REGEX}). Matching is case-insensitive. Everything else (e-books, PDFs, NFOs,
 * subtitles, user images under non-cover names) is FOREIGN and preserved.
 *
 * Audio is managed at ANY depth (multi-disc audio lives in disc subfolders). The cover sidecar is
 * managed ONLY at the book-folder root (`atRoot`): narratorr writes it only at the top level
 * (`cover-upload.ts`/`cover-download.ts`), so a nested `Disc 1/cover.jpg` is user/per-disc/foreign —
 * and must be preserved (#1591).
 *
 * NOTE: the root `metadata.opf` sidecar is deliberately NOT classified here. Unlike `cover.*`,
 * `metadata.opf` is the standard ABS/Calibre filename, so ownership can't be proven by name — it
 * requires reading the file for the narratorr provenance marker. That content-aware (async) check
 * lives in {@link classifyRootOpf}; this fast path stays content-free (#1674).
 */
function isManagedFile(name: string, atRoot: boolean): boolean {
  if (AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) return true;
  return atRoot && COVER_FILE_REGEX.test(name);
}

/**
 * Content-aware classification for a root `metadata.opf` (#1674): delete it as managed ONLY when it
 * carries the narratorr provenance marker; otherwise preserve it as a foreign ABS/Calibre sidecar.
 * Fails safe — any read error (EACCES/EISDIR for a directory named `metadata.opf`/…) preserves the
 * entry as foreign and warns: narratorr never deletes an OPF it could not confirm it owns. Because
 * an EISDIR-failing directory is preserved (not recursed), this MUST run before directory recursion
 * at the call site.
 */
async function classifyRootOpf(fullPath: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch (error: unknown) {
    result.preservedForeign.push(fullPath);
    log.warn({ file: fullPath, error: serializeError(error) }, 'Could not read root metadata.opf to confirm narratorr ownership — preserving as foreign');
    return;
  }
  if (hasNarratorrMarker(content)) {
    await deleteOneManaged(fullPath, result, log);
  } else {
    result.preservedForeign.push(fullPath);
  }
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

/**
 * Recursively classify + delete inside a directory, removing now-empty subdirectories bottom-up.
 * `rootDir` is the original `bookPath`; cover classification is root-only (see {@link isManagedFile}).
 * A symlinked subfolder reads as a non-directory `Dirent` (readdir does not follow it), so it falls
 * through to the foreign branch and is never recursed — its target's files are left untouched (#1591).
 */
async function sweepDir(dir: string, rootDir: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  const atRoot = dir === rootDir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (atRoot && OPF_FILE_REGEX.test(entry.name)) {
      // Content-aware: ownership of a root metadata.opf is decided by the marker, not the name.
      // Runs BEFORE the directory branch so a directory named `metadata.opf` is preserved (EISDIR
      // fail-safe), never recursed/removed (#1674).
      await classifyRootOpf(fullPath, result, log);
    } else if (entry.isDirectory()) {
      await sweepDir(fullPath, rootDir, result, log);
    } else if (isManagedFile(entry.name, atRoot)) {
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
      // Symlink-aware containment (#1591): a book row whose `path` is an in-library symlink
      // resolving OUTSIDE the root is rejected, so the sweep can't follow it and delete managed
      // files under the target. The realpath guard swallows ENOENT, preserving the missing-path
      // no-op below.
      await assertRealPathInsideLibrary(bookPath, libraryRoot);
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
    // `lstat` (NOT `stat`): the top-level `bookPath` must be classified WITHOUT following a symlink,
    // mirroring how symlinked *children* are left foreign via `Dirent.isSymbolicLink()` in `sweepDir`
    // (#1591). A top-level directory symlink whose target holds managed audio must never be traversed
    // and deleted through — that delete-through-symlink data-loss path (#1598) is closed defensively
    // for EVERY caller, guarded or not.
    stats = await lstat(bookPath);
  } catch (error: unknown) {
    // A missing path is a no-op (matches the prior `force: true` ENOENT suppression).
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    // A top-level symlink (#1598): it is not a managed file, so preserve it and do NOT recurse into
    // or delete the link's target — `lstat` above kept us from following it.
    result.preservedForeign.push(bookPath);
  } else if (stats.isDirectory()) {
    await sweepDir(bookPath, bookPath, result, log);
  } else if (OPF_FILE_REGEX.test(basename(bookPath))) {
    // A single-file bookPath that is itself a root metadata.opf — same content-aware ownership check.
    await classifyRootOpf(bookPath, result, log);
  } else if (isManagedFile(basename(bookPath), true)) {
    await deleteOneManaged(bookPath, result, log);
  } else {
    result.preservedForeign.push(bookPath);
  }

  return result;
}
