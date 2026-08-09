import { dirname, basename, join } from 'node:path';
import { isHiddenName } from './audio-constants.js';

/** Dot-prefixes only the basename, preserving same-filesystem renames; keep out of the Vite barrel (`node:path`). */
export function dotPrefixBasename(path: string): string {
  const base = basename(path);
  if (isHiddenName(base)) return path;
  const dir = dirname(path);
  return dir === '.' ? `.${base}` : join(dir, `.${base}`);
}
