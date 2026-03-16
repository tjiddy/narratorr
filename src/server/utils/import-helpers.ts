import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { renderTemplate, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';

import type { books, authors } from '../../db/schema.js';

/** Minimum ratio of target/source file size for copy verification to pass. */
export const COPY_VERIFICATION_THRESHOLD = 0.99;

export type BookRow = typeof books.$inferSelect;
export type AuthorRow = typeof authors.$inferSelect;

export interface ImportResult {
  downloadId: number;
  bookId: number;
  targetPath: string;
  fileCount: number;
  totalSize: number;
}

/** Extract a 4-digit year from a date string like "2010-11-02" or "2010". */
export function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

/** Build the target directory from a folder format string and book metadata. */
export function buildTargetPath(
  libraryPath: string,
  folderFormat: string,
  book: {
    title: string;
    seriesName?: string | null;
    seriesPosition?: number | null;
    narrator?: string | null;
    publishedDate?: string | null;
  },
  authorName: string | null,
): string {
  const author = authorName || 'Unknown Author';
  const tokens: Record<string, string | number | undefined> = {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: book.narrator || undefined,
    narratorLastFirst: book.narrator ? toLastFirst(book.narrator) : undefined,
    year: extractYear(book.publishedDate),
  };

  const rendered = renderTemplate(folderFormat, tokens);
  return join(libraryPath, ...rendered.split('/'));
}

/** Recursively get total size of a path (file or directory). */
export async function getPathSize(path: string): Promise<number> {
  const stats = await stat(path);
  if (stats.isFile()) return stats.size;

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isFile()) {
      const s = await stat(entryPath);
      total += s.size;
    } else if (entry.isDirectory()) {
      total += await getPathSize(entryPath);
    }
  }
  return total;
}

/** Check if a path contains audio files (recursively). */
export async function containsAudioFiles(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      return true;
    }
    if (entry.isDirectory()) {
      if (await containsAudioFiles(join(dirPath, entry.name))) return true;
    }
  }
  return false;
}

/** Recursively copy only audio files from source to target, preserving directory structure. */
export async function copyAudioFiles(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(source, entry.name);
    const destPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyAudioFiles(srcPath, destPath);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      await mkdir(target, { recursive: true });
      await cp(srcPath, destPath, { errorOnExist: false });
    }
  }
}

/** Recursively count audio files in a directory. */
export async function countAudioFiles(dirPath: string): Promise<number> {
  let count = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      count++;
    } else if (entry.isDirectory()) {
      count += await countAudioFiles(join(dirPath, entry.name));
    }
  }
  return count;
}
