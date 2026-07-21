/**
 * Boot-time convergence sweep for stranded `.import-commit-pending` markers (#1338). Split
 * out of `import-staging.ts` to keep that file under the line cap (#1911); it composes the
 * single marker-gated recovery seam (`prepareImportSiblings`) that still lives there.
 */
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  MARKER_SUFFIX,
  LEGACY_SCRATCH_SUFFIXES,
  ACTIVE_SCRATCH_SUFFIXES,
} from '../../core/utils/import-sibling-suffixes.js';
import { prepareImportSiblings, BackupAmbiguityError } from './import-staging.js';
import { serializeError } from './serialize-error.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

/** Inverse of the marker derivation: recover the target folder from a marker path. */
function targetPathFromMarker(markerPath: string): string {
  return markerPath.slice(0, -MARKER_SUFFIX.length);
}

/**
 * The marker walk skips descending into a true scratch sibling — but ONLY one that sits
 * beside its live commit-pending marker (#1338 F1); a real library folder that merely ends
 * in a scratch suffix is still walked.
 *
 * Recognizes BOTH conventions (#1911 AC13), each paired with the un-dotted marker on the
 * VISIBLE target basename:
 *   • Legacy `<base>.import-tmp` / `<base>.import-bak` → marker `<base>.import-commit-pending`.
 *   • Active `.<base>.import-staging` / `.<base>.import-backup` → strip the suffix AND exactly
 *     ONE leading dot to recover `<base>`, then pair with `<base>.import-commit-pending`
 *     (the marker is never dotted). A hidden target `.<base>` yields `..<base>.import-staging`,
 *     whose one-dot strip recovers `.<base>` — its own distinct marker.
 * A suffix-named folder with NO adjacent marker (either convention) is walked normally so any
 * marker beneath it is found.
 */
function isScratchSibling(dirName: string, siblingMarkerNames: Set<string>): boolean {
  const legacy = LEGACY_SCRATCH_SUFFIXES.some(
    (suffix) => dirName.endsWith(suffix) && siblingMarkerNames.has(`${dirName.slice(0, -suffix.length)}${MARKER_SUFFIX}`),
  );
  if (legacy) return true;
  return ACTIVE_SCRATCH_SUFFIXES.some(
    (suffix) =>
      dirName.startsWith('.') &&
      dirName.endsWith(suffix) &&
      siblingMarkerNames.has(`${dirName.slice(1, -suffix.length)}${MARKER_SUFFIX}`),
  );
}

/**
 * Recursively collect every `*.import-commit-pending` marker path under `root`.
 * Markers are siblings of the book folder (`<root>/<Author>/<Title>.import-commit-pending`)
 * and so live at arbitrary depth — the walk must descend, not just `readdir` the root.
 * ENOENT-tolerant at every level (mirrors `listAudioFilesRecursive`): a directory that
 * vanishes mid-walk contributes nothing rather than aborting the sweep.
 *
 * The only directories skipped are true scratch siblings (a scratch dir beside its live
 * marker — see `isScratchSibling`); every other directory, including one whose name merely
 * ends in a scratch suffix, is descended so no AC-owned marker is missed.
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
 * trigger: it walks the library root and converges each marker through
 * `prepareImportSiblings` — which recovers and clears BOTH conventions' scratch in one step
 * (idempotent: a second pass over a converged path is a no-op).
 *
 * Best-effort + preservation-preserving: a per-marker failure leaves that path's state
 * intact, logs a WARN naming it, and the loop continues to the next marker rather than
 * wedging an invisible eternal retry loop. Every destructive op is gated by
 * `assertPathInsideLibrary` inside `prepareImportSiblings`; the sweep additionally skips any
 * marker whose target escapes the root, never acting on a foreign path.
 *
 * MUST run inside the awaited boot-recovery phase, BEFORE the import-queue drain loop, so the
 * sweep and a draining import never `rename()` from the same backup concurrently
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
 * marker (and both conventions' scratch siblings) cleared, `false` when the path was left
 * intact — either because the derived target escapes `libraryRoot` (the
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
    await prepareImportSiblings({ targetPath, libraryRoot, log });
    return true;
  } catch (recoveryError: unknown) {
    // The non-retryable ambiguity error (both conventions' backups populated) is NOT a
    // transient failure that self-heals on the next boot (#1911 F19): log operator-action,
    // name both backup paths, and make NO automatic-retry promise. The marker is retained
    // (skipped) but this boot will not re-attempt it to a different outcome.
    if (recoveryError instanceof BackupAmbiguityError) {
      log.warn(
        { markerPath, targetPath, activeBackupPath: recoveryError.activeBackupPath, legacyBackupPath: recoveryError.legacyBackupPath },
        'Marker sweep: ambiguous stranded backups (BOTH conventions populated) — operator must remove/quarantine one backup; marker skipped, NO automatic retry',
      );
      return false;
    }
    // Preservation-preserving: `prepareImportSiblings`/`recoverInterruptedBackup` never clear
    // on a failed recovery, so backup + marker survive intact. Surface the non-convergent path
    // (otherwise it is an invisible eternal retry loop) and report it as not-converged.
    log.warn({ error: serializeError(recoveryError), markerPath, targetPath }, 'Marker sweep: could not converge stranded marker — state preserved, retry on next boot');
    return false;
  }
}
