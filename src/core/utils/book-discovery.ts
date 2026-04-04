import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
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
const DISC_FOLDER_PATTERN = /^(cd|dis[ck])\s*\d{1,3}$/i;

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
  // match disc/CD naming conventions (e.g. "CD1", "Disc 2", "Disk 03")
  const immediateAudioChildren = info.children.filter(c => c.audioFiles.length > 0);
  const discChildren = immediateAudioChildren.filter(c => {
    const folderName = c.path.split(/[\\/]/).pop() ?? '';
    return DISC_FOLDER_PATTERN.test(folderName);
  });
  if (discChildren.length >= 2 && discChildren.length === immediateAudioChildren.length) {
    // All audio children are disc folders — merge into parent
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
  const folderParts = relativePath ? relativePath.split(/[\\/]/) : [];

  return {
    path: info.path,
    folderParts,
    audioFileCount: audioFiles.length,
    totalSize: audioFiles.reduce((sum, f) => sum + f.size, 0),
  };
}
