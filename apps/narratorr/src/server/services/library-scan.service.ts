import { readdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@narratorr/db/schema';
import { eq } from 'drizzle-orm';
import { AUDIO_EXTENSIONS } from '@narratorr/core/utils';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { BookMetadata } from '@narratorr/core/metadata';
import { enrichBookFromAudio } from './enrichment-utils.js';

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
  metadata?: BookMetadata;
}

export interface SingleBookResult {
  book: DiscoveredBook;
  metadata: BookMetadata | null;
}

export interface ImportSingleResult {
  imported: boolean;
  bookId?: number;
  enriched: boolean;
  error?: string;
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
    private metadataService: MetadataService,
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
   * Scan a single book folder — validates it contains exactly one audiobook,
   * parses folder structure, and looks up metadata providers.
   */
  async scanSingleBook(folderPath: string): Promise<SingleBookResult> {
    this.log.info({ folderPath }, 'Scanning single book folder');

    const leafFolders = await this.findAudioLeafFolders(folderPath);

    if (leafFolders.length === 0) {
      throw new Error('No audio files found in this folder');
    }

    if (leafFolders.length > 1) {
      throw new Error(
        `This folder contains ${leafFolders.length} audiobooks. Use Library Import for bulk imports.`,
      );
    }

    const bookPath = leafFolders[0];
    const relativePath = relative(folderPath, bookPath);
    const parts = relativePath ? relativePath.split(/[/\\]/).filter(Boolean) : [];

    // If parts is empty (audio files are directly in the given folder),
    // try parsing the folder name itself
    const parsed = parts.length > 0
      ? parseFolderStructure(parts)
      : parseFolderStructure([folderPath.split(/[/\\]/).filter(Boolean).pop() || 'Unknown']);

    const { fileCount, totalSize } = await this.getAudioStats(bookPath);

    const book: DiscoveredBook = {
      path: bookPath,
      parsedTitle: parsed.title,
      parsedAuthor: parsed.author,
      parsedSeries: parsed.series,
      fileCount,
      totalSize,
    };

    // Look up metadata providers
    const metadata = await this.lookupMetadata(parsed.title, parsed.author || undefined);

    return { book, metadata };
  }

  /**
   * Import a single book — creates the DB record, sets path/size, and enriches.
   * Shared pipeline used by both Quick Add and bulk Library Import.
   */
  async importSingleBook(item: ImportConfirmItem, metadata?: BookMetadata | null): Promise<ImportSingleResult> {
    // Duplicate check
    const existing = await this.bookService.findDuplicate(item.title, item.authorName);
    if (existing) {
      this.log.debug({ title: item.title }, 'Skipping duplicate during import');
      return { imported: false, enriched: false, error: 'duplicate' };
    }

    // If no metadata passed, look it up
    const meta = metadata !== undefined ? metadata : await this.lookupMetadata(item.title, item.authorName);

    const book = await this.bookService.create({
      title: item.title,
      authorName: item.authorName,
      seriesName: item.seriesName || meta?.series?.[0]?.name,
      seriesPosition: meta?.series?.[0]?.position,
      coverUrl: item.coverUrl || meta?.coverUrl,
      asin: item.asin || meta?.asin,
      isbn: meta?.isbn,
      narrator: meta?.narrators?.join(', '),
      description: meta?.description,
      duration: meta?.duration,
      publishedDate: meta?.publishedDate,
      genres: meta?.genres,
      providerId: meta?.providerId,
      status: 'imported',
    });

    // Set the path and size
    const stats = await this.getAudioStats(item.path);
    await this.db.update(books).set({
      path: item.path,
      size: stats.totalSize,
      updatedAt: new Date(),
    }).where(eq(books.id, book.id));

    // Enrich with audio file metadata
    let enriched = false;
    const audioResult = await enrichBookFromAudio(
      book.id,
      item.path,
      { narrator: book.narrator, duration: book.duration, coverUrl: book.coverUrl },
      this.db,
      this.log,
    );
    enriched = audioResult.enriched;

    // Inline Audnexus enrichment — try primary ASIN, then alternates
    const primaryAsin = item.asin || meta?.asin;
    const asinsToTry = [primaryAsin, ...(meta?.alternateAsins ?? [])].filter((a): a is string => !!a);

    for (const asin of asinsToTry) {
      try {
        const audnexusData = await this.metadataService.enrichBook(asin);
        if (audnexusData) {
          const updates: Record<string, unknown> = {
            enrichmentStatus: 'enriched',
            updatedAt: new Date(),
          };
          if (asin !== primaryAsin) {
            // Found data with an alternate ASIN — store it for future lookups
            updates.asin = asin;
          }
          if (!book.narrator && audnexusData.narrators?.length) {
            updates.narrator = audnexusData.narrators.join(', ');
          }
          if (!book.duration && audnexusData.duration) {
            updates.duration = audnexusData.duration;
          }
          await this.db.update(books).set(updates).where(eq(books.id, book.id));
          this.log.info({ bookId: book.id, asin, wasAlternate: asin !== primaryAsin }, 'Audnexus enrichment applied inline');
          break;
        }
      } catch (error) {
        this.log.warn({ error, bookId: book.id, asin }, 'Audnexus enrichment failed for ASIN');
      }
    }

    this.log.info({ bookId: book.id, title: item.title, enriched }, 'Single book imported');
    return { imported: true, bookId: book.id, enriched };
  }

