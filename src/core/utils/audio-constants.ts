/** Audio file extensions recognized throughout the application. */
export const AUDIO_EXTENSIONS = new Set([
  '.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aac', '.wav',
]);

/**
 * The single visibility primitive: is this entry *name* born hidden (leading dot)?
 *
 * Takes a **basename**, not a path — callers apply it to `entry.name` from a directory
 * read, or `basename(path)` for a direct-file branch. Every "does this file/dir count as
 * visible book audio?" classifier composes it with its own extension policy as
 * `!isHiddenName(name) && <extensions>.has(ext)`; recursive helpers additionally use it to
 * skip a leading-dot directory *subtree* entirely (never descend).
 *
 * Mirrors Audiobookshelf's `shouldIgnoreFile` dotfile/dotpath rule so a born-hidden
 * transient (`.merge-tmp/`, `.<stem>.tmp<ext>`) is inert to BOTH narratorr and ABS for its
 * whole on-disk life. MUST stay import-free (no `node:path`/`node:fs`) so it can flow
 * through the `core/utils` barrel into the Vite client build.
 */
export function isHiddenName(name: string): boolean {
  return name.startsWith('.');
}
