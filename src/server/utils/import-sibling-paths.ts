// Single server-side derivation for active, legacy, and marker siblings. Keep node:path
// here: the core suffix registry reaches the browser bundle.
import { dirname, basename, join } from 'node:path';
import {
  STAGING_SUFFIX,
  BACKUP_SUFFIX,
  LEGACY_STAGING_SUFFIX,
  LEGACY_BACKUP_SUFFIX,
  MARKER_SUFFIX,
} from '@core/utils/import-sibling-suffixes.js';

export interface ImportSiblings {
  stagingPath: string;
  backupPath: string;
  legacyStagingPath: string;
  legacyBackupPath: string;
  markerPath: string;
}

// Prefix exactly one dot even for hidden targets; idempotent dot-prefixing would collide
// `Title` with `.Title`. Keep the same parent so final rename stays atomic.
function activeScratchPath(targetPath: string, suffix: string): string {
  const dir = dirname(targetPath);
  const name = `.${basename(targetPath)}${suffix}`;
  return dir === '.' ? name : join(dir, name);
}

export function deriveImportSiblings(targetPath: string): ImportSiblings {
  return {
    stagingPath: activeScratchPath(targetPath, STAGING_SUFFIX),
    backupPath: activeScratchPath(targetPath, BACKUP_SUFFIX),
    legacyStagingPath: `${targetPath}${LEGACY_STAGING_SUFFIX}`,
    legacyBackupPath: `${targetPath}${LEGACY_BACKUP_SUFFIX}`,
    markerPath: `${targetPath}${MARKER_SUFFIX}`,
  };
}
