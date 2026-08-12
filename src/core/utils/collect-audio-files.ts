import { readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { AUDIO_EXTENSIONS, isHiddenName } from './audio-constants.js';

export interface CollectAudioFileOptions {
  /** Recurse into subdirectories (default: false). */
  recursive?: boolean;
  /** Extension set to filter by (default: AUDIO_EXTENSIONS). Read-only: only `.has` is called. */
  extensions?: ReadonlySet<string>;
  /** Skip directories starting with '.' (default: false). */
  skipHidden?: boolean;
}

/** Returns matching audio paths unsorted; callers own ordering. */
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
    // skipHidden gates directory recursion only; dotfile transients such as `.002.tmp.mp3` are never audio.
    if (entry.isFile() && !isHiddenName(entry.name) && extensions.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    } else if (recursive && entry.isDirectory()) {
      if (skipHidden && isHiddenName(entry.name)) continue;
      results.push(...await collectAudioFilePaths(fullPath, options));
    }
  }

  return results;
}

const DUPLICATE_MARKER = /\s\((\d+)\)$/;

/**
 * Parses the Windows duplicate-copy convention: bare `Title.ext` is part 1 and
 * `Title (N).ext` is part N, so the bare file sorts before its copies.
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
 * Numeric basename ordering with Windows duplicate-copy semantics. Full-basename and raw
 * code-unit tie-breakers keep case/accent-only names from comparing equal. Collection and
 * rename planning share this comparator so their play order cannot drift.
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

/**
 * If any rendered stems collide case-insensitively, suffix every stem with a zero-padded,
 * 1-based ordinal. Single and already-unique sets pass through. Input must already be in
 * `compareAudioNames` order so rename ordinals preserve play order.
 */
export function disambiguateStems(stems: string[]): string[] {
  if (stems.length <= 1) return [...stems];
  const uniqueCount = new Set(stems.map((s) => s.toLowerCase())).size;
  if (uniqueCount === stems.length) return [...stems];
  const width = String(stems.length).length;
  return stems.map((stem, i) => `${stem} (${String(i + 1).padStart(width, '0')})`);
}

export type AudioFileSortMode = 'lexicographic' | 'locale' | 'locale-numeric';

export interface CollectSortedOptions extends CollectAudioFileOptions {
  /** Sort mode (default: 'locale-numeric'). */
  sort?: AudioFileSortMode;
}

/** Sorts by full-path code units, locale basename, or default numeric locale basename. */
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
