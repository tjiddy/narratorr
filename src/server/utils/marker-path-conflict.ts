/**
 * Marker-path collision guard (#1341). A metadata-derived folder can be named to collide
 * with the commit-pending marker path `<target>.import-commit-pending`, putting a DIRECTORY
 * (or any non-file) where a marker file would live. Reads in `import-staging.ts` treat such
 * a non-file as marker-ABSENT (`markerExists` `isFile`); this preflight is the destructive-
 * flow counterpart, aborting a full import BEFORE any sibling clearing so that absent-read
 * can't trigger a strict-clear of an adjacent `.import-bak`.
 */
import { stat } from 'node:fs/promises';
import { MARKER_SUFFIX } from '../../core/utils/import-sibling-suffixes.js';

/**
 * Thrown when a non-file (typically a directory) occupies the commit-pending marker path
 * `<target>.import-commit-pending` (#1341). The shared preflight (`assertMarkerPathWritable`)
 * aborts every full import entry path with THIS named error before any destructive sibling
 * clearing, so the directory reading as marker-ABSENT can't strict-clear an adjacent
 * `.import-bak` and `commitStagedImport`'s `writeFile` never hits a raw `EISDIR`. Abort-only:
 * the operator resolves the stray folder; the import does not touch it.
 */
export class MarkerPathConflictError extends Error {
  readonly code = 'MARKER_PATH_CONFLICT' as const;
  constructor(
    public readonly markerPath: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Cannot import: a non-file already occupies the commit-pending marker path "${markerPath}" — remove or rename the stray folder and retry`,
      options,
    );
    this.name = 'MarkerPathConflictError';
  }
}

/**
 * Marker-path collision preflight (#1341). Run at the START of every full import entry path
 * — `stagedAudioReplace`, the auto-import pipeline (`import.service.ts`), and the manual
 * `recoverInterruptedCommit` — BEFORE `prepareImportSiblings` and OUTSIDE the destructive
 * try/catch. A non-file occupying the marker path throws `MarkerPathConflictError` so the
 * import aborts before any sibling is strict-cleared or backed up: the load-bearing guard
 * the read-side `isFile` change alone can't provide (a directory there reads as
 * marker-ABSENT → strict-clear branch + failure-cleanup `.import-bak` soft-remove). Absent
 * (ENOENT) or a real marker file → no-op; a genuine non-ENOENT stat error propagates raw.
 */
export async function assertMarkerPathWritable(targetPath: string): Promise<void> {
  const markerPath = `${targetPath}${MARKER_SUFFIX}`;
  let stats;
  try {
    stats = await stat(markerPath);
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw statError;
  }
  if (!stats.isFile()) {
    throw new MarkerPathConflictError(markerPath);
  }
}
