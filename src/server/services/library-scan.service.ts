/* eslint-disable max-lines -- service covers scan, import, and enrichment pipelines */
import { access, readdir, stat, mkdir, cp, rm } from 'node:fs/promises';
import { join, extname, relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, bookAuthors } from '../../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { slugify } from '../../core/utils/parse.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { discoverBooks } from '../../core/utils/book-discovery.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getPathSize } from '../utils/import-helpers.js';
import { enrichBookFromAudio } from './enrichment-utils.js';

/** Minimum ratio of target/source file size for copy verification to pass. */
const COPY_VERIFICATION_THRESHOLD = 0.99;

export interface DiscoveredBook {
  path: string;
  parsedTitle: string;
  parsedAuthor: string | null;
  parsedSeries: string | null;
  fileCount: number;
  totalSize: number;
}

export type ImportMode = 'copy' | 'move';

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

export interface RescanResult {
  scanned: number;
  missing: number;
  restored: number;
}

export class LibraryScanService {
  private scanning = false;

  constructor(
    private db: Db,
    private bookService: BookService,
    private metadataService: MetadataService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Rescan library — verify each book's path exists on disk, mark missing/restored.
   */
  async rescanLibrary(): Promise<RescanResult> {
    if (this.scanning) {
      throw new ScanInProgressError();
    }
    this.scanning = true;

    try {
      const librarySettings = await this.settingsService.get('library');
      const libraryRoot = librarySettings?.path;
      if (!libraryRoot) {
        throw new LibraryPathError('Library path is not configured');
      }

      // Verify the library root is accessible
      try {
        await access(libraryRoot);
      } catch {
        throw new LibraryPathError(`Library path is not accessible: ${libraryRoot}`);
      }
      const resolvedRoot = resolve(libraryRoot);

      const rows = await this.db
        .select({ id: books.id, path: books.path, status: books.status })
        .from(books)
        .where(inArray(books.status, ['imported', 'missing']));

      let scanned = 0;
      let missing = 0;
      let restored = 0;

      for (const row of rows) {
        if (!row.path) continue;

        // Path ancestry check — skip books outside library root
        const resolvedPath = resolve(row.path);
        const rel = relative(resolvedRoot, resolvedPath);
        if (rel.startsWith('..') || isAbsolute(rel)) continue;

        scanned++;

        let exists = false;
        try {
          await access(row.path);
          exists = true;
        } catch {
          // path does not exist
        }

        if (row.status === 'imported' && !exists) {
          await this.db.update(books).set({ status: 'missing', updatedAt: new Date() }).where(eq(books.id, row.id));
          this.log.warn({ bookId: row.id, path: row.path }, 'Book path missing from disk');
          missing++;
        } else if (row.status === 'missing' && exists) {
          await this.db.update(books).set({ status: 'imported', updatedAt: new Date() }).where(eq(books.id, row.id));
          this.log.info({ bookId: row.id, path: row.path }, 'Book path restored on disk');
          restored++;
        }
      }

      this.log.info({ scanned, missing, restored }, 'Library rescan complete');
      return { scanned, missing, restored };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Scan a directory tree for audiobook folders.
   * Uses core discoverBooks() for filesystem walk, then enriches each folder
   * with parsed folder structure + audio tag data.
   */
  async scanDirectory(rootPath: string): Promise<ScanResult> {
    this.log.info({ rootPath }, 'Starting directory scan');

    const folders = await discoverBooks(rootPath, { log: this.log });
    this.log.info({ count: folders.length }, 'Found audio folders');

    // Pre-fetch all existing book paths into a Set for O(1) duplicate check
    const existingPathRows = await this.db
      .select({ path: books.path })
      .from(books);
    const existingPaths = new Set(existingPathRows.map((r) => r.path).filter(Boolean));

    // Pre-fetch all title + author slug pairs into a Set for O(1) duplicate check
    const titleAuthorRows = await this.db
      .select({ title: books.title, slug: authors.slug })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id));
    const existingTitleAuthorKeys = new Set(
      titleAuthorRows
        .filter((r) => r.title && r.slug)
        .map((r) => `${r.title}|${r.slug}`),
    );

    const discoveries: DiscoveredBook[] = [];
    let skippedDuplicates = 0;

    for (const folder of folders) {
      const parsed = parseFolderStructure(folder.folderParts);

      // Check for duplicates by path (in-memory Set lookup)
      if (existingPaths.has(folder.path)) {
        this.log.debug({ path: folder.path }, 'Skipping duplicate (path match)');
        skippedDuplicates++;
        continue;
      }

      // Check for duplicates by title + author slug (in-memory Set lookup)
      if (parsed.title && parsed.author) {
        const authorSlug = slugify(parsed.author);
        const key = `${parsed.title}|${authorSlug}`;
        if (existingTitleAuthorKeys.has(key)) {
          this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Skipping duplicate (title+author match)');
          skippedDuplicates++;
          continue;
        }
      }

      this.log.debug(
        {
          path: folder.path,
          folderParse: { title: parsed.title, author: parsed.author, series: parsed.series },
          fileCount: folder.audioFileCount,
        },
        'Discovered book folder',
      );

      discoveries.push({
        path: folder.path,
        parsedTitle: parsed.title,
        parsedAuthor: parsed.author,
        parsedSeries: parsed.series,
        fileCount: folder.audioFileCount,
        totalSize: folder.totalSize,
      });
    }

    this.log.info(
      { discoveries: discoveries.length, skippedDuplicates, totalFolders: folders.length },
      'Directory scan complete',
    );

    return {
      discoveries,
      totalFolders: folders.length,
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
  async importSingleBook(item: ImportConfirmItem, metadata?: BookMetadata | null, mode?: ImportMode): Promise<ImportSingleResult> {
    // Duplicate check
    const existing = await this.bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
    if (existing) {
      this.log.debug({ title: item.title }, 'Skipping duplicate during import');
      return { imported: false, enriched: false, error: 'duplicate' };
    }

    // If no metadata passed, look it up
    const meta = metadata !== undefined ? metadata : await this.lookupMetadata(item.title, item.authorName);

    const book = await this.bookService.create(buildBookCreatePayload(item, meta, 'imported'));

    // Determine final path: copy/move to library or use source path
    let finalPath = item.path;
    if (mode) {
      finalPath = await this.copyToLibrary(item, book, meta, mode);
    }

    // Set the path and size
    const stats = await this.getAudioStats(finalPath);
    await this.db.update(books).set({
      path: finalPath,
      size: stats.totalSize,
      updatedAt: new Date(),
    }).where(eq(books.id, book.id));

    // Enrich with audio file metadata
    const audioResult = await enrichBookFromAudio(
      book.id,
      finalPath,
      { narrators: book.narrators ?? null, duration: book.duration, coverUrl: book.coverUrl },
      this.db,
      this.log,
      this.bookService,
    );

    // Audnexus enrichment
    await this.applyAudnexusEnrichment(book.id, {
      primaryAsin: item.asin || meta?.asin,
      alternateAsins: meta?.alternateAsins,
      existingNarrator: book.narrators?.[0]?.name ?? null,
      existingDuration: book.duration,
    });

    this.log.info({ bookId: book.id, title: item.title, enriched: audioResult.enriched, mode: mode ?? 'pointer' }, 'Single book imported');
    return { imported: true, bookId: book.id, enriched: audioResult.enriched };
  }

  /**
   * Copy (or move) source files into the library directory structure.
   * Returns the final library path.
   */
  // eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
  private async copyToLibrary(
    item: ImportConfirmItem,
    _book: { id: number; title: string; seriesName?: string | null; seriesPosition?: number | null; publishedDate?: string | null },
    meta: BookMetadata | null,
    mode: ImportMode,
  ): Promise<string> {
    const librarySettings = await this.settingsService.get('library');
    const targetPath = buildTargetPath(
      librarySettings.path,
      librarySettings.folderFormat,
      {
        title: item.title,
        seriesName: item.seriesName || meta?.series?.[0]?.name,
        seriesPosition: meta?.series?.[0]?.position,
        narrators: meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined,
        publishedDate: meta?.publishedDate,
      },
      item.authorName ?? null,
    );

    await mkdir(targetPath, { recursive: true });
    this.log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
    await cp(item.path, targetPath, { recursive: true, errorOnExist: false });

    // Verify copy (99% threshold)
    const sourceSize = await getPathSize(item.path);
    const targetSize = await getPathSize(targetPath);
    this.log.debug({ source: item.path, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Copy verification');
    if (targetSize < sourceSize * COPY_VERIFICATION_THRESHOLD) {
      throw new Error(`Copy verification failed: source ${sourceSize} bytes, target ${targetSize} bytes`);
    }

    // If move mode, delete source after successful copy
    if (mode === 'move') {
      await rm(item.path, { recursive: true });
      this.log.info({ source: item.path }, 'Source directory removed after move');
    }

    return targetPath;
  }

  /**
   * Confirm import — create placeholder book records with status 'importing',
   * kick off background processing, and return immediately.
   */
  async confirmImport(items: ImportConfirmItem[], mode?: ImportMode): Promise<{
    accepted: number;
  }> {
    this.log.info({ count: items.length, mode: mode ?? 'pointer' }, 'Accepting library import');

    // Create placeholder records synchronously
    const accepted: Array<{ bookId: number; item: ImportConfirmItem }> = [];

    for (const item of items) {
      try {
        // Duplicate check
        const existing = await this.bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
        if (existing) {
          this.log.debug({ title: item.title }, 'Skipping duplicate during import');
          continue;
        }

        this.log.debug(
          {
            title: item.title,
            author: item.authorName,
            hasMetadata: !!item.metadata,
            asin: item.asin || item.metadata?.asin,
          },
          'Creating import placeholder',
        );

        const book = await this.bookService.create(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));

        accepted.push({ bookId: book.id, item });
      } catch (error) {
        this.log.error({ error, title: item.title }, 'Failed to create placeholder for import');
      }
    }

    this.log.info({ accepted: accepted.length }, 'Import placeholders created, starting background processing');

    // Fire-and-forget background processing
    this.processImportsInBackground(accepted, mode).catch(error => {
      this.log.error({ error }, 'Background import processing failed');
    });

    return { accepted: accepted.length };
  }

  /**
   * Background processing: copy/move files, enrich, update status.
   */
  private async processImportsInBackground(
    items: Array<{ bookId: number; item: ImportConfirmItem }>,
    mode?: ImportMode,
  ): Promise<void> {
    for (const { bookId, item } of items) {
      try {
        await this.processOneImport(bookId, item, mode);
        this.log.info({ bookId, title: item.title }, 'Book import completed');
      } catch (error) {
        this.log.error({ error, bookId, title: item.title }, 'Book import failed');
        await this.db.update(books).set({
          status: 'missing',
          updatedAt: new Date(),
        }).where(eq(books.id, bookId));
      }
    }
  }

  // eslint-disable-next-line complexity -- copy/move + enrich + audnexus pipeline, barely over threshold
  private async processOneImport(bookId: number, item: ImportConfirmItem, mode?: ImportMode): Promise<void> {
    this.log.debug({ bookId, title: item.title, mode: mode ?? 'pointer' }, 'Processing import');

    const meta = item.metadata;
    const narratorName = meta?.narrators?.[0] ?? null;
    const duration = meta?.duration ?? null;
    const coverUrl = item.coverUrl || meta?.coverUrl || null;
    const primaryAsin = item.asin || meta?.asin;

    // Determine final path: copy/move to library or use source path
    let finalPath = item.path;
    if (mode) {
      const bookRecord = await this.db.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (bookRecord.length > 0) {
        finalPath = await this.copyToLibrary(item, bookRecord[0], meta ?? null, mode);
      }
    }

    // Set the path and size
    const stats = await this.getAudioStats(finalPath);
    this.log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');
    await this.db.update(books).set({
      path: finalPath,
      size: stats.totalSize,
      updatedAt: new Date(),
    }).where(eq(books.id, bookId));

    // Enrich with audio file metadata (WITH cover extraction)
    this.log.debug({ bookId }, 'Starting audio enrichment');
    await enrichBookFromAudio(bookId, finalPath, { narrators: narratorName ? [{ name: narratorName }] : null, duration, coverUrl }, this.db, this.log, this.bookService);

    // Audnexus enrichment
    await this.applyAudnexusEnrichment(bookId, {
      primaryAsin,
      alternateAsins: meta?.alternateAsins,
      existingNarrator: narratorName,
      existingDuration: duration,
    });

    // Success — mark as imported
    await this.db.update(books).set({
      status: 'imported',
      updatedAt: new Date(),
    }).where(eq(books.id, bookId));
  }

  /**
   * Search metadata providers for a book by title + author.
   * Returns the best match or null if no confident match found.
   */
  async lookupMetadata(title: string, authorName?: string): Promise<BookMetadata | null> {
    try {
      const query = authorName ? `${title} ${authorName}` : title;
      const results = await this.metadataService.searchBooks(query);
      this.log.debug({ title, authorName, query, resultCount: results.length }, 'Metadata search completed');
      if (results.length === 0) {
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

  /**
   * Apply Audnexus enrichment — try primary ASIN, then alternates.
   * Updates narrator/duration if not already present.
   */
  private async applyAudnexusEnrichment(
    bookId: number,
    opts: {
      primaryAsin?: string | null;
      alternateAsins?: string[];
      existingNarrator?: string | null;
      existingDuration?: number | null;
    },
  ): Promise<void> {
    const asinsToTry = [opts.primaryAsin, ...(opts.alternateAsins ?? [])].filter((a): a is string => !!a);
    if (asinsToTry.length === 0) return;

    for (const asin of asinsToTry) {
      try {
        const data = await this.metadataService.enrichBook(asin);
        if (data) {
          const updates: Partial<{ enrichmentStatus: string; asin: string; duration: number; updatedAt: Date }> = {
            enrichmentStatus: 'enriched',
            updatedAt: new Date(),
          };
          if (asin !== opts.primaryAsin) updates.asin = asin;
          if (!opts.existingDuration && data.duration) {
            updates.duration = data.duration;
          }
          await this.db.update(books).set(updates).where(eq(books.id, bookId));
          if (!opts.existingNarrator && data.narrators?.length) {
            await this.bookService.update(bookId, { narrators: data.narrators });
          }
          this.log.info({ bookId, asin, wasAlternate: asin !== opts.primaryAsin }, 'Audnexus enrichment applied');
          break;
        }
      } catch (error) {
        this.log.warn({ error, bookId, asin }, 'Audnexus enrichment failed');
      }
    }
  }
}

// eslint-disable-next-line complexity -- flat metadata coalescing across item + meta sources
function buildBookCreatePayload(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  status: 'imported' | 'importing',
) {
  return {
    title: item.title,
    // When metadata provides multiple authors (co-authored books), preserve the full array.
    // For single-author metadata, defer to the parsed folder author (allows user override).
    authors: (meta?.authors && meta.authors.length > 1)
      ? meta.authors
      : (item.authorName ? [{ name: item.authorName }] : (meta?.authors?.length ? meta.authors : [])),
    narrators: meta?.narrators,
    seriesName: item.seriesName || meta?.series?.[0]?.name,
    seriesPosition: meta?.series?.[0]?.position,
    coverUrl: item.coverUrl || meta?.coverUrl,
    asin: item.asin || meta?.asin,
    isbn: meta?.isbn,
    description: meta?.description,
    duration: meta?.duration,
    publishedDate: meta?.publishedDate,
    genres: meta?.genres,
    providerId: meta?.providerId,
    status,
  };
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

// ─── Typed Error Classes ──────────────────────────────────────────────

export class ScanInProgressError extends Error {
  readonly code = 'SCAN_IN_PROGRESS' as const;
  constructor() {
    super('Scan already in progress');
    this.name = 'ScanInProgressError';
  }
}

export class LibraryPathError extends Error {
  readonly code = 'LIBRARY_PATH' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LibraryPathError';
  }
}
