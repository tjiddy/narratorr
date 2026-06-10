/**
 * Staged-import machinery (`.import-tmp` / `.import-bak`) shared by the re-import
 * path (`import.service.ts`) and the manual-import path (#1287). A populated target
 * is never mutated in place: the new audio is staged into a sibling, verified, then
 * atomically swapped in while the existing audio is backed up and rolled back on
 * failure. Every destructive step is guarded by `assertPathInsideLibrary` (#759).
 */
import { rm, mkdir, readdir, rename, writeFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { serializeError } from './serialize-error.js';
import { getAudioPathSize, assertCopyVerified } from './import-helpers.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

// ── commit-pending marker ───────────────────────────────────────────────

/**
 * Thrown when `recoverInterruptedBackup` fails partway through restoring the
 * originals stranded in `.import-bak` by a process-killed commit. The failure-path
 * cleanup recognizes this type and skips removing BOTH `.import-bak` and the
 * commit-pending marker, so the still-unrestored originals survive for the next
 * boot's recovery attempt (idempotency, #1290).
 */
export class BackupRecoveryError extends Error {
  readonly code = 'BACKUP_RECOVERY_FAILED' as const;
  constructor(
    public readonly targetPath: string,
    options?: { cause?: unknown },
  ) {
    super(`Failed to recover interrupted import backup for "${targetPath}"`, options);
    this.name = 'BackupRecoveryError';
  }
}

/**
 * Sibling marker file recording that a destructive commit is mid-flight. Its
 * presence (not `.import-bak` content, which can be a disposable success-leftover)
 * is the out-of-band signal that drives recovery (#1290).
 */
function markerPathFor(targetPath: string): string {
  return `${targetPath}.import-commit-pending`;
}

/** True when the commit-pending marker exists; false on ENOENT. */
async function markerExists(markerPath: string): Promise<boolean> {
  try {
    await stat(markerPath);
    return true;
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw statError;
  }
}

/**
 * Best-effort removal of the commit-pending marker, guarded by the library-root
 * ancestry check (#759). Used on ordinary (non-recovery) failure cleanup so the
 * marker does not accumulate — a hiccup is logged, never thrown.
 */
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

// ── staged-import siblings (.import-tmp / .import-bak) ───────────────────

/**
 * Guarded recursive removal of a transient import sibling (staging or backup).
 * Verifies the path is inside the library root before deleting.
 *
 * `strict` controls failure handling:
 *  - `false` (default) — best-effort: a failed `rm` is logged and swallowed.
 *    Used for post-success and failure-path cleanup, where a cleanup hiccup must
 *    never abort an already-committed import or mask the controlling error.
 *  - `true` — a real `rm` failure propagates. Used pre-stage (see
 *    `prepareImportSiblings`): a leftover staging dir that can't be cleared would
 *    otherwise be enumerated and committed into the target by `commitStagedImport`
 *    (F1), so the import must abort instead. `force: true` still suppresses the
 *    common no-stale-dir ENOENT case, so the happy path never throws.
 */
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
    await rm(path, { recursive: true, force: true });
    return;
  }
  await rm(path, { recursive: true, force: true })
    .catch((rmError: unknown) => log.warn({ error: serializeError(rmError), path, label }, 'Failed to remove import sibling — continuing'));
}

/** List bare file names in a directory; empty array when the dir doesn't exist. */
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

/**
 * List audio files under `dir` at any depth, as paths RELATIVE to `dir`
 * (e.g. `Disc 1/old.mp3`). Empty array when the dir doesn't exist.
 *
 * The gate that admits an import into the staged-swap path (`getAudioPathSize`)
 * recurses, so a populated target whose audio is nested under subdirectories is
 * accepted — but the commit's backup step must then enumerate that nested audio
 * too, or it survives and recreates the mixed-edition chimera (#1287 F7).
 * Recursion is a no-op for already-flat folders, so the re-import path that
 * reuses `commitStagedImport` is unaffected.
 */
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
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(entry.name);
    } else if (entry.isDirectory()) {
      const nested = await listAudioFilesRecursive(join(dir, entry.name));
      results.push(...nested.map((rel) => join(entry.name, rel)));
    }
  }
  return results;
}

