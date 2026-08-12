export const OPF_FILENAME = 'metadata.opf';

/**
 * Shared filename match; managed-file deletion additionally requires book-root location and the
 * provenance marker below.
 */
export const OPF_FILE_REGEX = /^metadata\.opf$/i;

/**
 * Filename cannot prove ownership because ABS and Calibre also use `metadata.opf`. This inert,
 * namespaced meta tag marks files Narratorr may overwrite or delete; ABS ignores unknown meta names.
 */
const NARRATORR_OPF_MARKER_NAME = 'narratorr:managed';

export const NARRATORR_OPF_MARKER = `<meta name="${NARRATORR_OPF_MARKER_NAME}" content="true"/>`;

/**
 * Checks only the namespaced name attribute so whitespace and attribute order may vary. Unmarked
 * foreign OPFs are preserved.
 */
export function hasNarratorrMarker(content: string): boolean {
  return content.includes(`name="${NARRATORR_OPF_MARKER_NAME}"`);
}
