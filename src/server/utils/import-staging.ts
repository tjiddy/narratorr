/**
 * Staged-import machinery (`.import-tmp` / `.import-bak`) shared by the re-import
 * path (`import.service.ts`) and the manual-import path (#1287). A populated target
 * is never mutated in place: the new audio is staged into a sibling, verified, then
 * atomically swapped in while the existing audio is backed up and rolled back on
 * failure. Every destructive step is guarded by `assertPathInsideLibrary` (#759).
 */
import { rm, mkdir, readdir, rename } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { serializeError } from './serialize-error.js';
import { getAudioPathSize, COPY_VERIFICATION_THRESHOLD } from './import-helpers.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

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
  backupPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/**
 * Clear any stale `.import-tmp` / `.import-bak` siblings left behind by a
 * previously interrupted import before staging a fresh one. Guarded and STRICT:
 * a stale staging dir that survives cleanup would be enumerated and committed
 * into the target by `commitStagedImport` (F1), and a surviving backup dir could
 * shadow a fresh backup, so a real `rm` failure aborts the import rather than
 * proceeding over leftover state. `force: true` suppresses the common
 * no-stale-dir ENOENT case, so the happy path never throws.
 */
export async function prepareImportSiblings(args: PrepareImportSiblingsArgs): Promise<void> {
  const { stagingPath, backupPath, libraryRoot, log } = args;
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging', { strict: true });
  await removeImportSibling(backupPath, libraryRoot, log, 'backup', { strict: true });
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
  for (const rel of backedUp) {
    // `rel` may be nested (e.g. `Disc 1/old.mp3`); recreate the subdir the
    // backup was lifted out of before restoring it to its original location.
    const sub = dirname(rel);
    if (sub !== '.') {
      await mkdir(join(targetPath, sub), { recursive: true })
        .catch((rollbackError: unknown) => log.error({ error: serializeError(rollbackError), file: rel }, 'Rollback: failed to recreate target subdirectory for backed-up audio'));
    }
    await rename(join(backupPath, rel), join(targetPath, rel))
      .catch((rollbackError: unknown) => log.error({ error: serializeError(rollbackError), file: rel }, 'Rollback: failed to restore backed-up audio to target'));
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

  const backedUp: string[] = [];
  const movedIn: string[] = [];
  try {
    if (existingAudio.length > 0) {
      await mkdir(backupPath, { recursive: true });
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
  libraryRoot?: string | undefined;
  log: FastifyBaseLogger;
}

/**
 * Best-effort removal of the transient `.import-tmp` / `.import-bak` siblings,
 * guarded by the library-root ancestry check (#759). Used on the failure path of
 * `stagedAudioReplace` (`commitStagedImport` already rolls the target back; this
 * just clears the leftover scratch dirs). A cleanup hiccup is logged, never thrown.
 */
export async function cleanupImportSiblings(args: CleanupImportSiblingsArgs): Promise<void> {
  const { stagingPath, backupPath, libraryRoot, log } = args;
  await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
  await removeImportSibling(backupPath, libraryRoot, log, 'backup');
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
    await prepareImportSiblings({ stagingPath, backupPath, libraryRoot, log });
    await stage(stagingPath);
    const stagedSize = await getAudioPathSize(stagingPath);
    if (stagedSize < sourceAudioSize * COPY_VERIFICATION_THRESHOLD) {
      throw new Error(`Copy verification failed: source ${sourceAudioSize} bytes, target ${stagedSize} bytes`);
    }
    await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log });
    return stagedSize;
  } catch (error: unknown) {
    await cleanupImportSiblings({ stagingPath, backupPath, libraryRoot, log });
    throw error;
  }
}
