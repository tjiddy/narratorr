import { readdir, readFile, rm, rmdir, lstat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { COVER_FILE_REGEX } from '@core/utils/cover-regex.js';
import { OPF_FILE_REGEX, hasNarratorrMarker } from '@core/utils/opf-regex.js';
import { assertRealPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import { serializeError } from './serialize-error.js';

/** Absolute paths partitioned by deletion outcome; per-file failures never abort the sweep. */
export interface DeleteManagedFilesResult {
  deletedManaged: string[];
  preservedForeign: string[];
  failedManaged: string[];
}

export interface DeleteManagedFilesOptions {
  /** Require symlink-aware library containment before deletion; defaults to true. */
  assertInsideLibrary?: boolean;
}

/**
 * Audio is managed at any depth; cover sidecars only at the book root. Root metadata.opf
 * ownership is content-based and handled separately.
 */
function isManagedFile(name: string, atRoot: boolean): boolean {
  if (AUDIO_EXTENSIONS.has(extname(name).toLowerCase())) return true;
  return atRoot && COVER_FILE_REGEX.test(name);
}

/**
 * Delete a root metadata.opf only when its provenance marker proves ownership. Read failures
 * preserve it as foreign, so classification must precede directory recursion.
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

/** Record managed-file deletion success or failure without throwing. */
async function deleteOneManaged(filePath: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  try {
    await rm(filePath, { force: true });
    result.deletedManaged.push(filePath);
  } catch (error: unknown) {
    result.failedManaged.push(filePath);
    log.warn({ file: filePath, error: serializeError(error) }, 'Failed to delete managed book file — preserving folder');
  }
}

async function rmdirIfEmpty(dir: string, log: FastifyBaseLogger): Promise<void> {
  try {
    await rmdir(dir);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Foreign contents or an already-absent directory are expected.
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') return;
    log.warn({ dir, error: serializeError(error) }, 'Failed to remove emptied book folder');
  }
}

/** Recursively sweep bottom-up; symlinked children remain foreign and are never followed. */
async function sweepDir(dir: string, rootDir: string, result: DeleteManagedFilesResult, log: FastifyBaseLogger): Promise<void> {
  const atRoot = dir === rootDir;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Never touch born-hidden entries another operation may be writing.
    if (isHiddenName(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (atRoot && OPF_FILE_REGEX.test(entry.name)) {
      // Content proves root OPF ownership; EISDIR must fail safe before recursion.
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
 * Delete managed content while preserving foreign files and non-empty folders. Missing paths
 * are no-ops; per-file failures are recorded, while containment violations still throw.
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
      // Reject in-library symlinks that resolve outside the root.
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
    // lstat prevents deletion through a top-level directory symlink in every mode.
    stats = await lstat(bookPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    // Preserve top-level symlinks without following them.
    result.preservedForeign.push(bookPath);
  } else if (stats.isDirectory()) {
    await sweepDir(bookPath, bookPath, result, log);
  } else if (OPF_FILE_REGEX.test(basename(bookPath))) {
    // Single-file OPF imports use the same provenance check.
    await classifyRootOpf(bookPath, result, log);
  } else if (isManagedFile(basename(bookPath), true)) {
    await deleteOneManaged(bookPath, result, log);
  } else {
    result.preservedForeign.push(bookPath);
  }

  return result;
}
