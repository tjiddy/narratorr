/**
 * Staged-import machinery (`.import-tmp` / `.import-bak`) shared by the re-import
 * path (`import.service.ts`) and the manual-import path (#1287). A populated target
 * is never mutated in place: the new audio is staged into a sibling, verified, then
 * atomically swapped in while the existing audio is backed up and rolled back on
 * failure. Every destructive step is guarded by `assertPathInsideLibrary` (#759).
 */
import { rm, mkdir, readdir, rename, writeFile, stat, open } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { MARKER_SUFFIX, SCRATCH_SUFFIXES } from '../../core/utils/import-sibling-suffixes.js';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
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
    // Remedy guidance: now user-reachable from the manual-import gate (#1337), so the
    // message must tell the operator where to look and that the failure self-heals on retry.
    super(
      `Failed to recover interrupted import backup for "${targetPath}" — check permissions on "${targetPath}.import-bak"; retrying (or the next boot's marker sweep) re-attempts recovery`,
      options,
    );
    this.name = 'BackupRecoveryError';
  }
}

// MarkerPathConflictError + assertMarkerPathWritable (the #1341 marker-collision preflight)
// live in marker-path-conflict.ts to keep this file under the line cap; re-exported so
// existing importers (import-steps.ts, import.service.ts) keep their entry point.
// `assertMarkerPathWritable` is also imported above for stagedAudioReplace's own preflight.
export { MarkerPathConflictError } from './marker-path-conflict.js';
export { assertMarkerPathWritable } from './marker-path-conflict.js';

/**
 * Sibling marker file recording that a destructive commit is mid-flight. Its
 * presence (not `.import-bak` content, which can be a disposable success-leftover)
 * is the out-of-band signal that drives recovery (#1290).
 */
function markerPathFor(targetPath: string): string {
  return `${targetPath}${MARKER_SUFFIX}`;
}

/** Inverse of `markerPathFor`: derive the target folder from a marker path. */
function targetPathFromMarker(markerPath: string): string {
  return markerPath.slice(0, -MARKER_SUFFIX.length);
}

/** True when the commit-pending marker exists AS A FILE; false on ENOENT or when a non-file
 * (e.g. a metadata-collision directory, #1341) occupies the path — a directory is NOT a
 * marker, so reads treat it as marker-absent. A non-ENOENT stat error propagates raw —
 * callers decide (recovery wraps it as `BackupRecoveryError`; `markerPresent` fails toward
 * preservation). The destructive-flow hazard the `isFile` change introduces (a directory
 * read as absent → strict-clear of an adjacent `.import-bak`) is closed by the
 * `assertMarkerPathWritable` preflight below. */
async function markerExists(markerPath: string): Promise<boolean> {
  try {
    const stats = await stat(markerPath);
    return stats.isFile();
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw statError;
  }
}

/**
 * Marker-presence gate for the FAILURE-CLEANUP paths (`handleImportFailure` in
 * import-steps.ts and `stagedAudioReplace`'s catch): `.import-bak` and the marker must
 * NEVER be deleted while the commit-pending marker is on disk, regardless of which error
 * type reached cleanup (#1336). The prior gate keyed on error IDENTITY
 * (`error instanceof BackupRecoveryError`), so any failure that propagated as a plain
 * Error — a raw readdir/stat error during recovery, a pre-flight throw before recovery
 * even runs, or a `BackupRecoveryError` re-wrapped via `new Error(msg, { cause })` —
 * slipped past it and deleted the sole surviving copy of the stranded originals (the #1290
 * loss through a different door). The durable disk-state signal is authoritative; error
 * identity is no longer load-bearing.
 *
 * Derives the marker path from `targetPath` (markers are derived, never stored) and FAILS
 * TOWARD PRESERVATION: a non-ENOENT stat error returns `true` (treat as present). The only
 * safe wrong answer is keeping a disposable backup an extra boot — the next run's recovery
 * no-ops and clears it; the unsafe wrong answer is deleting the only copy of stranded
 * originals because a stat flaked.
 */
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

  // Consult the marker FIRST (#1336 defense-in-depth). Once we've seen it, a destructive
  // commit was interrupted and EVERYTHING that follows — the staging clear included — must
  // surface as a `BackupRecoveryError` so the failure-cleanup path preserves `.import-bak`
  // and the marker for the next boot rather than deleting the stranded originals. A
  // non-ENOENT marker stat error must not propagate raw (it would reach cleanup as a plain
  // Error and delete the backup); convert it to a recovery failure → preserve.
  let markerPresentOnDisk: boolean;
  try {
    markerPresentOnDisk = await markerExists(markerPathFor(targetPath));
  } catch (statError: unknown) {
    throw new BackupRecoveryError(targetPath, { cause: statError });
  }

  if (!markerPresentOnDisk) {
    // No interrupted commit: both siblings are disposable scratch, strict-cleared as before.
    await removeImportSibling(stagingPath, libraryRoot, log, 'staging', { strict: true });
    await removeImportSibling(backupPath, libraryRoot, log, 'backup', { strict: true });
    return;
  }

  // Marker present: a killed commit characteristically leaves a populated `.import-tmp`, so
  // an EBUSY/EACCES on the staging clear is most likely on exactly this recovery boot. Wrap
  // it (and the recovery itself) so a failure preserves the backup instead of propagating raw.
  try {
    await removeImportSibling(stagingPath, libraryRoot, log, 'staging', { strict: true });
  } catch (clearError: unknown) {
    throw new BackupRecoveryError(targetPath, { cause: clearError });
  }
  await recoverInterruptedBackup({ targetPath, backupPath, libraryRoot, log });
}

