import { lstat, readdir, rmdir } from 'node:fs/promises';
import type { DbOrTx } from '@db/index.js';
import { findOtherPathOwner } from './path-identity.js';
import { RenameError } from './rename-error.js';

/**
 * `absent` renames straight in; `empty-directory` must have the directory removed first, because
 * only POSIX `rename(2)` replaces an existing empty directory and Windows' `MoveFileEx` does not.
 */
export type TargetOccupancy = 'absent' | 'empty-directory';

/**
 * The ownership half of the fence: does a DIFFERENT row already claim this folder?
 *
 * Runs unconditionally, before any on-disk classification. A path a second row owns but that is
 * not currently on disk — deleted content, a folder removed outside the app — is exactly the case
 * an existence-gated check let through, and committing to it leaves two rows naming one folder.
 */
export async function assertNoOtherOwner(db: DbOrTx, targetPath: string, bookId: number): Promise<void> {
  const other = await findOtherPathOwner(db, targetPath, bookId);
  if (!other) return;
  throw new RenameError(
    `Target path already belongs to "${other.title}" (book #${other.id})`,
    'CONFLICT',
    { conflictingBook: other },
  );
}

function occupied(targetPath: string, detail: string): RenameError {
  return new RenameError(`Target path "${targetPath}" is ${detail}`, 'TARGET_OCCUPIED');
}

/**
 * Classify an unowned target by a single `lstat`, then refuse anything that is not an empty
 * directory. `lstat` rather than `stat` is load-bearing: `stat` follows a final-component symlink,
 * so a link pointing at an empty directory would be indistinguishable from the absorbable arm —
 * the same no-follow rule `readOpfEntry` applies before any content read.
 *
 * Every unclassifiable outcome fails closed toward not moving, which turns an `ENOTEMPTY` escaping
 * as a 500 into an actionable 409.
 */
export async function classifyTargetOccupancy(targetPath: string): Promise<TargetOccupancy> {
  let entry;
  try {
    entry = await lstat(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw occupied(targetPath, 'not readable');
  }

  if (entry.isSymbolicLink()) throw occupied(targetPath, 'a symbolic link');
  if (!entry.isDirectory()) throw occupied(targetPath, 'an existing file');

  let entries: string[];
  try {
    entries = await readdir(targetPath);
  } catch {
    throw occupied(targetPath, 'not readable');
  }
  if (entries.length > 0) throw occupied(targetPath, 'a non-empty directory');

  return 'empty-directory';
}

/**
 * Remove the verified-empty target immediately before the move, inside the same held claim, so the
 * absorb does not depend on POSIX `rename(2)` semantics. A failure means something populated the
 * directory since the classification — refuse rather than move.
 */
export async function clearVerifiedEmptyTarget(targetPath: string): Promise<void> {
  try {
    await rmdir(targetPath);
  } catch {
    throw occupied(targetPath, 'no longer an empty directory');
  }
}
