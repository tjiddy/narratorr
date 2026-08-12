export const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const SUPPORTED_COVER_MIMES = new Set(Object.keys(MIME_TO_EXT));

export const SUPPORTED_COVER_ACCEPT = Object.keys(MIME_TO_EXT).join(',');

export function mimeToExt(mime: string | undefined): string | null {
  if (!mime) return null;
  return MIME_TO_EXT[mime] ?? null;
}
