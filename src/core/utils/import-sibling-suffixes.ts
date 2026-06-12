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

/** Directory-name suffixes of the transient `.import-tmp` / `.import-bak` scratch siblings. */
export const SCRATCH_SUFFIXES = ['.import-tmp', '.import-bak'] as const;

/**
 * All three reserved import-sibling suffixes (the two scratch siblings plus the
 * commit-pending marker). Consumed by the discovery walker to EXCLUDE stranded siblings
 * from scans and by the folder-name sanitizer to RESERVE the suffixes from
 * metadata-derived folder names.
 */
export const IMPORT_SIBLING_SUFFIXES = [...SCRATCH_SUFFIXES, MARKER_SUFFIX] as const;
