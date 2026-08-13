import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Replace a file by writing a born-hidden sibling temp and renaming it over the destination.
 *
 * A direct `writeFile` truncates its destination on open, so an ENOSPC/EIO rejection mid-write
 * leaves an empty or partial file — the data loss #2297 exists to prevent, in the failure path.
 * `copyFile` is no better for a backup: it opens the destination `O_TRUNC` and writes through to
 * the existing inode, so a hard-linked peer would be rewritten. Rename swaps the directory entry,
 * so any other name for the old inode keeps its bytes.
 *
 * Cleanup spans the whole span rather than just the rename (unlike `cover-upload.ts:35-43`): a
 * temp write that rejects after creating or truncating the temp has already left a file behind.
 * The `committed` flag keeps the happy path from firing a pointless ENOENT unlink.
 */
export async function replaceFileAtomically(targetPath: string, data: string | Buffer): Promise<void> {
  const tempPath = join(dirname(targetPath), `.metadata-opf-${randomUUID()}.tmp`);
  let committed = false;
  try {
    await writeFile(tempPath, data);
    await rename(tempPath, targetPath);
    committed = true;
  } finally {
    // Best-effort; ENOENT when the temp was never created is expected and ignored.
    if (!committed) await unlink(tempPath).catch(() => { /* best-effort */ });
  }
}
