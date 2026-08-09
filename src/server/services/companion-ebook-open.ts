import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { assertRealPathInsideLibraryStrict, PathOutsideLibraryError } from '../utils/paths.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';
import { READ_NO_FOLLOW } from '@core/utils/no-follow-open.js';

export interface CompanionOpenInput {
  bookId: number;
  bookPath: string;
  filename: string;
  libraryRoot: string;
}

// On ok the caller owns the handle; all other outcomes leave none open.
export type CompanionOpenResult =
  | { outcome: 'ok'; handle: FileHandle; sizeBytes: number }
  /** `filename` is not a basename the observation write boundary would accept. */
  | { outcome: 'invalid_filename' }
  /** A symlink, directory, FIFO, socket, or device — anything but a regular file. */
  | { outcome: 'not_regular_file' }
  /** The canonicalised path escapes the library root. */
  | { outcome: 'outside_library' }
  /** ENOENT / ENOTDIR — the filesystem looked and found nothing. */
  | { outcome: 'missing' }
  /** Any other errno, or a code-less throw — the probe could not tell. */
  | { outcome: 'unreadable' };

type CompanionVerifyFailure = Exclude<CompanionOpenResult, { outcome: 'ok' }>;

export type CompanionResolveResult = { outcome: 'ok'; path: string } | CompanionVerifyFailure;

// Use the shared errno policy; code-less errors are unreadable, not missing.
function classifyFailure(error: unknown): 'missing' | 'unreadable' {
  return isDefinitiveAbsence(error) ? 'missing' : 'unreadable';
}

async function closeAbandoned(
  handle: FileHandle,
  bookId: number,
  path: string,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    await handle.close();
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook handle close failed after a failed open');
  }
}

// Reject non-regular entries before canonical containment.
async function verifyPath(
  bookId: number,
  path: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<CompanionVerifyFailure | null> {
  try {
    // lstat rejects a symlink final component; realpath below catches parent-directory escapes.
    const stats = await lstat(path);
    if (!stats.isFile()) return { outcome: 'not_regular_file' };
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook lstat failed');
    return { outcome: classifyFailure(error) };
  }

  try {
    await assertRealPathInsideLibraryStrict(path, libraryRoot);
    return null;
  } catch (error: unknown) {
    if (error instanceof PathOutsideLibraryError) {
      log.debug({ bookId, path }, 'Companion ebook path is outside the library root');
      return { outcome: 'outside_library' };
    }
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook containment check failed');
    return { outcome: classifyFailure(error) };
  }
}

/**
 * Sole path-construction site: validate before join or syscalls, then verify containment.
 * Never throws or opens a handle; inspection callers own any later open.
 */
export async function resolveCompanionEbookPath(
  input: CompanionOpenInput,
  log: FastifyBaseLogger,
): Promise<CompanionResolveResult> {
  const { bookId, bookPath, filename, libraryRoot } = input;

  if (!isPersistableCompanionBasename(filename)) return { outcome: 'invalid_filename' };

  const path = join(bookPath, filename);

  const rejection = await verifyPath(bookId, path, libraryRoot, log);
  if (rejection) return rejection;

  // Return the stored pathname; canonicalization is only a containment decision.
  return { outcome: 'ok', path };
}

/**
 * Resolve, open without following symlinks, then fstat. Never throws.
 * dev/ino binding is deliberately omitted because media-share writers can already replace audio.
 */
export async function openCompanionEbook(
  input: CompanionOpenInput,
  log: FastifyBaseLogger,
): Promise<CompanionOpenResult> {
  const { bookId } = input;

  const resolved = await resolveCompanionEbookPath(input, log);
  if (resolved.outcome !== 'ok') return resolved;
  const { path } = resolved;

  let handle: FileHandle;
  try {
    // Do not follow a symlink swapped in after containment verification.
    handle = await open(path, READ_NO_FOLLOW);
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook open failed');
    return { outcome: classifyFailure(error) };
  }

  try {
    // The open handle is authoritative; the stored size is too stale for Content-Length.
    const stats = await handle.stat();
    return { outcome: 'ok', handle, sizeBytes: stats.size };
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook fstat failed');
    await closeAbandoned(handle, bookId, path, log);
    return { outcome: classifyFailure(error) };
  }
}
