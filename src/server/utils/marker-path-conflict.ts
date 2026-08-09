/** Abort destructive import setup when a non-file occupies the marker path. */
import { stat } from 'node:fs/promises';
import { MARKER_SUFFIX } from '@core/utils/import-sibling-suffixes.js';

/** A non-file occupies the commit-pending marker path and requires operator cleanup. */
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
 * Run before sibling preparation and outside destructive cleanup. ENOENT and real marker
 * files pass; non-files throw MarkerPathConflictError and other stat failures propagate.
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
