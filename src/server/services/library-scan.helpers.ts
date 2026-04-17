import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';
import { serializeError } from '../utils/serialize-error.js';


/**
 * Walk directory tree and find leaf folders containing audio files.
 * A "leaf folder" is a folder containing audio files (it may have subfolders too,
 * but if it directly contains audio files, it's treated as a book folder).
 */
export async function findAudioLeafFolders(dirPath: string, log: FastifyBaseLogger): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const hasAudioFiles = entries.some(
      (e) => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()),
    );

    if (hasAudioFiles) {
      results.push(dirPath);
    } else {
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const subResults = await findAudioLeafFolders(join(dirPath, entry.name), log);
          results.push(...subResults);
        }
      }
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), path: dirPath }, 'Error scanning directory');
  }

  return results;
}

export async function getAudioStats(dirPath: string, log: FastifyBaseLogger): Promise<{ fileCount: number; totalSize: number }> {
  let fileCount = 0;
  let totalSize = 0;

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      if (entry.isFile()) {
        if (AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          fileCount++;
        }
        const s = await stat(entryPath);
        totalSize += s.size;
      } else if (entry.isDirectory()) {
        const sub = await getAudioStats(entryPath, log);
        fileCount += sub.fileCount;
        totalSize += sub.totalSize;
      }
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), path: dirPath }, 'Error getting audio stats');
  }

  return { fileCount, totalSize };
}

/** Build a DiscoveredBook from parsed folder data and optional duplicate info. */
export function buildDiscoveredBook(
  path: string,
  parsed: { title: string; author: string | null; series: string | null },
  fileCount: number,
  totalSize: number,
  isDuplicate: boolean,
  existingBookId?: number,
  duplicateReason?: 'path' | 'slug' | 'within-scan',
  duplicateFirstPath?: string,
): DiscoveredBook {
  return {
    path,
    parsedTitle: parsed.title,
    parsedAuthor: parsed.author,
    parsedSeries: parsed.series,
    fileCount,
    totalSize,
    isDuplicate,
    ...(existingBookId !== undefined && { existingBookId }),
    ...(duplicateReason !== undefined && { duplicateReason }),
    ...(duplicateFirstPath !== undefined && { duplicateFirstPath }),
  };
}
