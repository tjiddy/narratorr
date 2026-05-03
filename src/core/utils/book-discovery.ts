import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative, basename } from 'node:path';
import { AUDIO_EXTENSIONS } from './audio-constants.js';

/** Minimal logger interface — matches Pino/Fastify logger shape */
export interface DiscoveryLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Disc folder naming pattern — matches Audiobookshelf's convention.
 * Matches: CD1, CD 1, Disc 1, Disc1, Disk 03, DISC 004, etc.
 * Does NOT match: "01 - Harry Potter", "Part 1", book titles, etc.
 */
export const DISC_FOLDER_PATTERN = /^(cd|dis[ck])\s*\d{1,3}$/i;

/**
 * Titled-disc pattern — matches torrent naming conventions where the book title
 * precedes a parenthetical disc indicator:
 *   "BookTitle (Disc 01)", "BookTitle (Disk 3)", "BookTitle (1 of 5)"
 *
 * Returns the extracted title and disc number, or null if no match.
 * Bare disc folders ("Disc 01", "CD1") return null — use DISC_FOLDER_PATTERN for those.
 */
export function parseTitledDiscFolder(name: string): { title: string; discNumber: number } | null {
  if (!name) return null;

  // Pattern 1: "Title (Disc NN)" or "Title (Disk NN)"
  const discMatch = name.match(/^(.+?)\s*\((dis[ck])\s*(\d{1,3})\)$/i);
  if (discMatch) {
    const title = discMatch[1]!.trim();
    // Bare disc folders like "Disc 01" would have empty title — reject
    if (!title) return null;
    return { title, discNumber: parseInt(discMatch[3]!, 10) };
  }

  // Pattern 2: "Title (N of M)"
  const nOfMMatch = name.match(/^(.+?)\s*\((\d{1,3})\s+of\s+\d{1,3}\)$/i);
  if (nOfMMatch) {
    const title = nOfMMatch[1]!.trim();
    if (!title) return null;
    return { title, discNumber: parseInt(nOfMMatch[2]!, 10) };
  }

  return null;
}

export interface DiscoverBooksOptions {
  log?: DiscoveryLogger;
}

export interface DiscoveredFolder {
  /** Absolute path to the book folder */
  path: string;
  /** Path segments from root (e.g. ['Author', 'Series', 'Book']) */
  folderParts: string[];
  /** Number of audio files found */
  audioFileCount: number;
  /** Total size of audio files in bytes */
  totalSize: number;
}

/**
 * Walk a root directory and discover audiobook folders.
 *
 * Disc folder merging: if a parent directory has 2+ immediate children
 * that each contain audio files (and no audio of its own), those children
 * are merged into a single book entry using the parent path.
 */
export async function discoverBooks(rootPath: string, options?: DiscoverBooksOptions): Promise<DiscoveredFolder[]> {
  const results: DiscoveredFolder[] = [];
  const log = options?.log;
  log?.debug({ rootPath }, 'Starting book discovery');
  await walkDirectory(rootPath, rootPath, results, log);
  log?.debug({ rootPath, discovered: results.length }, 'Book discovery complete');
  return results;
}

interface DirInfo {
  path: string;
  audioFiles: { path: string; size: number }[];
  children: DirInfo[];
}

async function scanDir(dirPath: string): Promise<DirInfo> {
  const info: DirInfo = { path: dirPath, audioFiles: [], children: [] };

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return info;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = join(dirPath, entry.name);

    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(fullPath);
        info.audioFiles.push({ path: fullPath, size: s.size });
      } catch {
        // skip unreadable files
      }
    } else if (entry.isDirectory()) {
      const child = await scanDir(fullPath);
      info.children.push(child);
    }
  }

  return info;
}

async function walkDirectory(
  currentPath: string,
  rootPath: string,
  results: DiscoveredFolder[],
  log?: DiscoveryLogger,
): Promise<void> {
  const info = await scanDir(currentPath);
  collectBooks(info, rootPath, results, log);
}

