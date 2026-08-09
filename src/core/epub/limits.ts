/** Centralized limits for the companion-EPUB read path. */

/** On-disk cap checked before unzipper materializes the central directory. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

/**
 * Declared EOCD/ZIP64 record-count cap checked before unzipper allocates its files array.
 * Post-open files.length is only an equality check because unzipper constructs that array
 * from the declared count. This separately blocks tiny ZIP64 archives with enormous counts.
 */
export const MAX_ARCHIVE_ENTRIES = 10000;

/**
 * Pre-open central-directory span cap for legacy and ZIP64 archives. This bounds
 * retained names/comments before inflated-member accounting can run. Its value only
 * coincidentally matches MAX_EPUB_COVER_BYTES; keep the independent limits separate.
 */
export const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;

/**
 * Total inflated bytes an inspection may read across all its member reads,
 * enforced by the counting transform on the actual inflated stream. Declared
 * central-directory sizes are attacker-authored and advisory only.
 */
export const MAX_INSPECTION_BYTES = 16 * 1024 * 1024;

/** Maximum inflated bytes of a single XML document (container, package, nav, NCX) before parsing. */
export const MAX_XML_BYTES = 4 * 1024 * 1024;

/** Inflated EPUB cover cap; independent from the audiobook HTTP-download cap. */
export const MAX_EPUB_COVER_BYTES = 8 * 1024 * 1024;

/** Maximum TOC entries retained from a nav document or NCX. */
export const MAX_TOC_ENTRIES = 2000;
