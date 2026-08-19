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
 * Cleanup spans the temp write as well as the rename: a temp write that rejects after creating or
 * truncating the temp has already left a file behind, so a `try` around the rename alone orphans
 * it. The `committed` flag keeps the happy path from firing a pointless ENOENT unlink.
 *
 * `tempPrefix` stays dot-led — the temp is born hidden so narratorr's own scans and Audiobookshelf
 * ingest skip it while it exists (#1852).
 */
export async function replaceFileAtomically(
  targetPath: string,
  data: string | Buffer,
  tempPrefix = '.metadata-opf-',
): Promise<void> {
  const tempPath = join(dirname(targetPath), `${tempPrefix}${randomUUID()}.tmp`);
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