// ── startup marker sweep (#1338) ─────────────────────────────────────────

/**
 * `SCRATCH_SUFFIXES` (`.import-tmp` / `.import-bak`) is the shared reserved list from
 * `src/core/utils/import-sibling-suffixes.ts` (#1341). The marker walk skips descending
 * into a true scratch sibling — but ONLY one that sits beside its live commit-pending
 * marker (see `isScratchSibling`); a real library folder that merely ends in the same
 * suffix is still walked (#1338 F1).
 *
 * True only for an ACTUAL transient scratch sibling: a directory `<base>.import-tmp` /
 * `<base>.import-bak` that sits next to a live `<base>.import-commit-pending` marker at the
 * same level. The marker sibling is what distinguishes real scratch (created by an
 * interrupted commit, which always writes the marker first) from a legitimately-named
 * library folder that coincidentally ends in `.import-bak`/`.import-tmp` (#1338 F1) — the
 * latter has no sibling marker, so it is walked normally and any marker beneath it is found.
 */
function isScratchSibling(dirName: string, siblingMarkerNames: Set<string>): boolean {
  return SCRATCH_SUFFIXES.some(
    (suffix) => dirName.endsWith(suffix) && siblingMarkerNames.has(`${dirName.slice(0, -suffix.length)}${MARKER_SUFFIX}`),
  );
}

/**
 * Recursively collect every `*.import-commit-pending` marker path under `root`.
 * Markers are siblings of the book folder (`<root>/<Author>/<Title>.import-commit-pending`)
 * and so live at arbitrary depth — the walk must descend, not just `readdir` the root.
 * ENOENT-tolerant at every level (mirrors `listAudioFilesRecursive`): a directory that
 * vanishes mid-walk contributes nothing rather than aborting the sweep.
 *
 * The only directories skipped are true scratch siblings (a `.import-tmp`/`.import-bak`
 * beside its live marker — see `isScratchSibling`); every other directory, including one
 * whose name merely ends in a scratch suffix, is descended so no AC-owned marker is missed.
 */
export async function findCommitPendingMarkers(root: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (readError: unknown) {
    if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw readError;
  }
  const siblingMarkerNames = new Set(
    entries.filter((e) => e.isFile() && e.name.endsWith(MARKER_SUFFIX)).map((e) => e.name),
  );
  const markers: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(MARKER_SUFFIX)) {
      markers.push(full);
    } else if (entry.isDirectory() && !isScratchSibling(entry.name, siblingMarkerNames)) {
      markers.push(...await findCommitPendingMarkers(full));
    }
  }
  return markers;
}

export interface MarkerSweepResult {
  /** Markers converged (recovered + cleared, or already-converged no-op-cleared). */
  converged: number;
  /** Marker paths the sweep could NOT converge — state preserved for the next attempt. */
  skipped: string[];
}

/**
 * Boot-time convergence sweep for stranded `.import-commit-pending` markers (#1338).
 *
 * #1290 recovery only fires when an import to the SAME recomputed targetPath runs again;
 * a failed download, a manual job, or a folderFormat/metadata change between crash and
 * retry orphans the marker + backup forever. This sweep decouples recovery from the retry
 * trigger: it walks the library root, derives each marker's target/staging/backup siblings,
 * and converges each through `prepareImportSiblings` — which clears the disposable
 * `.import-tmp` scratch *before* restoring from `.import-bak`, so marker + backup + scratch
 * all clear in one step (idempotent: a second pass over a converged path is a no-op).
 *
 * Best-effort + preservation-preserving: a per-marker failure (`BackupRecoveryError` on a
 * standing ENOTDIR/EACCES `.import-bak`) leaves that path's state intact, logs a WARN naming
 * it, and the loop continues to the next marker rather than wedging an invisible eternal
 * retry loop. Every destructive op is gated by `assertPathInsideLibrary` inside
 * `prepareImportSiblings`; the sweep additionally skips any marker whose target escapes the
 * root, never acting on a foreign path.
 *
 * MUST run inside the awaited boot-recovery phase, BEFORE the import-queue drain loop, so the
 * sweep and a draining import never `rename()` from the same `.import-bak` concurrently
 * (single recovery actor per marker — see `ImportQueueWorker.start()`).
 */
