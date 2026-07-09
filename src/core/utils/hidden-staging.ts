import { dirname, basename, join } from 'node:path';
import { isHiddenName } from './audio-constants.js';

/**
 * Return `path` with its final segment dot-prefixed so the entry is **born hidden**.
 *
 * `/lib/Book.merge-tmp` → `/lib/.Book.merge-tmp`; `/lib/Book/002.tmp.mp3` →
 * `/lib/Book/.002.tmp.mp3`. The parent directory is untouched — only the basename gains a
 * leading dot, so the entry lands on the SAME filesystem as its final destination and the
 * atomic finalize `rename()` over the original is preserved (never a cross-device copy).
 *
 * A basename that is already dot-led is returned unchanged (idempotent). Imports `node:path`,
 * so this module is NOT re-exported through the `core/utils` barrel (server/Node-only).
 */
export function dotPrefixBasename(path: string): string {
  const base = basename(path);
  if (isHiddenName(base)) return path; // single-home leading-dot decision (shared with every classifier)
  const dir = dirname(path);
  return dir === '.' ? `.${base}` : join(dir, `.${base}`);
}
