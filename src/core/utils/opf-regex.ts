/** Filename of the narratorr-generated OPF metadata sidecar, written at the book-folder root. */
export const OPF_FILENAME = 'metadata.opf';

/**
 * Shared regex matching the narratorr-generated OPF sidecar (metadata.opf), case-insensitive.
 * Mirrors {@link COVER_FILE_REGEX}: used by the writer (`opf-writer.ts`) and the managed-file
 * classifier (`delete-managed-files.ts`), which treats it as managed ONLY at the book-folder root.
 */
export const OPF_FILE_REGEX = /^metadata\.opf$/i;
