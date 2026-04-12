/** MIME types supported for cover images, mapped to file extensions. */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Set of supported cover image MIME types. */
export const SUPPORTED_COVER_MIMES = new Set(Object.keys(MIME_TO_EXT));

/** Map a MIME type to its file extension. Returns null for unsupported types. */
export function mimeToExt(mime: string | undefined): string | null {
  if (!mime) return null;
  return MIME_TO_EXT[mime] ?? null;
}
