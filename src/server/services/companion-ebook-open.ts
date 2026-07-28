import { lstat, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { assertRealPathInsideLibraryStrict, PathOutsideLibraryError } from '../utils/paths.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import { isPersistableCompanionBasename } from './companion-ebook-observation.js';
import { READ_NO_FOLLOW } from '../../core/utils/no-follow-open.js';

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
 * The five negatives, named once. `resolveCompanionEbookPath` returns *the same five* as a
 * matter of type identity rather than of two lists agreeing by inspection (#1976 AC1) — adding
 * a sixth outcome to `CompanionOpenResult` widens both, which is the point.
 */
type CompanionVerifyFailure = Exclude<CompanionOpenResult, { outcome: 'ok' }>;

/**
 * The resolver's outcome union: the verified path, or the same five negatives. No handle —
 * `inspectEpub` opens the archive by pathname itself, and taking a descriptor solely to close
 * it before that re-open buys nothing (#1976 AC3).
 */
export type CompanionResolveResult = { outcome: 'ok'; path: string } | CompanionVerifyFailure;

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
): Promise<CompanionVerifyFailure | null> {
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
 * Verify a stored companion basename and return the path it resolves to (#1976 AC1, plan §5).
 *
 * In order: reject a non-persistable basename **before any `join` and before any syscall** ·
 * `join` · `lstat` · regular-file check · realpath containment inside the library root.
 *
 * **It never throws**, and it never opens a descriptor — on every outcome, including `ok`,
 * nothing is left for the caller to close. That is what lets the two read routes hand the
 * returned `path` straight to `inspectEpub`, which opens the archive by pathname itself.
 *
 * This is the ONE path-construction site (#1976 AC3). `openCompanionEbook` composes it, both
 * read routes call it, and the selection mutation reaches it from inside its admission lock.
 * A route that built `join(bookPath, filename)` itself would be a second site, free to drift
 * from the verified one — which is exactly the drift the containment check exists to catch.
 *
 * Logging is `debug`-only and carries the `path` deliberately; see `openCompanionEbook`.
 */
export async function resolveCompanionEbookPath(
  input: CompanionOpenInput,
  log: FastifyBaseLogger,
): Promise<CompanionResolveResult> {
  const { bookId, bookPath, filename, libraryRoot } = input;

  // Before any `join`, before any syscall: a `..`, a separator, or a padded name never
  // becomes a path here.
  if (!isPersistableCompanionBasename(filename)) return { outcome: 'invalid_filename' };

  const path = join(bookPath, filename);

  const rejection = await verifyPath(bookId, path, libraryRoot, log);
  if (rejection) return rejection;

  // The path as BUILT, not the canonicalised form containment compared: the caller opens the
  // name the row names, and canonicalisation is a decision procedure, not a rewrite.
  return { outcome: 'ok', path };
}

/**
 * Open one companion ebook for serving, verifying it first (#1974 AC1-AC7, plan §5).
 *
 * Composed as `resolveCompanionEbookPath` → `open` → `fstat` (#1976 AC2), so the basename
 * re-validation, the `join`, and the two verification syscalls exist at exactly one site.
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
  const { bookId } = input;

  const resolved = await resolveCompanionEbookPath(input, log);
  if (resolved.outcome !== 'ok') return resolved;
  const { path } = resolved;

  let handle: FileHandle;
  try {
    // `READ_NO_FOLLOW`, never `'r'`: containment was verified against this PATHNAME above, and
    // the open below is a second resolution of it. A symlink swapped into the gap would other-
    // wise be followed, and the `fstat` that follows reads only `size`. See no-follow-open.ts.
    handle = await open(path, READ_NO_FOLLOW);
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
