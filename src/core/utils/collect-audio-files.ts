import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
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
