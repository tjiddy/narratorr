export const AUDIO_EXTENSIONS = new Set([
  '.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aac', '.wav',
]);

/** Basename-only; keep import-free for the Vite-facing barrel and aligned with Audiobookshelf's dot-path rule. */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}
