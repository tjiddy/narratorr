// Boot-time convergence for stranded import commit markers (#1338).
import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  MARKER_SUFFIX,
  LEGACY_SCRATCH_SUFFIXES,
  ACTIVE_SCRATCH_SUFFIXES,
} from '@core/utils/import-sibling-suffixes.js';
import { prepareImportSiblings, BackupAmbiguityError } from './import-staging.js';
import { serializeError } from './serialize-error.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';

function targetPathFromMarker(markerPath: string): string {
  return markerPath.slice(0, -MARKER_SUFFIX.length);
}

// Skip a scratch-suffixed directory only beside its live marker; real folders may share
// those suffixes. Active names drop exactly one leading dot, preserving hidden targets.
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

// Markers may live at arbitrary depth. Ignore ENOENT races, and descend into suffix-named
// directories unless isScratchSibling proves they are transient.
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
  converged: number;
  skipped: string[];
}

// Run before queue drain so only one actor mutates a marker. Each failure preserves its
// state and does not stop the sweep; containment rejects targets outside the library.
export async function sweepCommitPendingMarkers(
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<MarkerSweepResult> {
  let markerPaths: string[];
  try {
    markerPaths = await findCommitPendingMarkers(libraryRoot);
  } catch (walkError: unknown) {
    // A root walk failure skips this boot; ENOENT is already treated as empty.
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

// Returns false with state intact for containment or recovery failures, so one marker
// cannot abort the sweep.
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
    // Two populated backup conventions require operator choice; retry cannot disambiguate.
    if (recoveryError instanceof BackupAmbiguityError) {
      log.warn(
        { markerPath, targetPath, activeBackupPath: recoveryError.activeBackupPath, legacyBackupPath: recoveryError.legacyBackupPath },
        'Marker sweep: ambiguous stranded backups (BOTH conventions populated) — operator must remove/quarantine one backup; marker skipped, NO automatic retry',
      );
      return false;
    }
    // Failed recovery retains the backup and marker for the next boot.
    log.warn({ error: serializeError(recoveryError), markerPath, targetPath }, 'Marker sweep: could not converge stranded marker — state preserved, retry on next boot');
    return false;
  }
}
