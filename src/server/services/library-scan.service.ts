import { access } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, bookAuthors } from '../../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { slugify } from '../../core/utils/parse.js';
import { discoverBooks } from '../../core/utils/book-discovery.js';
import type { BookService } from './book.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { importSingleBook as importSingleBookHelper, confirmImport as confirmImportHelper, type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { findAudioLeafFolders, getAudioStats, buildDiscoveredBook } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import { searchWithSwapRetry } from '../utils/search-helpers.js';
import { parseFolderStructure } from '../utils/folder-parsing.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';

export type { DiscoveredBook };

export type ImportMode = 'copy' | 'move';

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
  coverUrl?: string;
  asin?: string;
  metadata?: BookMetadata;
  /** When true, bypasses the title+author safety-net duplicate check */
  forceImport?: boolean;
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
    private eventHistory: EventHistoryService,
  ) {}

  private get enrichmentDeps(): EnrichmentDeps {
    return { db: this.db, log: this.log, settingsService: this.settingsService, bookService: this.bookService, metadataService: this.metadataService };
  }

  private get importDeps(): ImportPipelineDeps {
    return { db: this.db, log: this.log, bookService: this.bookService, settingsService: this.settingsService, eventHistory: this.eventHistory, enrichmentDeps: this.enrichmentDeps };
  }

  /**
   * Rescan library — verify each book's path exists on disk, mark missing/restored.
   */
  async rescanLibrary(): Promise<RescanResult> {
    if (this.scanning) {
      throw new ScanInProgressError();
    }
    this.scanning = true;
    const startMs = Date.now();

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

      this.log.info({ scanned, missing, restored, elapsedMs: Date.now() - startMs }, 'Library rescan complete');
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

    // Pre-fetch all existing book paths with IDs for O(1) duplicate check
    const existingPathRows = await this.db
      .select({ id: books.id, path: books.path })
      .from(books);
    const existingPathMap = new Map(
      existingPathRows.filter((r) => r.path != null).map((r) => [r.path!, r.id] as const),
    );

    // Pre-fetch all title + author slug pairs with IDs for O(1) duplicate check
    const titleAuthorRows = await this.db
      .select({ id: books.id, title: books.title, slug: authors.slug })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id));
    const existingTitleAuthorMap = new Map<string, number>(
      titleAuthorRows
        .filter((r) => r.title && r.slug)
        .map((r) => [`${r.title!.toLowerCase()}|${r.slug}`, r.id] as [string, number]),
    );

    const discoveries: DiscoveredBook[] = [];
    const withinScanSlugMap = new Map<string, string>();

    for (const folder of folders) {
      const parsed = parseFolderStructure(folder.folderParts);

      // Check for duplicates by path (in-memory Map lookup)
      if (existingPathMap.has(folder.path)) {
        this.log.debug({ path: folder.path }, 'Duplicate detected (path match)');
        discoveries.push(buildDiscoveredBook(
          folder.path, parsed, folder.audioFileCount, folder.totalSize,
          true, existingPathMap.get(folder.path), 'path',
        ));
        continue;
      }

      // Check for duplicates by title + author slug (in-memory Map lookup)
      if (parsed.title && parsed.author) {
        const authorSlug = slugify(parsed.author);
        const key = `${parsed.title.toLowerCase()}|${authorSlug}`;
        if (existingTitleAuthorMap.has(key)) {
          this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Duplicate detected (title+author match)');
          discoveries.push(buildDiscoveredBook(
            folder.path, parsed, folder.audioFileCount, folder.totalSize,
            true, existingTitleAuthorMap.get(key), 'slug',
          ));
          continue;
        }

        // Check for within-scan duplicates (same title+author seen earlier in this scan)
        if (withinScanSlugMap.has(key)) {
          this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Duplicate detected (within-scan title+author match)');
          discoveries.push(buildDiscoveredBook(
            folder.path, parsed, folder.audioFileCount, folder.totalSize,
            true, undefined, 'within-scan', withinScanSlugMap.get(key),
          ));
          continue;
        }

        withinScanSlugMap.set(key, folder.path);
      }

      this.log.debug(
        {
          path: folder.path,
          folderParse: { title: parsed.title, author: parsed.author, series: parsed.series },
          fileCount: folder.audioFileCount,
        },
        'Discovered book folder',
      );

      discoveries.push(buildDiscoveredBook(
        folder.path, parsed, folder.audioFileCount, folder.totalSize, false,
      ));
    }

    const duplicateCount = discoveries.filter((d) => d.isDuplicate).length;
    this.log.info(
      { discoveries: discoveries.length, duplicateCount, totalFolders: folders.length },
      'Directory scan complete',
    );

    return {
      discoveries,
      totalFolders: folders.length,
    };
  }

  /**
   * Scan a single book folder — validates it contains exactly one audiobook,
   * parses folder structure, and looks up metadata providers.
   */
  async scanSingleBook(folderPath: string): Promise<SingleBookResult> {
    this.log.info({ folderPath }, 'Scanning single book folder');

    const leafFolders = await findAudioLeafFolders(folderPath, this.log);

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

    const { fileCount, totalSize } = await getAudioStats(bookPath, this.log);

    const book = buildDiscoveredBook(bookPath, parsed, fileCount, totalSize, false);

    // Look up metadata providers
    const metadata = await this.lookupMetadata(parsed.title, parsed.author || undefined, parsed.asin);

    return { book, metadata };
  }

  async importSingleBook(item: ImportConfirmItem, metadata?: BookMetadata | null, mode?: ImportMode): Promise<ImportSingleResult> {
    return importSingleBookHelper(item, this.importDeps, (t, a) => this.lookupMetadata(t, a), metadata, mode);
  }

  async confirmImport(items: ImportConfirmItem[], mode?: ImportMode): Promise<{ accepted: number }> {
    return confirmImportHelper(items, this.importDeps, mode);
  }

  /**
   * Search metadata providers for a book by title + author.
   * Returns the best match or null if no confident match found.
   */
  async lookupMetadata(title: string, authorName?: string, asin?: string): Promise<BookMetadata | null> {
    // Direct ASIN lookup — skip keyword search when we have an ASIN
    if (asin) {
      try {
        const direct = await this.metadataService.getBook(asin);
        if (direct) {
          this.log.info({ asin, title: direct.title }, 'Direct ASIN lookup succeeded');
          return direct;
        }
        this.log.debug({ asin }, 'Direct ASIN lookup returned null — falling back to keyword search');
      } catch (error: unknown) {
        this.log.warn({ error, asin }, 'Direct ASIN lookup failed — falling back to keyword search');
      }
    }

    try {
      const results = await searchWithSwapRetry({
        searchFn: (q) => this.metadataService.searchBooks(q),
        title,
        author: authorName || undefined,
        log: this.log,
      });
      this.log.debug({ title, authorName, resultCount: results.length }, 'Metadata search completed');
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
        } catch (error: unknown) {
          this.log.warn({ error, providerId: match.providerId }, 'Failed to fetch book detail — using search result');
        }
      }

      this.log.info(
        { title, matchedTitle: match.title, asin: match.asin, providerId: match.providerId },
        'Metadata match found for imported book',
      );
      return match;
    } catch (error: unknown) {
      this.log.warn({ error, title }, 'Metadata lookup failed during import');
      return null;
    }
  }

}

// Re-export parsing utilities from shared module (extracted for reuse by scan-debug endpoint)
export { parseFolderStructure, cleanName, extractYear } from '../utils/folder-parsing.js';

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