// ── prepareImportSiblings ───────────────────────────────────────────────

export interface PrepareImportSiblingsArgs {
  stagingPath: string;
  /** The import target folder — used to derive the commit-pending marker path. */
  targetPath: string;
  backupPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * Clear stale `.import-tmp` / `.import-bak` siblings before staging a fresh import,
 * recovering first when a process-killed commit left originals stranded (#1290).
 *
 * Staging is always re-derivable scratch — strict-cleared unconditionally.
 *
 * For the backup, the commit-pending marker disambiguates two byte-for-byte
 * identical on-disk states (see #1290): if the marker is PRESENT, a prior commit
 * was interrupted and `recoverInterruptedBackup` restores the originals before
 * clearing; if ABSENT, `.import-bak` is disposable (stale scratch or a post-success
 * cleanup leftover) and is strict-cleared as before — no restore, no behavior change.
 *
 * STRICT clearing: a stale staging dir that survives would be committed into the
 * target by `commitStagedImport` (F1), and a surviving backup could shadow a fresh
 * one, so a real `rm` failure aborts the import. `force: true` suppresses the common
 * no-stale-dir ENOENT case, so the happy path never throws.
 */
export async function prepareImportSiblings(args: PrepareImportSiblingsArgs): Promise<void> {
  const { stagingPath, targetPath, backupPath, libraryRoot, log } = args;
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging', { strict: true });
  if (await markerExists(markerPathFor(targetPath))) {
    await recoverInterruptedBackup({ targetPath, backupPath, libraryRoot, log });
  } else {
    await removeImportSibling(backupPath, libraryRoot, log, 'backup', { strict: true });
  }
}

// ── commitStagedImport ──────────────────────────────────────────────────

export interface CommitStagedImportArgs {
  stagingPath: string;
  targetPath: string;
  backupPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * Move each backed-up relative path (possibly nested, e.g. `Disc 1/old.mp3`) from
 * `.import-bak` back into `targetPath`, recreating the subdir first. `rename()`
 * atomically replaces any file already at the destination (the backup is
 * authoritative — a half-moved-in new-edition file at the same relative path is
 * overwritten in place, never skipped). Shared by `rollbackStagedCommit` (in-process
 * commit failure) and `recoverInterruptedBackup` (next-boot recovery) so they stay
 * in sync.
 *
 * `strict` controls failure handling:
 *  - `false` — best-effort: each failed step is logged and swallowed, so a rollback
 *    hiccup never masks the original commit error.
 *  - `true` — a real failure propagates, so the caller can preserve `.import-bak`
 *    and the marker for the next boot (recovery idempotency).
 */
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

/**
 * Roll the just-disturbed audio set back into place after a commit fails:
 * remove any staged files already moved into the target, then move the
 * backed-up originals back. Each step is best-effort and logged; failures here
 * never mask the original commit error (the caller rethrows that).
 */
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

// ── recoverInterruptedBackup ────────────────────────────────────────────

export interface RecoverInterruptedBackupArgs {
  targetPath: string;
  backupPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * Recover originals stranded in `.import-bak` by a process-killed commit (SIGKILL,
 * OOM, power loss — none of which run the in-process rollback). Triggered ONLY when
 * the commit-pending marker is present (proof a destructive commit was interrupted),
 * never on `.import-bak` content alone, which on a marker-absent path is a disposable
 * success-leftover (#1290).
 *
 * Restores every backed-up audio file (RECURSIVELY, preserving nested relative paths)
 * into `targetPath`, overwriting any half-moved-in new-edition file at the same
 * relative path (the backup is authoritative — mirrors `rollbackStagedCommit`). On
 * success, strict-clears `.import-bak` and removes the marker so the fresh import
 * proceeds. A failure partway throws `BackupRecoveryError` BEFORE clearing either, so
 * the caller's cleanup preserves the still-unrestored originals and the marker for the
 * next boot (which re-triggers recovery and converges, since already-restored files
 * were `rename()`d out of the backup).
 */
async function recoverInterruptedBackup(args: RecoverInterruptedBackupArgs): Promise<void> {
  const { targetPath, backupPath, libraryRoot, log } = args;
  const backedUp = await listAudioFilesRecursive(backupPath);
  if (backedUp.length > 0) {
    log.info({ targetPath, files: backedUp.length }, 'Recovering interrupted import commit — restoring backed-up audio from .import-bak');
    try {
      assertPathInsideLibrary(targetPath, libraryRoot);
      assertPathInsideLibrary(backupPath, libraryRoot);
      await restoreBackedUpFiles(targetPath, backupPath, backedUp, log, { strict: true });
    } catch (recoveryError: unknown) {
      throw new BackupRecoveryError(targetPath, { cause: recoveryError });
    }
  }
  // All originals restored (or the marker was present with an empty backup — an
  // in-process rollback already restored them, so nothing to do). Clear the now-empty
  // backup and the marker so the fresh import re-stages normally.
  await removeImportSibling(backupPath, libraryRoot, log, 'backup', { strict: true });
  await removeMarker(targetPath, libraryRoot, log);
}

/**
 * Commit a verified staged import into `targetPath` reversibly.
 *
 * For a same-path re-import `targetPath` IS the user's existing book folder, so
 * the swap must never destroy the old version before the new one is in place:
 *   1. Back up existing audio (RECURSIVELY, #1287 F7) — per-file `rename()` into
 *      the `.import-bak` sibling, preserving each file's relative path. Non-audio
 *      files (cover, metadata) stay in `targetPath` untouched at any depth.
 *   2. Move the verified staged audio files from `.import-tmp` into `targetPath`.
 *   3. On any failure in 1–2, roll back: remove staged files already moved in
 *      and restore the backed-up audio, leaving the existing book intact.
 *   4. On success, remove the backup + staging siblings — only the new version
 *      remains in `targetPath`.
 *
 * For a first import / move-path re-import there is no existing audio, so the
 * backup step is a no-op and this reduces to "move staged files in". Every
 * destructive step is guarded by `assertPathInsideLibrary` (#759).
 */
export async function commitStagedImport(args: CommitStagedImportArgs): Promise<void> {
  const { stagingPath, targetPath, backupPath, libraryRoot, log } = args;
  assertPathInsideLibrary(stagingPath, libraryRoot);
  assertPathInsideLibrary(backupPath, libraryRoot);
  assertPathInsideLibrary(targetPath, libraryRoot);

  await mkdir(targetPath, { recursive: true });

  // Existing target audio is enumerated RECURSIVELY (#1287 F7): the gate that
  // routes here (`getAudioPathSize`) recurses, so audio nested under target
  // subdirectories must be backed up too or it survives the swap as a chimera.
  const existingAudio = await listAudioFilesRecursive(targetPath);
  const stagedFiles = await listDirFileNames(stagingPath, false);

  const markerPath = markerPathFor(targetPath);
  const backedUp: string[] = [];
  const movedIn: string[] = [];
  try {
    if (existingAudio.length > 0) {
      await mkdir(backupPath, { recursive: true });
      // Bracket the destructive window with the commit-pending marker (#1290).
      // Writing it FIRST means a marker-write failure aborts before anything is
      // moved — nothing destroyed. A first import / empty target never writes it.
      assertPathInsideLibrary(markerPath, libraryRoot);
      await writeFile(markerPath, '');
      for (const rel of existingAudio) {
        // Preserve the relative path inside the backup so a rollback can restore
        // nested audio to exactly where it came from.
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
    // Authoritative commit-completion signal: strict marker removal as the LAST
    // step inside the commit `try`. A real failure here runs the rollback below
    // and rethrows, so the import retries rather than leaving an ambiguous marker.
    // `force: true` keeps the first-import/no-marker case a quiet no-op.
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

// ── cleanupImportSiblings ───────────────────────────────────────────────

export interface CleanupImportSiblingsArgs {
  stagingPath: string;
  backupPath: string;
  /** Import target folder — used to derive the commit-pending marker to remove. */
  targetPath?: string | undefined;
  libraryRoot?: string | undefined;
  log: FastifyBaseLogger;
  /**
   * True when the controlling failure was a `BackupRecoveryError` — a kill-recovery
   * was mid-flight, so `.import-bak` and the marker MUST survive for the next boot
   * (#1290). Staging is still cleared (always re-derivable scratch).
   */
  preserveBackup?: boolean | undefined;
}

/**
 * Best-effort removal of the transient `.import-tmp` / `.import-bak` siblings (and
 * the commit-pending marker), guarded by the library-root ancestry check (#759).
 * Used on the failure path of `stagedAudioReplace` (`commitStagedImport` already
 * rolls the target back; this just clears the leftover scratch dirs). A cleanup
 * hiccup is logged, never thrown.
 *
 * When `preserveBackup` is set (the failure was a recovery failure), the backup and
 * marker are left on disk so the next boot can re-attempt recovery — only staging is
 * cleared. Otherwise the marker is removed too so it does not accumulate.
 */
export async function cleanupImportSiblings(args: CleanupImportSiblingsArgs): Promise<void> {
  const { stagingPath, backupPath, targetPath, libraryRoot, log, preserveBackup } = args;
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
  if (preserveBackup) return;
  await removeImportSibling(backupPath, libraryRoot, log, 'backup');
  if (targetPath) await removeMarker(targetPath, libraryRoot, log);
}

// ── stagedAudioReplace ──────────────────────────────────────────────────

export interface StagedAudioReplaceArgs {
  /** The user's existing book folder — already contains audio (caller-gated). */
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
  /** Expected source audio bytes, for staged-copy verification. */
  sourceAudioSize: number;
  /** Copy the new version's audio, FLATTENED to the staging dir's top level. */
  stage: (stagingPath: string) => Promise<void>;
}

/**
 * Replace a populated target's audio via #1255's staged-swap machinery, for the
 * manual-import path (#1287). The manual path's direct merge-copy would coexist a
 * differently-structured new edition with the old files in one folder — exactly
 * the Frankenbook #1252/#1255 closed for the re-import path.
 *
 *   1. Clear stale siblings, then `stage()` the new audio (flattened to the top
 *      level) into `.import-tmp` and verify it there — the populated target is
 *      never touched, so a mid-copy failure can't corrupt the existing files.
 *   2. `commitStagedImport` backs the existing target audio (at any depth) aside
 *      to `.import-bak`, moves the staged audio in, and rolls back on failure.
 *      Pre-existing non-audio files are preserved.
 *   3. On any failure, clear the transient siblings and rethrow (the caller marks
 *      the import job/book failed).
 *
 * Returns the verified staged audio byte size.
 */
export async function stagedAudioReplace(args: StagedAudioReplaceArgs): Promise<number> {
  const { targetPath, libraryRoot, log, sourceAudioSize, stage } = args;
  const stagingPath = `${targetPath}.import-tmp`;
  const backupPath = `${targetPath}.import-bak`;
  try {
    await prepareImportSiblings({ stagingPath, targetPath, backupPath, libraryRoot, log });
    await stage(stagingPath);
    const stagedSize = await getAudioPathSize(stagingPath);
    assertCopyVerified(sourceAudioSize, stagedSize);
    await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log });
    return stagedSize;
  } catch (error: unknown) {
    await cleanupImportSiblings({ stagingPath, backupPath, targetPath, libraryRoot, log, preserveBackup: error instanceof BackupRecoveryError });
    throw error;
  }
}