/** Identify disc-pattern children and verify titled-disc folders share the same title. */
function findMergeableDiscChildren(audioChildren: DirInfo[]): { discChildren: DirInfo[]; allSameTitle: boolean } {
  const discChildren = audioChildren.filter(c => {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    return DISC_FOLDER_PATTERN.test(folderName) || parseTitledDiscFolder(folderName) !== null;
  });

  if (discChildren.length < 2) {
    return { discChildren, allSameTitle: true };
  }

  // For titled-disc folders, verify all share the same title prefix before merging
  const titles = new Set<string>();
  for (const c of discChildren) {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    const parsed = parseTitledDiscFolder(folderName);
    if (parsed) {
      titles.add(parsed.title.toLowerCase());
    }
    // Bare disc folders (no title) are compatible with any single title group
  }
  return { discChildren, allSameTitle: titles.size <= 1 };
}

function collectBooks(info: DirInfo, rootPath: string, results: DiscoveredFolder[], log?: DiscoveryLogger): void {
  const hasOwnAudio = info.audioFiles.length > 0;
  const audioChildren = info.children.filter(c => countAudioFilesDeep(c) > 0);

  if (hasOwnAudio && audioChildren.length > 0) {
    // Mixed-content folder: has loose audio files AND subfolders with audio.
    // Skip the loose files and fall through to disc-merge / recursion below.
    log?.debug(
      {
        path: info.path,
        skippedFiles: info.audioFiles.map(f => f.path),
      },
      'Skipping loose audio files in mixed-content folder',
    );
  } else if (hasOwnAudio) {
    // Pure leaf book folder — no audio-containing children
    log?.debug({ path: info.path, audioFiles: info.audioFiles.length }, 'Leaf book folder');
    results.push(makeFolderEntry(info, rootPath, info.audioFiles));
    return;
  }

  // Check for disc folder pattern: 2+ immediate children with audio whose names
  // match disc/CD naming conventions (bare: "CD1", "Disc 2"; titled: "BookTitle (Disc 01)")
  const immediateAudioChildren = info.children.filter(c => c.audioFiles.length > 0);
  const { discChildren, allSameTitle } = findMergeableDiscChildren(immediateAudioChildren);

  if (discChildren.length >= 2 && discChildren.length === immediateAudioChildren.length && allSameTitle) {
    // All audio children are disc folders with compatible titles — merge into parent
    const allAudioFiles = discChildren.flatMap(c => collectAllAudioFiles(c));
    log?.debug(
      {
        path: info.path,
        discFolders: discChildren.map(c => c.path),
        mergedAudioFiles: allAudioFiles.length,
      },
      'Disc folder merge',
    );
    results.push(makeFolderEntry(info, rootPath, allAudioFiles));

    // Still recurse into children that aren't disc folders (could have deeper books)
    for (const child of info.children) {
      if (!discChildren.includes(child)) {
        collectBooks(child, rootPath, results, log);
      }
    }
    return;
  }

  // No audio here, not a disc pattern — recurse into children
  for (const child of audioChildren) {
    collectBooks(child, rootPath, results, log);
  }

  // Also recurse into non-audio children (may have deeper books)
  for (const child of info.children) {
    if (!audioChildren.includes(child)) {
      collectBooks(child, rootPath, results, log);
    }
  }
}

function countAudioFilesDeep(info: DirInfo): number {
  let count = info.audioFiles.length;
  for (const child of info.children) {
    count += countAudioFilesDeep(child);
  }
  return count;
}

function collectAllAudioFiles(info: DirInfo): { path: string; size: number }[] {
  const files = [...info.audioFiles];
  for (const child of info.children) {
    files.push(...collectAllAudioFiles(child));
  }
  return files;
}

function makeFolderEntry(
  info: DirInfo,
  rootPath: string,
  audioFiles: { path: string; size: number }[],
): DiscoveredFolder {
  const relativePath = relative(rootPath, info.path);
  const folderParts = relativePath ? relativePath.split(/[\\/]/) : [basename(rootPath)];

  return {
    path: info.path,
    folderParts,
    audioFileCount: audioFiles.length,
    totalSize: audioFiles.reduce((sum, f) => sum + f.size, 0),
  };
}
