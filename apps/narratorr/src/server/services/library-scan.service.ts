import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@narratorr/db/schema';
import { eq } from 'drizzle-orm';
import type { BookService } from './book.service.js';

const AUDIO_EXTENSIONS = new Set(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.wma', '.aac']);

export interface DiscoveredBook {
  path: string;
  parsedTitle: string;
  parsedAuthor: string | null;
  parsedSeries: string | null;
  fileCount: number;
  totalSize: number;
}

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
  coverUrl?: string;
  asin?: string;
}

export interface ScanResult {
  discoveries: DiscoveredBook[];
  totalFolders: number;
  skippedDuplicates: number;
}

export class LibraryScanService {
  constructor(
    private db: Db,
    private bookService: BookService,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Scan a directory tree for audiobook folders.
   * Returns discovered books with parsed metadata from folder names.
   */
  async scanDirectory(rootPath: string): Promise<ScanResult> {
    this.log.info({ rootPath }, 'Starting directory scan');

    const leafFolders = await this.findAudioLeafFolders(rootPath);
    this.log.info({ count: leafFolders.length }, 'Found audio folders');

    const discoveries: DiscoveredBook[] = [];
    let skippedDuplicates = 0;

    for (const folderPath of leafFolders) {
      const relativePath = relative(rootPath, folderPath);
      const parts = relativePath.split(/[/\\]/).filter(Boolean);
      const parsed = parseFolderStructure(parts);

      // Check for duplicates by path
      const existingByPath = await this.db
        .select()
        .from(books)
        .where(eq(books.path, folderPath))
        .limit(1);

      if (existingByPath.length > 0) {
        skippedDuplicates++;
        continue;
      }

      // Check for duplicates by title + author
      if (parsed.title) {
        const existing = await this.bookService.findDuplicate(parsed.title, parsed.author || undefined);
        if (existing) {
          skippedDuplicates++;
          continue;
        }
      }

      const { fileCount, totalSize } = await this.getAudioStats(folderPath);

      discoveries.push({
        path: folderPath,
        parsedTitle: parsed.title,
        parsedAuthor: parsed.author,
        parsedSeries: parsed.series,
        fileCount,
        totalSize,
      });
    }

    this.log.info(
      { discoveries: discoveries.length, skippedDuplicates, totalFolders: leafFolders.length },
      'Directory scan complete',
    );

    return {
      discoveries,
      totalFolders: leafFolders.length,
      skippedDuplicates,
    };
  }

  /**
   * Confirm import — create book records for selected discoveries.
   */
  async confirmImport(items: ImportConfirmItem[]): Promise<{ imported: number; failed: number }> {
    this.log.info({ count: items.length }, 'Starting library import');

    let imported = 0;
    let failed = 0;

    for (const item of items) {
      try {
        // Final duplicate check
        const existing = await this.bookService.findDuplicate(item.title, item.authorName);
        if (existing) {
          this.log.debug({ title: item.title }, 'Skipping duplicate during import');
          continue;
        }

        const book = await this.bookService.create({
          title: item.title,
          authorName: item.authorName,
          seriesName: item.seriesName,
          coverUrl: item.coverUrl,
          asin: item.asin,
          status: 'imported',
        });

        // Set the path and size
        const stats = await this.getAudioStats(item.path);
        await this.db.update(books).set({
          path: item.path,
          size: stats.totalSize,
          updatedAt: new Date(),
        }).where(eq(books.id, book.id));

        imported++;
      } catch (error) {
        this.log.error({ error, title: item.title, path: item.path }, 'Failed to import book');
        failed++;
      }
    }

    this.log.info({ imported, failed }, 'Library import complete');
    return { imported, failed };
  }

  /**
   * Walk directory tree and find leaf folders containing audio files.
   * A "leaf folder" is a folder containing audio files (it may have subfolders too,
   * but if it directly contains audio files, it's treated as a book folder).
   */
  private async findAudioLeafFolders(dirPath: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const hasAudioFiles = entries.some(
        (e) => e.isFile() && AUDIO_EXTENSIONS.has(extname(e.name).toLowerCase()),
      );

      if (hasAudioFiles) {
        // This folder contains audio files — it's a book folder
        results.push(dirPath);
      } else {
        // No audio files here — recurse into subdirectories
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            const subResults = await this.findAudioLeafFolders(join(dirPath, entry.name));
            results.push(...subResults);
          }
        }
      }
    } catch (error) {
      this.log.warn({ error, path: dirPath }, 'Error scanning directory');
    }

    return results;
  }

  private async getAudioStats(dirPath: string): Promise<{ fileCount: number; totalSize: number }> {
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
          const sub = await this.getAudioStats(entryPath);
          fileCount += sub.fileCount;
          totalSize += sub.totalSize;
        }
      }
    } catch (error) {
      this.log.warn({ error, path: dirPath }, 'Error getting audio stats');
    }

    return { fileCount, totalSize };
  }
}

/**
 * Parse folder path components into title/author/series.
 * Handles common naming patterns:
 * - Author/Title
 * - Author/Series/Title
 * - Author - Title
 * - Title (Author)
 * - Title only
 */
export function parseFolderStructure(parts: string[]): {
  title: string;
  author: string | null;
  series: string | null;
} {
  if (parts.length === 0) {
    return { title: 'Unknown', author: null, series: null };
  }

  // Single folder: try to parse "Author - Title" or "Title (Author)"
  if (parts.length === 1) {
    const folder = parts[0];
    return parseSingleFolder(folder);
  }

  // Two folders: Author/Title
  if (parts.length === 2) {
    return {
      title: cleanName(parts[1]),
      author: cleanName(parts[0]),
      series: null,
    };
  }

  // Three or more folders: Author/Series/Title (take first, second-to-last, last)
  return {
    title: cleanName(parts[parts.length - 1]),
    author: cleanName(parts[0]),
    series: cleanName(parts[parts.length - 2]),
  };
}

function parseSingleFolder(folder: string): {
  title: string;
  author: string | null;
  series: string | null;
} {
  // Pattern: "Author - Title"
  const dashMatch = folder.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch) {
    return {
      title: cleanName(dashMatch[2]),
      author: cleanName(dashMatch[1]),
      series: null,
    };
  }

  // Pattern: "Title (Author)" or "Title [Author]"
  const parenMatch = folder.match(/^(.+?)\s*[([](.+?)[)\]]$/);
  if (parenMatch) {
    return {
      title: cleanName(parenMatch[1]),
      author: cleanName(parenMatch[2]),
      series: null,
    };
  }

  // Just a title
  return {
    title: cleanName(folder),
    author: null,
    series: null,
  };
}

function cleanName(name: string): string {
  return name
    .replace(/^\d+\.\s*/, '') // Remove leading numbers like "01. "
    .replace(/\s*\(\d{4}\)$/, '') // Remove trailing year like "(2020)"
    .replace(/\s*\[\d{4}\]$/, '') // Remove trailing year like "[2020]"
    .trim();
}
