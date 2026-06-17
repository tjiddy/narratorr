import { readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { AUDIO_EXTENSIONS } from './audio-constants.js';

export interface CollectAudioFileOptions {
  /** Recurse into subdirectories (default: false). */
  recursive?: boolean;
  /** Extension set to filter by (default: AUDIO_EXTENSIONS). */
  extensions?: Set<string>;
  /** Skip directories starting with '.' (default: false). */
  skipHidden?: boolean;
}

/**
 * Collect audio file paths from a directory, filtered by extension.
 * Returns an **unsorted** array — callers are responsible for their own sort semantics.
 */
export async function collectAudioFilePaths(
  dir: string,
  options?: CollectAudioFileOptions,
): Promise<string[]> {
  const extensions = options?.extensions ?? AUDIO_EXTENSIONS;
  const recursive = options?.recursive ?? false;
  const skipHidden = options?.skipHidden ?? false;

  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    } else if (recursive && entry.isDirectory()) {
      if (skipHidden && entry.name.startsWith('.')) continue;
      results.push(...await collectAudioFilePaths(fullPath, options));
    }
  }

  return results;
}

/** Trailing duplicate-copy marker — space, `(`, digits, `)` at the very end of the stem. */
const DUPLICATE_MARKER = /\s\((\d+)\)$/;

/**
 * Parse an audio basename into its sort keys for the duplicate-copy convention.
 *
 * Strips the extension, then peels a trailing ` (\d+)` group off the stem. A bare
 * name (no trailing group) gets `dupIndex = 1`; `Title (N).ext` gets `dupIndex = N`.
 * This models the Windows/download duplicate naming where the un-suffixed `Title.mp3`
 * IS part 1 and each `(N)` is part N — so the bare file must sort *before* its copies.
 */
const parseAudioName = (name: string): { stem: string; dupIndex: number } => {
  const base = basename(name);
  const stemWithExt = base.slice(0, base.length - extname(base).length);
  const match = DUPLICATE_MARKER.exec(stemWithExt);
  if (match) {
    return { stem: stemWithExt.slice(0, match.index), dupIndex: Number(match[1]) };
  }
  return { stem: stemWithExt, dupIndex: 1 };
};

/**
 * Pure comparator for audio file names — locale-aware numeric ordering on basename,
 * aware of the `file (N).ext` duplicate-copy convention.
 *
 * Use to sort an in-memory `string[]` the same way `collectSortedAudioFiles`'s
 * `locale-numeric` mode sorts a directory read from disk. Numeric-aware, so
 * `Track2 < Track10`, `001 < 010 < 100`, and `(2) < (10) < (100)` — NOT the
 * lexicographic ordering of a bare `Array.sort()` (where `)` 0x29 < `0` 0x30).
 *
 * Compares by an ordered key tuple so the bare `Title.mp3` (part 1) sorts before
 * `Title (2).mp3` … `Title (N).mp3` instead of last:
 *  1. stem (extension + trailing ` (N)` stripped) — locale-numeric, base-sensitive
 *  2. duplicate index — numeric (bare → 1, then `(2) < (10) < (32)`)
 *  3. original full basename — locale-numeric, base-sensitive (breaks ext-only ties)
 *  4. original full basename — raw code-unit compare (guarantees a strict total order
 *     so case/accent-only distinct names never collapse to 0)
 *
 * Shared by `collectSortedAudioFiles` (directory sort) and `planFileRenames`
 * (in-memory array sort) so import-time and rename-time ordering never drift.
 */
export const compareAudioNames = (a: string, b: string): number => {
  const ka = parseAudioName(a);
  const kb = parseAudioName(b);

  const stemCmp = ka.stem.localeCompare(kb.stem, undefined, { numeric: true, sensitivity: 'base' });
  if (stemCmp !== 0) return stemCmp;

  if (ka.dupIndex !== kb.dupIndex) return ka.dupIndex - kb.dupIndex;

  const baseA = basename(a);
  const baseB = basename(b);
  const baseCmp = baseA.localeCompare(baseB, undefined, { numeric: true, sensitivity: 'base' });
  if (baseCmp !== 0) return baseCmp;

  return baseA < baseB ? -1 : baseA > baseB ? 1 : 0;
};

/** Sort mode for collectSortedAudioFiles. */
export type AudioFileSortMode = 'lexicographic' | 'locale' | 'locale-numeric';

export interface CollectSortedOptions extends CollectAudioFileOptions {
  /** Sort mode (default: 'locale-numeric'). */
  sort?: AudioFileSortMode;
}

/**
 * Collect audio files and return them sorted.
 *
 * Sort modes:
 * - `'lexicographic'` — plain `Array.sort()` on full path (default JS string comparison)
 * - `'locale'` — `localeCompare` on basename (alphabetic, no numeric awareness)
 * - `'locale-numeric'` — `localeCompare` on basename with `{ numeric: true }` (default)
 */
export async function collectSortedAudioFiles(
  dir: string,
  options?: CollectSortedOptions,
): Promise<string[]> {
  const files = await collectAudioFilePaths(dir, options);
  const mode = options?.sort ?? 'locale-numeric';

  switch (mode) {
    case 'lexicographic':
      return files.sort();
    case 'locale':
      return files.sort((a, b) => basename(a).localeCompare(basename(b)));
    case 'locale-numeric':
      return files.sort(compareAudioNames);
  }
}
