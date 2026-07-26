import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { assertRealPathInsideLibraryStrict, PathOutsideLibraryError } from '../utils/paths.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';

export interface CompanionOpenInput {
  /** Public book id, carried solely so the log identity matches the shipped sibling's shape. */
  bookId: number;
  /** `books.path` — the book's library folder, NOT the file. */
  bookPath: string;
  /** `companion_ebooks.filename` — a stored top-level basename, re-validated here. */
  filename: string;
  /** `settings.library.path`, read by the CALLER. */
  libraryRoot: string;
}

/**
 * The exhaustive outcome union (#1974 AC2). On `ok` the CALLER owns the handle and must close
 * it; on every other outcome no descriptor is left open.
 */
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

/**
 * Absence vs. undetermined, through the shared #1955 discriminator — never a hand-rolled
 * errno set. A code-less throw is `unreadable`, never `missing`.
 */
function classifyFailure(error: unknown): 'missing' | 'unreadable' {
  return isDefinitiveAbsence(error) ? 'missing' : 'unreadable';
}

/** Close a handle we are about to abandon. Never throws; the close failure is diagnostic only. */
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

/**
 * `lstat` + regular-file check + realpath containment, in that order (#1974 AC1 steps 1-3).
 * Returns `null` when the path cleared every check.
 */
async function verifyPath(
  bookId: number,
  path: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<CompanionOpenResult | null> {
  try {
    // `lstat`, never `stat`: a symlink must be REJECTED, not followed. The final component is
    // therefore proven non-symlink, which is what makes canonicalising the full path below
    // sufficient to catch a parent-directory escape.
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
    // Expected control-flow outcome, not a failure — logged without an `error:` key, matching
    // `isCompanionEbookEligible`'s treatment of the same class of event.
    if (error instanceof PathOutsideLibraryError) {
      log.debug({ bookId, path }, 'Companion ebook path is outside the library root');
      return { outcome: 'outside_library' };
    }
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook containment check failed');
    return { outcome: classifyFailure(error) };
  }
}

/**
 * Open one companion ebook for serving, verifying it first (#1974 AC1-AC7, plan §5).
 *
 * In order: reject a non-persistable basename **before any `join` and before any syscall** ·
 * `lstat` · regular-file check · realpath containment inside the library root · `open` ·
 * `fstat` for the authoritative size.
 *
 * **It never throws.** Like `isCompanionEbookEligible`, every negative and every errno is
 * absorbed and returned as a discriminated outcome, so a route maps outcomes to statuses and
 * never wraps this call in a `try`.
 *
 * Two checks — reject anything that is not a regular file, and verify containment — are what
 * keep a symlink named `book.epub` from streaming `/config/secret.key`, which
 * `secret-codec.ts` auto-generates beside the database in the common Docker deployment. They
 * are not negotiable. The dev/ino equality binding between `lstat` and `fstat` is deliberately
 * NOT done (plan §5): it defends a microsecond-wide swap race against an attacker who already
 * has write access to the media share and could equally replace the audiobook, which nothing
 * checks at all.
 *
 * `filename` re-validation goes through `isPersistableCompanionBasename` — the same predicate
 * discovery and the observation write boundary use — so a legacy or API-crafted row fails
 * closed here and the three sites cannot disagree about what a valid basename is.
 *
 * Logging is `debug`-only and follows the shipped sibling's shape exactly
 * (`{ bookId, path, error: serializeError(error) }`). The ROUTE boundary, not this helper, is
 * where the `{ bookId, outcome }`-and-nothing-else rule applies.
 */
export async function openCompanionEbook(
  input: CompanionOpenInput,
  log: FastifyBaseLogger,
): Promise<CompanionOpenResult> {
  const { bookId, bookPath, filename, libraryRoot } = input;

  // Before any `join`, before any syscall: a `..`, a separator, or a padded name never
  // becomes a path here.
  if (!isPersistableCompanionBasename(filename)) return { outcome: 'invalid_filename' };

  const path = join(bookPath, filename);

  const rejection = await verifyPath(bookId, path, libraryRoot, log);
  if (rejection) return rejection;

  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook open failed');
    return { outcome: classifyFailure(error) };
  }

  try {
    // `fstat` on the OPEN handle is the size authority — `companion_ebooks.size_bytes` is a
    // stale observation and must never become a `Content-Length`.
    const stats = await handle.stat();
    return { outcome: 'ok', handle, sizeBytes: stats.size };
  } catch (error: unknown) {
    log.debug({ bookId, path, error: serializeError(error) }, 'Companion ebook fstat failed');
    await closeAbandoned(handle, bookId, path, log);
    return { outcome: classifyFailure(error) };
  }
}
