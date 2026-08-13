import { lstat, readFile } from 'node:fs/promises';
import { hasNarratorrMarker } from '@core/utils/opf-regex.js';

/**
 * Ownership of an OPF path is established type-first, then by content (#2297). The marker proves
 * the provenance of some bytes, not of the path those bytes were reached through: a `readFile`
 * that follows a final-component symlink finds the marker in the *target* and would then write
 * through the operator's link. `lstat` before any read is the only way the write path and the
 * delete sweep can agree on what "narratorr-owned" means.
 *
 * The same policy governs `metadata.opf` and `metadata.opf.bak` alike.
 */
export type OpfEntryRead =
  | { kind: 'absent' }
  | { kind: 'non-regular' }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'file'; bytes: Buffer; text: string };

/**
 * Read an OPF-family entry as bytes, refusing anything that is not a plain file.
 *
 * The text is derived from the buffer rather than read separately: `readFile(path, 'utf-8')`
 * replaces invalid UTF-8 with U+FFFD, so a string round-trip is not byte-preserving and a
 * truncated sidecar would be backed up as something that never existed on disk.
 */
export async function readOpfEntry(path: string): Promise<OpfEntryRead> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', error };
  }
  if (!stats.isFile()) return { kind: 'non-regular' };

  try {
    const bytes = await readFile(path);
    return { kind: 'file', bytes, text: bytes.toString('utf-8') };
  } catch (error: unknown) {
    return { kind: 'unreadable', error };
  }
}

/** Why the writer refused to claim `metadata.opf.bak`; every arm leaves the sidecar untouched. */
export type BackupClaimRefusal = 'foreign' | 'non-regular' | 'unreadable';

export type BackupClaim = { claimed: true } | { claimed: false; state: BackupClaimRefusal };

/**
 * `metadata.opf.bak` is a fixed pathname, so the writer must not assume it owns it — deletion
 * already preserves an unmarked one as operator-authored, and writing over it unclassified would
 * destroy a foreign file in the middle of a feature whose purpose is to stop destroying files.
 */
export async function claimOpfBackupDestination(backupPath: string): Promise<BackupClaim> {
  const entry = await readOpfEntry(backupPath);
  switch (entry.kind) {
    case 'absent':
      return { claimed: true };
    case 'non-regular':
      return { claimed: false, state: 'non-regular' };
    case 'unreadable':
      return { claimed: false, state: 'unreadable' };
    case 'file':
      // Our own previous rolling snapshot is the only thing we may replace.
      return hasNarratorrMarker(entry.text) ? { claimed: true } : { claimed: false, state: 'foreign' };
  }
}

/**
 * A refused claim is a semantic `'failed'` with no caught cause, but `onFailure` is documented to
 * fire on every `'failed'` outcome — a silent side channel here would be the one that behaves
 * differently, and `reconcileBookSidecars` would fall back to its generic string.
 */
export class OpfBackupClaimError extends Error {
  constructor(public readonly backupPath: string, public readonly state: BackupClaimRefusal) {
    super(`Refusing to claim ${backupPath} for the sidecar backup — ${state}`);
    this.name = 'OpfBackupClaimError';
  }
}
