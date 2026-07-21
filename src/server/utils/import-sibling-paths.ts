/**
 * ONE server-side helper mapping an import target folder to every transient sibling path it
 * can carry — the active born-hidden scratch dirs (#1911), the legacy un-dotted scratch dirs
 * (recognition-only), and the commit-pending marker file. Every derivation site
 * (`import.service.ts`, `stagedAudioReplace`, `convergeStrandedMarker`,
 * `recover-interrupted-commit.ts`) routes through here so the four production callers can
 * never diverge on how a scratch name is composed.
 *
 * Lives in a server/Node-only module (imports `node:path`) — NOT in the import-free
 * `src/core/utils/import-sibling-suffixes.ts`, which reaches the Vite client through
 * `naming.ts` → the `core/utils` barrel → `NamingSettingsSection.tsx`; a `node:path` import
 * there breaks the client build (the `hidden-staging.ts` precedent). Only the pure suffix
 * literals are imported from the core registry, which stays the single source of truth.
 */
import { dirname, basename, join } from 'node:path';
import {
  STAGING_SUFFIX,
  BACKUP_SUFFIX,
  LEGACY_STAGING_SUFFIX,
  LEGACY_BACKUP_SUFFIX,
  MARKER_SUFFIX,
} from '../../core/utils/import-sibling-suffixes.js';

export interface ImportSiblings {
  /** Active born-hidden staging dir: `<dir>/.<base>.import-staging`. */
  stagingPath: string;
  /** Active born-hidden backup dir: `<dir>/.<base>.import-backup`. */
  backupPath: string;
  /** Legacy un-dotted staging dir (recognition-only): `<target>.import-tmp`. */
  legacyStagingPath: string;
  /** Legacy un-dotted backup dir (recognition-only): `<target>.import-bak`. */
  legacyBackupPath: string;
  /** Commit-pending marker file (un-dotted, on the visible target basename). */
  markerPath: string;
}

/**
 * Prepend exactly ONE dot to the WHOLE sibling basename, unconditionally, then append the
 * active scratch `suffix`. Injective on the target basename (`Title` → `.Title.import-staging`,
 * `.Title` → `..Title.import-staging`) and always dot-led, so ABS's dotpath rule and
 * narratorr's `isHiddenName` skip it from birth. Deliberately NOT the idempotent
 * `dotPrefixBasename` — that maps both `Title` and `.Title` to `.Title`, collapsing the two
 * distinct dot-led targets onto one scratch name. Only the basename changes; the parent dir
 * is untouched, so the finalize `rename()` into the visible target stays a same-filesystem
 * atomic move.
 */
function activeScratchPath(targetPath: string, suffix: string): string {
  const dir = dirname(targetPath);
  const name = `.${basename(targetPath)}${suffix}`;
  return dir === '.' ? name : join(dir, name);
}

/**
 * Derive all five transient sibling paths for an import target. The active scratch dirs are
 * born-hidden and injective; the legacy dirs are recognition-only (never created going
 * forward, but still recovered/cleaned when the target is next prepared); the marker stays
 * on the visible target basename so `markerPathFor`/`targetPathFromMarker` are unchanged.
 */
export function deriveImportSiblings(targetPath: string): ImportSiblings {
  return {
    stagingPath: activeScratchPath(targetPath, STAGING_SUFFIX),
    backupPath: activeScratchPath(targetPath, BACKUP_SUFFIX),
    legacyStagingPath: `${targetPath}${LEGACY_STAGING_SUFFIX}`,
    legacyBackupPath: `${targetPath}${LEGACY_BACKUP_SUFFIX}`,
    markerPath: `${targetPath}${MARKER_SUFFIX}`,
  };
}
