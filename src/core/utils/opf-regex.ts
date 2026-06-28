/** Filename of the narratorr-generated OPF metadata sidecar, written at the book-folder root. */
export const OPF_FILENAME = 'metadata.opf';

/**
 * Shared regex matching the narratorr-generated OPF sidecar (metadata.opf), case-insensitive.
 * Mirrors {@link COVER_FILE_REGEX}: used by the writer (`opf-writer.ts`) and the managed-file
 * classifier (`delete-managed-files.ts`), which treats it as managed ONLY at the book-folder root
 * AND only when the file carries the provenance marker below.
 */
export const OPF_FILE_REGEX = /^metadata\.opf$/i;

/**
 * Stable provenance attribute embedded in every narratorr-generated OPF. Unlike `cover.*` (which
 * narratorr writes on every import, so it genuinely owns every match), `metadata.opf` is the
 * standard Audiobookshelf/Calibre sidecar filename — a file narratorr's target users already keep.
 * Ownership therefore can't be proven by filename; it must be proven by CONTENT. The marker is an
 * inert `<meta name=…>` element (ABS's `parseOpfMetadata.js` ignores unknown `<meta name=…>`
 * elements), so it does not perturb any field a reader extracts and the OPF stays well-formed.
 */
const NARRATORR_OPF_MARKER_NAME = 'narratorr:managed';

/** The exact marker element emitted into generated OPFs (single source of truth for the writer). */
export const NARRATORR_OPF_MARKER = `<meta name="${NARRATORR_OPF_MARKER_NAME}" content="true"/>`;

/**
 * True when OPF content carries the narratorr provenance marker — i.e. narratorr wrote it and may
 * delete/overwrite it. Matches the stable `name="…"` attribute rather than the whole element so it
 * tolerates incidental whitespace/attribute-order changes. A foreign ABS/Calibre OPF never carries
 * this narratorr-namespaced attribute, so it is preserved.
 */
export function hasNarratorrMarker(content: string): boolean {
  return content.includes(`name="${NARRATORR_OPF_MARKER_NAME}"`);
}
