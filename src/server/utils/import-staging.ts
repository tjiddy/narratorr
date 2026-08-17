// Stage and verify new audio in born-hidden siblings before an atomic, reversible swap.
// Legacy scratch names are recognition-only; every destructive step is containment-guarded.
import { rm, mkdir, readdir, rename, writeFile, stat, open } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/index.js';
import { MARKER_SUFFIX } from '@core/utils/import-sibling-suffixes.js';
import { removeTree } from '@core/utils/remove-tree.js';
import { deriveImportSiblings, type ImportSiblings } from './import-sibling-paths.js';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
import { serializeError } from './serialize-error.js';
import { getAudioPathSize, assertCopyVerified } from './import-helpers.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

// Recovery failures retain the marker and actual backup paths for the next attempt.
export class BackupRecoveryError extends Error {
  readonly code = 'BACKUP_RECOVERY_FAILED' as const;
  readonly backupPaths: readonly string[];
  readonly convention?: 'active' | 'legacy';
  constructor(
    public readonly targetPath: string,
    options?: { backupPaths?: readonly string[]; convention?: 'active' | 'legacy'; cause?: unknown },
  ) {
    // Pre-selection failures name both candidates; selected failures name the actual backup.
    const paths =
      options?.backupPaths && options.backupPaths.length > 0
        ? options.backupPaths
        : [`${targetPath}.import-backup`, `${targetPath}.import-bak`];
    super(
      `Failed to recover interrupted import backup for "${targetPath}" — check permissions on ${paths.map((p) => `"${p}"`).join(' / ')}; retrying (or the next boot's marker sweep) re-attempts recovery`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.backupPaths = paths;
    if (options?.convention) this.convention = options.convention;
    this.name = 'BackupRecoveryError';
  }
}

// Two populated backup conventions are non-retryable: preserve both until an operator chooses.
export class BackupAmbiguityError extends Error {
  readonly code = 'BACKUP_AMBIGUOUS' as const;
  constructor(
    public readonly targetPath: string,
    public readonly activeBackupPath: string,
    public readonly legacyBackupPath: string,
  ) {
    super(
      `Cannot recover interrupted import for "${targetPath}": populated backups exist for BOTH conventions ("${activeBackupPath}" and "${legacyBackupPath}"). Automatic recovery cannot choose safely — remove or quarantine one backup, then retry.`,
    );
    this.name = 'BackupAmbiguityError';
  }
}

// Compatibility re-export for existing import consumers.
export { MarkerPathConflictError } from './marker-path-conflict.js';
export { assertMarkerPathWritable } from './marker-path-conflict.js';

// Marker presence, not backup contents, means a destructive commit was interrupted.
function markerPathFor(targetPath: string): string {
  return `${targetPath}${MARKER_SUFFIX}`;
}

// Only a file is a marker. ENOENT/non-files are absent; other stat errors propagate.
// Destructive callers must preflight the marker path before acting on "absent."
async function markerExists(markerPath: string): Promise<boolean> {
  try {
    const stats = await stat(markerPath);
    return stats.isFile();
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw statError;
  }
}

// Failure cleanup trusts durable marker state, not error identity. Stat uncertainty returns
// true: retaining scratch is recoverable; deleting the sole backup is not (#1336).
export async function markerPresent(targetPath: string, log: FastifyBaseLogger): Promise<boolean> {
  try {
    return await markerExists(markerPathFor(targetPath));
  } catch (statError: unknown) {
    log.warn(
      { error: serializeError(statError), targetPath },
      'Commit-pending marker stat failed — treating marker as present to preserve backup (#1336)',
    );
    return true;
  }
}

// Best-effort, containment-guarded removal for ordinary failure cleanup.
export async function removeMarker(
  targetPath: string,
  libraryRoot: string | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const markerPath = markerPathFor(targetPath);
  if (libraryRoot) {
    try {
      assertPathInsideLibrary(markerPath, libraryRoot);
    } catch (gateError: unknown) {
      if (gateError instanceof PathOutsideLibraryError) {
        log.error({ markerPath, libraryRoot }, 'Refusing to remove commit-pending marker outside library root — leaving foreign path untouched');
        return;
      }
      throw gateError;
    }
  }
  await rm(markerPath, { force: true })
    .catch((rmError: unknown) => log.warn({ error: serializeError(rmError), markerPath }, 'Failed to remove commit-pending marker — continuing'));
}

// Containment-guarded scratch removal. Strict mode propagates real failures before
// staging/recovery; best-effort cleanup cannot mask the controlling outcome. ENOENT is harmless.
export async function removeImportSibling(
  path: string,
  libraryRoot: string | undefined,
  log: FastifyBaseLogger,
  label: 'staging' | 'backup',
  opts?: { strict?: boolean },
): Promise<void> {
  if (libraryRoot) {
    try {
      assertPathInsideLibrary(path, libraryRoot);
    } catch (gateError: unknown) {
      if (gateError instanceof PathOutsideLibraryError) {
        log.error({ path, libraryRoot, label }, 'Refusing to remove import sibling outside library root — leaving foreign path untouched');
        return;
      }
      throw gateError;
    }
  }
  if (opts?.strict) {
    await removeTree(path);
    return;
  }
  await removeTree(path)
    .catch((rmError: unknown) => log.warn({ error: serializeError(rmError), path, label }, 'Failed to remove import sibling — continuing'));
}

async function listDirFileNames(dir: string, audioOnly: boolean): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (readError: unknown) {
    if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw readError;
  }
  return entries
    .filter((e) => e.isFile() && (!audioOnly || AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase())))
    .map((e) => e.name);
}

