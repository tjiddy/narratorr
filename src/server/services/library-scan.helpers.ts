import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';
import { serializeError } from '../utils/serialize-error.js';


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
