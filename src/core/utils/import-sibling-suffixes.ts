/**
 * Reserved suffixes for the transient import siblings — the staged-swap scratch dirs
 * (`.import-tmp` / `.import-bak`) and the commit-pending marker (`.import-commit-pending`,
 * #1290). Defined in exactly ONE place (#1341) so the scan walker (`book-discovery.ts`),
 * the folder-name sanitizer (`naming.ts`), and the staging machinery (`import-staging.ts`)
 * all agree — a future fourth suffix is reserved here and nowhere else.
 *
 * Lives in `src/core/utils/` (not server-side `import-staging.ts`) so the two `src/core/`
 * consumers don't reach across the `core → server` layer boundary; `import-staging.ts`
 * (server) imports DOWN into core, which is allowed.
 *
 * Matching is case-sensitive against these lowercase literals, consistent with the
 * existing `endsWith` checks throughout `import-staging.ts` (no normalization, #1341).
 */

/** Suffix of the sibling commit-pending marker FILE (see `import-staging.ts` `markerPathFor`). */
export const MARKER_SUFFIX = '.import-commit-pending';

/**
 * ACTIVE born-hidden scratch suffixes (#1911). The active staging/backup dirs use these
 * suffixes AND additionally dot-prefix the whole basename (`.<name>.import-staging`), so
 * both ABS's dotpath rule and narratorr's `isHiddenName` skip them from birth. Suffix-
 * disjoint from the legacy pair below so no dotted active name for a visible target can
 * ever equal an un-dotted legacy name for a dot-led target (the cross-target collision).
 */
export const STAGING_SUFFIX = '.import-staging';
export const BACKUP_SUFFIX = '.import-backup';
export const ACTIVE_SCRATCH_SUFFIXES = [STAGING_SUFFIX, BACKUP_SUFFIX] as const;

/**
 * LEGACY un-dotted scratch suffixes (pre-#1911). Recognition-only: produced solely by
 * pre-upgrade code and cleaned/recovered when their target is next prepared; never created
 * going forward. Kept reserved so a markerless legacy leftover is still excluded from scans
 * and stripped from metadata-derived names.
 */
export const LEGACY_STAGING_SUFFIX = '.import-tmp';
export const LEGACY_BACKUP_SUFFIX = '.import-bak';
export const LEGACY_SCRATCH_SUFFIXES = [LEGACY_STAGING_SUFFIX, LEGACY_BACKUP_SUFFIX] as const;

/** Directory-name suffixes of every transient scratch sibling, active + legacy (#1341/#1911). */
export const SCRATCH_SUFFIXES = [...LEGACY_SCRATCH_SUFFIXES, ...ACTIVE_SCRATCH_SUFFIXES] as const;

/**
 * All reserved import-sibling suffixes (the four scratch siblings plus the commit-pending
 * marker). Consumed by the discovery walker to EXCLUDE stranded siblings from scans and by
 * the folder-name sanitizer to RESERVE the suffixes from metadata-derived folder names.
 */
export const IMPORT_SIBLING_SUFFIXES = [...SCRATCH_SUFFIXES, MARKER_SUFFIX] as const;