  /**
   * Confirm import — create book records for selected discoveries,
   * then enrich each with audio file metadata.
   */
  async confirmImport(items: ImportConfirmItem[]): Promise<{
    imported: number;
    failed: number;
    enriched: number;
    enrichmentFailed: number;
  }> {
    this.log.info({ count: items.length }, 'Starting library import');

    let imported = 0;
    let failed = 0;
    let enriched = 0;
    let enrichmentFailed = 0;

    for (const item of items) {
      try {
        const result = await this.importSingleBook(item);
        if (result.imported) {
          imported++;
          if (result.enriched) {
            enriched++;
          } else {
            enrichmentFailed++;
          }
        }
      } catch (error) {
        this.log.error({ error, title: item.title, path: item.path }, 'Failed to import book');
        failed++;
      }
    }

    this.log.info({ imported, failed, enriched, enrichmentFailed }, 'Library import complete');
    return { imported, failed, enriched, enrichmentFailed };
  }

  /**
   * Search metadata providers for a book by title + author.
   * Returns the best match or null if no confident match found.
   */
  async lookupMetadata(title: string, authorName?: string): Promise<BookMetadata | null> {
    try {
      const query = authorName ? `${title} ${authorName}` : title;
      const results = await this.metadataService.searchBooks(query);
      if (results.length === 0) {
        this.log.debug({ title, authorName }, 'No metadata match found');
        return null;
      }

      // Take the top result — providers return by relevance
      let match = results[0];

      // Search results lack edition-level data (ASIN, narrators).
      // If we have a providerId, fetch full detail to get those fields.
      if (match.providerId && !match.asin) {
        try {
          const detail = await this.metadataService.getBook(match.providerId);
          if (detail) {
            this.log.debug({ providerId: match.providerId, asin: detail.asin }, 'Fetched full book detail for ASIN');
            match = { ...match, ...detail, title: match.title };
          }
        } catch (error) {
          this.log.warn({ error, providerId: match.providerId }, 'Failed to fetch book detail — using search result');
        }
      }

      this.log.info(
        { title, matchedTitle: match.title, asin: match.asin, providerId: match.providerId },
        'Metadata match found for imported book',
      );
      return match;
    } catch (error) {
      this.log.warn({ error, title }, 'Metadata lookup failed during import');
      return null;
    }
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
  // Pattern: "Author - Title" (skip if left side is just a number like "01 - Title")
  const dashMatch = folder.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch && !/^\d+$/.test(dashMatch[1].trim())) {
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
    .replace(/^\d+[.\s]*-\s*|^\d+\.\s*/, '') // Remove leading numbers like "01. " or "01 - "
    .replace(/\s*\(\d{4}\)$/, '') // Remove trailing year like "(2020)"
    .replace(/\s*\[\d{4}\]$/, '') // Remove trailing year like "[2020]"
    .trim();
}
