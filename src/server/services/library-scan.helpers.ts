import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';
import { serializeError } from '../utils/serialize-error.js';


export async function getAudioStats(path: string, log: FastifyBaseLogger): Promise<{ fileCount: number; totalSize: number }> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), path }, 'Error getting audio stats');
    return { fileCount: 0, totalSize: 0 };
  }

  // Single-file path: count it as one audio file (or zero for non-audio).
  if (stats.isFile()) {
    if (AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) {
      return { fileCount: 1, totalSize: stats.size };
    }
    return { fileCount: 0, totalSize: 0 };
  }

  let fileCount = 0;
  let totalSize = 0;

  try {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
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
    log.warn({ error: serializeError(error), path }, 'Error getting audio stats');
  }

  return { fileCount, totalSize };
}

export interface BuildDiscoveredBookOptions {
  isDuplicate?: boolean | undefined;
  existingBookId?: number | undefined;
  duplicateReason?: 'path' | 'slug' | 'within-scan' | undefined;
  duplicateFirstPath?: string | undefined;
  reviewReason?: string | undefined;
}

/** Build a DiscoveredBook from parsed folder data and optional duplicate / review info. */
export function buildDiscoveredBook(
  path: string,
  parsed: { title: string; author: string | null; series: string | null; seriesPosition?: number },
  fileCount: number,
  totalSize: number,
  options: BuildDiscoveredBookOptions = {},
): DiscoveredBook {
  const { isDuplicate = false, existingBookId, duplicateReason, duplicateFirstPath, reviewReason } = options;
  return {
    path,
    parsedTitle: parsed.title,
    parsedAuthor: parsed.author,
    parsedSeries: parsed.series,
    ...(parsed.seriesPosition !== undefined && { parsedSeriesPosition: parsed.seriesPosition }),
    fileCount,
    totalSize,
    isDuplicate,
    ...(existingBookId !== undefined && { existingBookId }),
    ...(duplicateReason !== undefined && { duplicateReason }),
    ...(duplicateFirstPath !== undefined && { duplicateFirstPath }),
    ...(reviewReason !== undefined && { reviewReason }),
  };
}