// Return relative audio paths recursively. Admission also recurses, so backup must or nested
// old audio would survive the swap (#1287).
async function listAudioFilesRecursive(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (readError: unknown) {
    if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw readError;
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (isHiddenName(entry.name)) continue;
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(entry.name);
    } else if (entry.isDirectory()) {
      const nested = await listAudioFilesRecursive(join(dir, entry.name));
      results.push(...nested.map((rel) => join(entry.name, rel)));
    }
  }
  return results;
}

export interface PrepareImportSiblingsArgs {
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

// Single recovery seam before any writer mutates a target. Marker absent strictly clears
// active + legacy scratch. Marker present restores at most one populated backup, clears all
// scratch, and removes the marker last. Return means safe to proceed; failure preserves state.
export async function prepareImportSiblings(args: PrepareImportSiblingsArgs): Promise<void> {
  const { targetPath, libraryRoot, log } = args;
  const s = deriveImportSiblings(targetPath);

  // Read the marker first; wrap stat failures so downstream cleanup preserves both backups.
  let markerPresentOnDisk: boolean;
  try {
    markerPresentOnDisk = await markerExists(s.markerPath);
  } catch (statError: unknown) {
    throw new BackupRecoveryError(targetPath, {
      backupPaths: [s.backupPath, s.legacyBackupPath],
      cause: statError,
    });
  }

  if (!markerPresentOnDisk) {
    await removeImportSibling(s.stagingPath, libraryRoot, log, 'staging', { strict: true });
    await removeImportSibling(s.backupPath, libraryRoot, log, 'backup', { strict: true });
    await removeImportSibling(s.legacyStagingPath, libraryRoot, log, 'staging', { strict: true });
    await removeImportSibling(s.legacyBackupPath, libraryRoot, log, 'backup', { strict: true });
    return;
  }

  await recoverInterruptedBackup({ targetPath, siblings: s, libraryRoot, log });
}

export interface CommitStagedImportArgs {
  stagingPath: string;
  targetPath: string;
  backupPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

// Backup files are authoritative and overwrite half-moved replacements. Strict recovery
// propagates failures to preserve state; rollback logs them without masking the commit error.
async function restoreBackedUpFiles(
  targetPath: string,
  backupPath: string,
  backedUp: string[],
  log: FastifyBaseLogger,
  opts: { strict: boolean },
): Promise<void> {
  const guard = async (op: () => Promise<unknown>, msg: string, rel: string): Promise<void> => {
    if (opts.strict) { await op(); return; }
    await op().catch((restoreError: unknown) => log.error({ error: serializeError(restoreError), file: rel }, msg));
  };
  for (const rel of backedUp) {
    const sub = dirname(rel);
    if (sub !== '.') {
      await guard(() => mkdir(join(targetPath, sub), { recursive: true }), 'Rollback: failed to recreate target subdirectory for backed-up audio', rel);
    }
    await guard(() => rename(join(backupPath, rel), join(targetPath, rel)), 'Rollback: failed to restore backed-up audio to target', rel);
  }
}

// Best-effort rollback must never mask the original commit error.
async function rollbackStagedCommit(
  targetPath: string,
  backupPath: string,
  movedIn: string[],
  backedUp: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  for (const name of movedIn) {
    await rm(join(targetPath, name), { force: true })
      .catch((rollbackError: unknown) => log.error({ error: serializeError(rollbackError), file: name }, 'Rollback: failed to remove staged file from target'));
  }
  await restoreBackedUpFiles(targetPath, backupPath, backedUp, log, { strict: false });
}

export interface RecoverInterruptedBackupArgs {
  targetPath: string;
  siblings: ImportSiblings;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

// Wrap enumeration failures so cleanup preserves the named backup.
async function enumerateBackup(
  targetPath: string,
  backupPath: string,
  convention: 'active' | 'legacy',
): Promise<string[]> {
  try {
    return await listAudioFilesRecursive(backupPath);
  } catch (enumError: unknown) {
    throw new BackupRecoveryError(targetPath, { backupPaths: [backupPath], convention, cause: enumError });
  }
}

// Enumerate both conventions before mutation. Restore at most one populated backup, strictly
// clear all scratch, then remove the marker last. Any failure leaves the marker for retry.
async function recoverInterruptedBackup(args: RecoverInterruptedBackupArgs): Promise<void> {
  const { targetPath, siblings, libraryRoot, log } = args;
  const { stagingPath, backupPath, legacyStagingPath, legacyBackupPath, markerPath } = siblings;

  const activeFiles = await enumerateBackup(targetPath, backupPath, 'active');
  const legacyFiles = await enumerateBackup(targetPath, legacyBackupPath, 'legacy');

  if (activeFiles.length > 0 && legacyFiles.length > 0) {
    throw new BackupAmbiguityError(targetPath, backupPath, legacyBackupPath);
  }

  const selected =
    activeFiles.length > 0
      ? { path: backupPath, files: activeFiles, convention: 'active' as const }
      : legacyFiles.length > 0
        ? { path: legacyBackupPath, files: legacyFiles, convention: 'legacy' as const }
        : null;

  if (selected) {
    try {
      log.info(
        { targetPath, files: selected.files.length, convention: selected.convention },
        'Recovering interrupted import commit — restoring backed-up audio from the populated backup',
      );
      assertPathInsideLibrary(targetPath, libraryRoot);
      assertPathInsideLibrary(selected.path, libraryRoot);
      // Recreate a user-deleted target so recovery can converge instead of looping on ENOENT.
      await mkdir(targetPath, { recursive: true });
      await restoreBackedUpFiles(targetPath, selected.path, selected.files, log, { strict: true });
    } catch (restoreError: unknown) {
      throw new BackupRecoveryError(targetPath, {
        backupPaths: [selected.path],
        convention: selected.convention,
        cause: restoreError,
      });
    }
  }

  // Both conventions are now disposable; any clear failure retains the marker.
  const clearTargets: Array<{ path: string; label: 'staging' | 'backup'; convention: 'active' | 'legacy' }> = [
    { path: stagingPath, label: 'staging', convention: 'active' },
    { path: legacyStagingPath, label: 'staging', convention: 'legacy' },
    { path: backupPath, label: 'backup', convention: 'active' },
    { path: legacyBackupPath, label: 'backup', convention: 'legacy' },
  ];
  for (const t of clearTargets) {
    try {
      await removeImportSibling(t.path, libraryRoot, log, t.label, { strict: true });
    } catch (clearError: unknown) {
      throw new BackupRecoveryError(targetPath, { backupPaths: [t.path], convention: t.convention, cause: clearError });
    }
  }

  // Strict marker removal is the final proceed signal.
  try {
    if (libraryRoot) assertPathInsideLibrary(markerPath, libraryRoot);
    await rm(markerPath, { force: true });
  } catch (markerError: unknown) {
    throw new BackupRecoveryError(targetPath, {
      backupPaths: [backupPath, legacyBackupPath],
      cause: markerError,
    });
  }
}

// File flush does not sync its parent entry. Best-effort directory fsync narrows that
// power-loss window; unsupported filesystems must not abort the commit (#1339).
async function syncDirectoryEntry(dirPath: string, log: FastifyBaseLogger): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch (syncError: unknown) {
    log.debug({ error: serializeError(syncError), dirPath }, 'Best-effort directory fsync failed — file flush already covers durability');
  } finally {
    // warn, not debug: a close can only fail after open() succeeded, so unlike the fsync above it is
    // never routine — it leaks a descriptor. Containing it here keeps a rejection from escaping the
    // finally and replacing the commit's own outcome.
    if (handle) {
      try {
        await handle.close();
      } catch (closeError: unknown) {
        log.warn({ error: serializeError(closeError), dirPath }, 'Failed to close directory handle after fsync');
      }
    }
  }
}

export async function commitStagedImport(args: CommitStagedImportArgs): Promise<void> {
  const { stagingPath, targetPath, backupPath, libraryRoot, log } = args;
  assertPathInsideLibrary(stagingPath, libraryRoot);
  assertPathInsideLibrary(backupPath, libraryRoot);
  assertPathInsideLibrary(targetPath, libraryRoot);

  await mkdir(targetPath, { recursive: true });

  // Admission counts nested audio, so backup must recurse too.
  const existingAudio = await listAudioFilesRecursive(targetPath);
  const stagedFiles = await listDirFileNames(stagingPath, false);

  const markerPath = markerPathFor(targetPath);
  const backedUp: string[] = [];
  const movedIn: string[] = [];
  try {
    if (existingAudio.length > 0) {
      await mkdir(backupPath, { recursive: true });
      // Write the marker before the first destructive rename.
      assertPathInsideLibrary(markerPath, libraryRoot);
      // Flush before renames: POSIX may persist moves before an unflushed marker.
      await writeFile(markerPath, '', { flush: true });
      await syncDirectoryEntry(dirname(markerPath), log);
      for (const rel of existingAudio) {
        // Preserve relative paths for exact rollback.
        const sub = dirname(rel);
        if (sub !== '.') await mkdir(join(backupPath, sub), { recursive: true });
        await rename(join(targetPath, rel), join(backupPath, rel));
        backedUp.push(rel);
      }
    }
    for (const name of stagedFiles) {
      await rename(join(stagingPath, name), join(targetPath, name));
      movedIn.push(name);
    }
    // Marker removal is the final commit signal; failure still rolls back.
    await rm(markerPath, { force: true });
  } catch (commitError: unknown) {
    log.error({ error: serializeError(commitError), targetPath }, 'Import commit failed — rolling back to pre-import state');
    await rollbackStagedCommit(targetPath, backupPath, movedIn, backedUp, log);
    throw commitError;
  }

  log.info({ targetPath, replaced: backedUp.length, added: movedIn.length }, 'Committed staged import');
  await removeImportSibling(backupPath, libraryRoot, log, 'backup');
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
}

export interface CleanupImportSiblingsArgs {
  stagingPath: string;
  backupPath: string;
  targetPath?: string | undefined;
  libraryRoot?: string | undefined;
  log: FastifyBaseLogger;
  /** Retain backup + marker for recovery; staging remains disposable. */
  preserveBackup?: boolean | undefined;
}

// Best-effort failure cleanup; preserveBackup retains recoverable state and clears only staging.
export async function cleanupImportSiblings(args: CleanupImportSiblingsArgs): Promise<void> {
  const { stagingPath, backupPath, targetPath, libraryRoot, log, preserveBackup } = args;
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
  if (preserveBackup) return;
  await removeImportSibling(backupPath, libraryRoot, log, 'backup');
  if (targetPath) await removeMarker(targetPath, libraryRoot, log);
}

export interface StagedAudioReplaceArgs {
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
  sourceAudioSize: number;
  /** Copy flattened audio into the supplied staging path. */
  stage: (stagingPath: string) => Promise<void>;
}

// Manual replacement stages and verifies before touching a populated target, then uses the
// reversible commit. Foreign files survive; failures clean disposable scratch and rethrow.
export async function stagedAudioReplace(args: StagedAudioReplaceArgs): Promise<number> {
  const { targetPath, libraryRoot, log, sourceAudioSize, stage } = args;
  const { stagingPath, backupPath } = deriveImportSiblings(targetPath);
  // Preflight outside try: a directory collision looks marker-absent, and cleanup could delete
  // the adjacent backup before recovery can inspect it.
  await assertMarkerPathWritable(targetPath);
  try {
    await prepareImportSiblings({ targetPath, libraryRoot, log });
    await stage(stagingPath);
    const stagedSize = await getAudioPathSize(stagingPath);
    assertCopyVerified(sourceAudioSize, stagedSize);
    await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log });
    return stagedSize;
  } catch (error: unknown) {
    // Preserve by durable marker state, regardless of the thrown error type.
    await cleanupImportSiblings({ stagingPath, backupPath, targetPath, libraryRoot, log, preserveBackup: await markerPresent(targetPath, log) });
    throw error;
  }
}
