import { stat, readdir, mkdir, cp } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { renderTemplate, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { DISC_FOLDER_PATTERN } from '../../core/utils/book-discovery.js';
import type { NamingOptions } from '../../core/utils/naming.js';

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
    narrators?: Array<{ name: string }> | null;
    publishedDate?: string | null;
  },
  authorName: string | null,
  options?: NamingOptions,
): string {
  const author = authorName || 'Unknown Author';
  const narratorNames = book.narrators?.map(n => n.name) ?? [];
  const primaryNarrator = narratorNames[0];
  const tokens: Record<string, string | number | undefined> = {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: primaryNarrator || undefined,
    narratorLastFirst: primaryNarrator ? toLastFirst(primaryNarrator) : undefined,
    year: extractYear(book.publishedDate),
  };

  const rendered = renderTemplate(folderFormat, tokens, options);
  // Always use POSIX separators — paths are stored in DB and consumed inside Docker (Linux)
  return join(libraryPath, ...rendered.split('/')).split('\\').join('/');
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

/** Recursively collect all audio file paths from a source directory. */
async function collectAudioFiles(
  dir: string,
): Promise<Array<{ srcPath: string; name: string }>> {
  const results: Array<{ srcPath: string; name: string }> = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectAudioFiles(fullPath));
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push({ srcPath: fullPath, name: entry.name });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

type AudioFile = { srcPath: string; name: string };

/** Collect audio from disc subfolders with sequential renaming, plus non-disc entries. */
async function collectMultiDiscFiles(
  source: string,
  discFolders: Array<{ name: string; path: string }>,
  otherEntries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>,
): Promise<AudioFile[]> {
  // Sort discs naturally (Disc 2 before Disc 10)
  discFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // Collect audio files from each disc in order
  const discFiles: AudioFile[] = [];
  for (const disc of discFolders) {
    discFiles.push(...await collectAudioFiles(disc.path));
  }

  // Assign sequential filenames to disc files
  const padWidth = String(discFiles.length).length;
  const sequentialFiles = discFiles.map((file, i) => ({
    srcPath: file.srcPath,
    name: `${String(i + 1).padStart(padWidth, '0')}${extname(file.name)}`,
  }));

  // Collect non-disc entries (loose files + non-disc subfolders)
  const nonDiscFiles: AudioFile[] = [];
  for (const entry of otherEntries) {
    const fullPath = join(source, entry.name);
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      nonDiscFiles.push({ srcPath: fullPath, name: entry.name });
    } else if (entry.isDirectory()) {
      nonDiscFiles.push(...await collectAudioFiles(fullPath));
    }
  }
  nonDiscFiles.sort((a, b) => a.name.localeCompare(b.name));

  // Check for collisions between non-disc files and sequential disc files
  const sequentialNames = new Set(sequentialFiles.map(f => f.name));
  for (const file of nonDiscFiles) {
    if (sequentialNames.has(file.name)) {
      throw new Error(
        `Duplicate filename "${file.name}" found during import flattening: non-disc file "${file.srcPath}" collides with sequential disc numbering`,
      );
    }
  }

  return [...nonDiscFiles, ...sequentialFiles];
}

/** Collect audio from entries with collision check (standard non-disc path). */
async function collectFlatFiles(
  source: string,
  entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>,
): Promise<AudioFile[]> {
  const results: AudioFile[] = [];
  for (const entry of entries) {
    const fullPath = join(source, entry.name);
    if (entry.isDirectory()) {
      results.push(...await collectAudioFiles(fullPath));
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push({ srcPath: fullPath, name: entry.name });
    }
  }
  const files = results.sort((a, b) => a.name.localeCompare(b.name));

  // Check for basename collisions before returning
  const seen = new Map<string, string>();
  for (const file of files) {
    const existing = seen.get(file.name);
    if (existing) {
      throw new Error(
        `Duplicate filename "${file.name}" found during import flattening: "${existing}" and "${file.srcPath}"`,
      );
    }
    seen.set(file.name, file.srcPath);
  }
  return files;
}

/** Copy audio files from source to target, flattening all subdirectories. */
export async function copyAudioFiles(source: string, target: string): Promise<void> {
  const rootEntries = await readdir(source, { withFileTypes: true });

  const discFolders: Array<{ name: string; path: string }> = [];
  const otherEntries: typeof rootEntries = [];

  for (const entry of rootEntries) {
    if (entry.isDirectory() && DISC_FOLDER_PATTERN.test(entry.name)) {
      discFolders.push({ name: entry.name, path: join(source, entry.name) });
    } else {
      otherEntries.push(entry);
    }
  }

  const files = discFolders.length >= 2
    ? await collectMultiDiscFiles(source, discFolders, otherEntries)
    : await collectFlatFiles(source, rootEntries);

  await mkdir(target, { recursive: true });
  for (const file of files) {
    await cp(file.srcPath, join(target, file.name), { errorOnExist: false });
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
