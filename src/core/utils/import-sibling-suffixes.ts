/**
 * Single source of truth for import scratch and marker suffixes shared by discovery,
 * sanitization, and staging. It lives in core so server imports down the layer boundary.
 * Matching is deliberately case-sensitive to mirror staging's lowercase `endsWith` checks.
 */

export const MARKER_SUFFIX = '.import-commit-pending';

/**
 * Active staging names also dot-prefix the basename, making them hidden from birth. Their
 * suffixes stay disjoint from the legacy pair to prevent cross-target name collisions.
 */
export const STAGING_SUFFIX = '.import-staging';
export const BACKUP_SUFFIX = '.import-backup';
export const ACTIVE_SCRATCH_SUFFIXES = [STAGING_SUFFIX, BACKUP_SUFFIX] as const;

/**
 * Legacy undotted suffixes are recognition-only and never newly created. They remain reserved
 * so markerless leftovers stay excluded from scans and metadata-derived names.
 */
export const LEGACY_STAGING_SUFFIX = '.import-tmp';
export const LEGACY_BACKUP_SUFFIX = '.import-bak';
export const LEGACY_SCRATCH_SUFFIXES = [LEGACY_STAGING_SUFFIX, LEGACY_BACKUP_SUFFIX] as const;

export const SCRATCH_SUFFIXES = [...LEGACY_SCRATCH_SUFFIXES, ...ACTIVE_SCRATCH_SUFFIXES] as const;

export const IMPORT_SIBLING_SUFFIXES = [...SCRATCH_SUFFIXES, MARKER_SUFFIX] as const;
