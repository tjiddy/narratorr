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
      return files.sort((a, b) =>
        basename(a).localeCompare(basename(b), undefined, { numeric: true, sensitivity: 'base' }),
      );
  }
}
