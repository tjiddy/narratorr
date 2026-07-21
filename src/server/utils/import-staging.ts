/**
 * Staged-import machinery shared by the re-import path (`import.service.ts`) and the
 * manual-import path (#1287). A populated target is never mutated in place: the new audio is
 * staged into a sibling, verified, then atomically swapped in while the existing audio is
 * backed up and rolled back on failure. Every destructive step is guarded by
 * `assertPathInsideLibrary` (#759).
 *
 * The active scratch siblings are BORN HIDDEN (`.<name>.import-staging` / `.import-backup`,
 * #1911) so neither Audiobookshelf nor narratorr's own walker ingests them mid-copy; the
 * legacy un-dotted `.import-tmp` / `.import-bak` names are recognition-only (recovered/cleaned
 * when their target is next prepared, never created going forward). All sibling paths are
 * derived through the one shared helper in `import-sibling-paths.ts`.
 */
import { rm, mkdir, readdir, rename, writeFile, stat, open } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS, isHiddenName } from '../../core/utils/index.js';
import { MARKER_SUFFIX } from '../../core/utils/import-sibling-suffixes.js';
import { deriveImportSiblings, type ImportSiblings } from './import-sibling-paths.js';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
import { serializeError } from './serialize-error.js';
import { getAudioPathSize, assertCopyVerified } from './import-helpers.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

// ── commit-pending marker ───────────────────────────────────────────────

/**
 * Thrown when `recoverInterruptedBackup` fails partway through restoring the originals
 * stranded in a backup (active `.import-backup` or legacy `.import-bak`) by a process-killed
 * commit. The failure-path cleanup recognizes this type and skips removing the backup and the
 * commit-pending marker, so the still-unrestored originals survive for the next boot's
 * recovery attempt (idempotency, #1290). Carries the ACTUAL backup path(s) + convention so
 * the message / 503 names the real path (#1911 F13).
 */