export async function sweepCommitPendingMarkers(
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<MarkerSweepResult> {
  let markerPaths: string[];
  try {
    markerPaths = await findCommitPendingMarkers(libraryRoot);
  } catch (walkError: unknown) {
    // Root traversal failed before any marker was enumerated (e.g. EACCES on the library
    // root). Warn and let boot proceed without draining marker recovery this pass (#1338 F3) —
    // ENOENT is already absorbed as "no markers" inside `findCommitPendingMarkers`.
    log.warn({ error: serializeError(walkError), libraryRoot }, 'Marker sweep: failed to walk library root — skipping marker recovery this boot');
    return { converged: 0, skipped: [] };
  }

  if (markerPaths.length === 0) {
    log.debug({ libraryRoot }, 'Marker sweep: no stranded commit-pending markers');
    return { converged: 0, skipped: [] };
  }

  log.info({ libraryRoot, count: markerPaths.length }, 'Marker sweep: converging stranded commit-pending markers');
  let converged = 0;
  const skipped: string[] = [];
  for (const markerPath of markerPaths) {
    if (await convergeStrandedMarker(markerPath, libraryRoot, log)) converged++;
    else skipped.push(markerPath);
  }
  log.info({ libraryRoot, converged, skipped: skipped.length, skippedPaths: skipped }, 'Marker sweep complete');
  return { converged, skipped };
}

/**
 * Converge a single stranded marker through `prepareImportSiblings`. Returns `true` when the
 * marker (and its `.import-bak` / `.import-tmp` siblings) cleared, `false` when the path was
 * left intact — either because the derived target escapes `libraryRoot` (the
 * `assertPathInsideLibrary` gate, so no destructive op runs on a foreign path) or because
 * recovery failed and preserved state for the next attempt. Never throws on a recovery
 * failure: it is logged and reported as not-converged so the sweep loop continues to the
 * next marker rather than wedging on one bad path.
 */
export async function convergeStrandedMarker(
  markerPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const targetPath = targetPathFromMarker(markerPath);
  try {
    assertPathInsideLibrary(targetPath, libraryRoot);
  } catch (gateError: unknown) {
    if (gateError instanceof PathOutsideLibraryError) {
      log.warn({ markerPath, libraryRoot }, 'Marker sweep: marker target escapes library root — skipping, not acting on foreign path');
      return false;
    }
    throw gateError;
  }
  try {
    await prepareImportSiblings({
      stagingPath: `${targetPath}.import-tmp`,
      targetPath,
      backupPath: `${targetPath}.import-bak`,
      libraryRoot,
      log,
    });
    return true;
  } catch (recoveryError: unknown) {
    // Preservation-preserving: `prepareImportSiblings`/`recoverInterruptedBackup` never clear
    // on a failed recovery, so backup + marker survive intact. Surface the non-convergent path
    // (otherwise it is an invisible eternal retry loop) and report it as not-converged.
    log.warn({ error: serializeError(recoveryError), markerPath, targetPath }, 'Marker sweep: could not converge stranded marker — state preserved, retry on next boot');
    return false;
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
 * the caller's cleanup preserves the still-unrestored originals and the marker.
 *
 * Convergence on the NEXT attempt is what clears a preserved marker — but that attempt
 * is not always a re-import of the same target. Re-import only re-triggers recovery when
 * the recomputed targetPath still matches; a failed/manual/path-recomputed job never
 * revisits the old target, so without the boot-time marker sweep (#1338) such markers
 * would strand forever. Either way recovery is idempotent: already-restored files were
 * `rename()`d out of the backup, so a re-run reads it empty and clears marker + backup.
 */
async function recoverInterruptedBackup(args: RecoverInterruptedBackupArgs): Promise<void> {
  const { targetPath, backupPath, libraryRoot, log } = args;
  // Enumeration sits INSIDE the wrapping try (#1336): a transient readdir EIO/EACCES here
  // must surface as a `BackupRecoveryError` (→ preserve), not propagate raw to the cleanup
  // path where it would delete `.import-bak` + the marker — the originals it strands.
  try {
    const backedUp = await listAudioFilesRecursive(backupPath);
    if (backedUp.length > 0) {
      log.info({ targetPath, files: backedUp.length }, 'Recovering interrupted import commit — restoring backed-up audio from .import-bak');
      assertPathInsideLibrary(targetPath, libraryRoot);
      assertPathInsideLibrary(backupPath, libraryRoot);
      // Recreate the target folder before restoring (#1338): if the user deleted the
      // half-replaced book folder while state was stranded, every flat-file restore rename
      // would ENOENT into a perpetual preserved-but-never-converging loop. Mirrors
      // `commitStagedImport`'s top-of-body `mkdir(targetPath)`; nested subdirs are still
      // created per-file in `restoreBackedUpFiles`.
      await mkdir(targetPath, { recursive: true });
      await restoreBackedUpFiles(targetPath, backupPath, backedUp, log, { strict: true });
    }
  } catch (recoveryError: unknown) {
    throw new BackupRecoveryError(targetPath, { cause: recoveryError });
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
/**
 * Best-effort fsync of a directory so a just-created child's directory entry is
 * durable, not merely the child file's own data. `writeFile(..., { flush: true })`
 * flushes the file's contents + metadata but NOT the parent directory entry, so
 * after a power loss the marker file could be absent even though its data was
 * flushed. Some filesystems reject `fsync` on a directory handle — swallow that
 * (logged at `debug`), since the file flush already covers the primary loss
 * window and the swallowed failure must not abort an otherwise-durable commit
 * (#1339). The handle is always closed (success and failure paths alike).
 */
async function syncDirectoryEntry(dirPath: string, log: FastifyBaseLogger): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(dirPath, 'r');
    await handle.sync();
  } catch (syncError: unknown) {
    log.debug({ error: serializeError(syncError), dirPath }, 'Best-effort directory fsync failed — file flush already covers durability');
  } finally {
    await handle?.close().catch(() => {});
  }
}

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
      // Flush the marker's contents (Node 24 `{ flush: true }`) BEFORE the first
      // destructive rename: POSIX gives no ordering guarantee between an un-fsync'd
      // write and the backup-out renames, so on power loss the renames could persist
      // while the marker did not — the original #1290 data-loss leg (#1339). A flush
      // failure rejects here, inside the pre-rename guard, so the commit aborts before
      // anything is moved (same abort semantics as a plain marker-write failure).
      await writeFile(markerPath, '', { flush: true });
      // The file flush syncs the marker's data, not its parent's directory entry —
      // best-effort fsync the directory so the entry itself survives a power loss too.
      await syncDirectoryEntry(dirname(markerPath), log);
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
   * True when the commit-pending marker is present on disk — a kill-recovery was
   * mid-flight (or a marker-protected commit failed), so `.import-bak` and the marker
   * MUST survive for the next boot (#1290/#1336). Computed from disk marker state by the
   * caller (`markerPresent`), NOT from the error's identity. Staging is still cleared
   * (always re-derivable scratch).
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
 * When `preserveBackup` is set (the commit-pending marker is present on disk), the backup
 * and marker are left on disk so the next boot can re-attempt recovery — only staging is
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
  // #1341 marker-path collision preflight — BEFORE the destructive try/catch, NOT inside it.
  // A directory at the marker path reads as marker-absent (#1341 `isFile`), which would send
  // `prepareImportSiblings` down its strict-clear branch destroying an adjacent `.import-bak`;
  // worse, the catch's `cleanupImportSiblings({ …, preserveBackup: markerPresent === false })`
  // would itself soft-remove that backup. Running the preflight here means the abort never
  // enters the try, so neither destructive path runs and the adjacent backup survives.
  await assertMarkerPathWritable(targetPath);
  try {
    await prepareImportSiblings({ stagingPath, targetPath, backupPath, libraryRoot, log });
    await stage(stagingPath);
    const stagedSize = await getAudioPathSize(stagingPath);
    assertCopyVerified(sourceAudioSize, stagedSize);
    await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log });
    return stagedSize;
  } catch (error: unknown) {
    // #1336: preservation rides on the durable disk marker, not the error's identity — a
    // kill-recovery (or any failure while a marker is live) must keep `.import-bak` + the
    // marker for the next boot, even when the failure reached us as a plain Error.
    await cleanupImportSiblings({ stagingPath, backupPath, targetPath, libraryRoot, log, preserveBackup: await markerPresent(targetPath, log) });
    throw error;
  }
}