export class BackupRecoveryError extends Error {
  readonly code = 'BACKUP_RECOVERY_FAILED' as const;
  readonly backupPaths: readonly string[];
  /** The convention of the failing backup, when a single one was selected (#1911 F13). */
  readonly convention?: 'active' | 'legacy';
  constructor(
    public readonly targetPath: string,
    options?: { backupPaths?: readonly string[]; convention?: 'active' | 'legacy'; cause?: unknown },
  ) {
    // Message must name the REAL backup path(s) (#1911 F13): the active convention fails on
    // `.import-backup`, the legacy on `.import-bak`, and a pre-selection enumeration failure
    // names BOTH candidates. Defaults to both derived backups so a caller that omits the
    // paths still names a truthful set rather than the old hard-coded `.import-bak`.
    const paths =
      options?.backupPaths && options.backupPaths.length > 0
        ? options.backupPaths
        : [`${targetPath}.import-backup`, `${targetPath}.import-bak`];
    // Remedy guidance: now user-reachable from the manual-import gate (#1337), so the
    // message must tell the operator where to look and that the failure self-heals on retry.
    super(
      `Failed to recover interrupted import backup for "${targetPath}" — check permissions on ${paths.map((p) => `"${p}"`).join(' / ')}; retrying (or the next boot's marker sweep) re-attempts recovery`,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.backupPaths = paths;
    if (options?.convention) this.convention = options.convention;
    this.name = 'BackupRecoveryError';
  }
}

/**
 * Thrown when a marker-present recovery observes POPULATED backups for BOTH conventions
 * (#1911 AC10). Unreachable by construction — every writer runs the recover-or-throw seam
 * before its commit phase, so a stranded legacy backup+marker is always recovered (or the
 * writer aborts) before any active backup for the same target can exist. When it does occur
 * it is a genuine operator-visible ambiguity: automatic recovery cannot choose which backup
 * holds the real originals, so it preserves EVERYTHING and throws. NON-retryable and
 * non-convergent (mirrors `MarkerPathConflictError → 409`, NOT the transient
 * `BackupRecoveryError → 503`): remedy is operator removal/quarantine of one backup.
 */
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
    if (isHiddenName(entry.name)) continue; // never back up / restore a born-hidden temp or dot-dir subtree
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
  /** The import target folder. ALL sibling paths (active + legacy + marker) are derived from
   * it via the ONE shared helper — callers no longer pass composed scratch paths (#1911). */
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * The single marker-gated recovery/cleanup seam (#1290/#1911). Convention-aware: for a
 * target `T` it derives BOTH conventions' scratch — active born-hidden `.T.import-staging` /
 * `.T.import-backup` and legacy un-dotted `T.import-tmp` / `T.import-bak` — plus the marker
 * `T.import-commit-pending`. Used identically by the boot sweep and every mid-uptime writer
 * BEFORE it stages/commits, so no caller mutates over unresolved state.
 *
 * A SUCCESSFUL RETURN IS A PROCEED SIGNAL and happens ONLY after any interrupted-commit
 * state is recovered, BOTH conventions' scratch is cleared, and the marker is legitimately
 * removed. Otherwise the seam THROWS:
 *
 *   • Marker ABSENT → no interrupted commit: all four derived siblings are disposable scratch
 *     for `T` and are strict-cleared by their DERIVED names (cleans a markerless legacy
 *     leftover, incl. an ABS-visible un-dotted `T.import-bak`). Returns success; caller stages.
 *   • Marker PRESENT → a destructive commit was interrupted. `recoverInterruptedBackup`
 *     enumerates BOTH backups, restores the (at most one) populated one, strict-clears both
 *     conventions' staging AND backup dirs, then strict-removes the marker — or throws the
 *     preservation error (marker + populated backup retained), or the non-retryable ambiguity
 *     error when both backups are populated.
 *
 * STRICT clearing: a stale staging dir that survives would be committed into the target by
 * `commitStagedImport` (F1), and a surviving backup could shadow a fresh one, so a real `rm`
 * failure aborts. `force: true` suppresses the common no-stale-dir ENOENT case, so the happy
 * path never throws.
 */
export async function prepareImportSiblings(args: PrepareImportSiblingsArgs): Promise<void> {
  const { targetPath, libraryRoot, log } = args;
  const s = deriveImportSiblings(targetPath);

  // Consult the marker FIRST (#1336 defense-in-depth). Once we've seen it, a destructive
  // commit was interrupted and EVERYTHING that follows must surface as a `BackupRecoveryError`
  // so the failure-cleanup path preserves the backup + marker for the next boot rather than
  // deleting the stranded originals. A non-ENOENT marker stat error must not propagate raw
  // (it would reach cleanup as a plain Error and delete the backup); convert it → preserve.
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
    // No interrupted commit: both conventions' siblings are disposable scratch for `T`,
    // strict-cleared by derived name (F12 marker-absent both-convention cleanup).
    await removeImportSibling(s.stagingPath, libraryRoot, log, 'staging', { strict: true });
    await removeImportSibling(s.backupPath, libraryRoot, log, 'backup', { strict: true });
    await removeImportSibling(s.legacyStagingPath, libraryRoot, log, 'staging', { strict: true });
    await removeImportSibling(s.legacyBackupPath, libraryRoot, log, 'backup', { strict: true });
    return;
  }

  await recoverInterruptedBackup({ targetPath, siblings: s, libraryRoot, log });
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
  siblings: ImportSiblings;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * Enumerate one backup convention's audio. Returns the audio relative-path list (empty when
 * the dir is absent or present-empty — neither is "populated"). A non-ENOENT enumeration
 * error surfaces as a `BackupRecoveryError` naming THIS backup (→ preserve, #1336), never a
 * raw throw that would reach cleanup and delete the stranded originals.
 */
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

/**
 * Marker-present recovery — the interrupted-commit total-cleanup policy (#1911 F10/F17/F25).
 * Triggered ONLY when the commit-pending marker is present (proof a destructive commit was
 * interrupted), never on backup content alone, which on a marker-absent path is a disposable
 * success-leftover (#1290).
 *
 * Enumerates BOTH conventions' backups first (F10 — nothing is cleared or the marker removed
 * before both are classified). A backup is absent / present-empty / present-populated /
 * enumeration-failure; "populated" means "contains audio to restore".
 *   • BOTH present-populated (unreachable by construction) → throw the non-retryable
 *     `BackupAmbiguityError`, preserving all state; no clear, no marker removal.
 *   • At most one present-populated → restore the populated one (if any) into `targetPath`
 *     (additive; the backup is authoritative — mirrors `rollbackStagedCommit`), then
 *     strict-clear BOTH conventions' staging dirs AND both backup dirs (none hold
 *     un-restored originals: the selected backup was just emptied, the other was classified
 *     not-populated), then strict-REMOVE the marker LAST (F18). Every marker-present success
 *     leaves the target with NO scratch of either convention.
 *
 * Any enumeration / restore / staging-or-backup strict-clear / marker-removal failure throws
 * `BackupRecoveryError` BEFORE the marker is removed, so the caller's cleanup preserves the
 * still-unrestored originals and the marker (recover-or-throw; idempotent on the next attempt).
 */
async function recoverInterruptedBackup(args: RecoverInterruptedBackupArgs): Promise<void> {
  const { targetPath, siblings, libraryRoot, log } = args;
  const { stagingPath, backupPath, legacyStagingPath, legacyBackupPath, markerPath } = siblings;

  // Enumerate BOTH backups before any mutation (F10 invariant).
  const activeFiles = await enumerateBackup(targetPath, backupPath, 'active');
  const legacyFiles = await enumerateBackup(targetPath, legacyBackupPath, 'legacy');

  if (activeFiles.length > 0 && legacyFiles.length > 0) {
    // Unreachable by construction: preserve everything, do not converge (#1911 AC10).
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
      // Recreate the target folder before restoring (#1338): if the user deleted the
      // half-replaced book folder while state was stranded, every flat-file restore rename
      // would ENOENT into a perpetual preserved-but-never-converging loop.
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

  // Total clean (F25): strict-clear BOTH conventions' staging dirs AND both backup dirs. None
  // hold un-restored originals (selected was emptied; the other convention is not-populated).
  // A failure on EITHER convention throws and RETAINS the marker (F25 iii).
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

  // Strict marker removal LAST (F18): its failure throws the preservation error so the seam
  // does NOT return success and the marker survives — NOT the best-effort `removeMarker`
  // (which logs-and-swallows and would return a false proceed signal). Mirrors
  // `commitStagedImport`'s authoritative strict `rm(markerPath)`.
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
  // Active born-hidden scratch (#1911): `.import-staging` / `.import-backup`, derived through
  // the ONE shared helper. Staging into a dot-led dir keeps ABS from ingesting it mid-copy.
  const { stagingPath, backupPath } = deriveImportSiblings(targetPath);
  // #1341 marker-path collision preflight — BEFORE the destructive try/catch, NOT inside it.
  // A directory at the marker path reads as marker-absent (#1341 `isFile`), which would send
  // `prepareImportSiblings` down its strict-clear branch destroying an adjacent `.import-bak`;
  // worse, the catch's `cleanupImportSiblings({ …, preserveBackup: markerPresent === false })`
  // would itself soft-remove that backup. Running the preflight here means the abort never
  // enters the try, so neither destructive path runs and the adjacent backup survives.
  await assertMarkerPathWritable(targetPath);
  try {
    await prepareImportSiblings({ targetPath, libraryRoot, log });
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
