/* eslint-disable max-lines -- service covers scan, import, and enrichment pipelines */
import { access, mkdir, cp, rm } from 'node:fs/promises';
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
import { buildTargetPath, getAudioPathSize } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { orchestrateBookEnrichment, buildBookCreatePayload, buildEnrichmentBookInput, buildAudnexusConfig, buildImportedEventPayload, extractImportMetadata, buildBackgroundAudnexusConfig, type EnrichmentDeps } from './enrichment-orchestration.helper.js';
import { findAudioLeafFolders, getAudioStats, buildDiscoveredBook } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { searchWithSwapRetry } from '../utils/search-helpers.js';
import { parseFolderStructure } from '../utils/folder-parsing.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';

export type { DiscoveredBook };

/** Minimum ratio of target/source file size for copy verification to pass. */
const COPY_VERIFICATION_THRESHOLD = 0.99;

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

  /**
   * Import a single book — creates the DB record, sets path/size, and enriches.
   * Shared pipeline used by both Quick Add and bulk Library Import.
   */
  // eslint-disable-next-line complexity -- create + duplicate check + metadata lookup + event recording + enrichment pipeline
  async importSingleBook(item: ImportConfirmItem, metadata?: BookMetadata | null, mode?: ImportMode): Promise<ImportSingleResult> {
    // Duplicate check
    const existing = await this.bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
    if (existing) {
      this.log.debug({ title: item.title }, 'Skipping duplicate during import');
      return { imported: false, enriched: false, error: 'duplicate' };
    }

    // If no metadata passed, look it up
    const meta = metadata !== undefined ? metadata : await this.lookupMetadata(item.title, item.authorName);

    // Create book record — record failure event if this throws (no bookId yet)
    let book: Awaited<ReturnType<typeof this.bookService.create>>;
    try {
      book = await this.bookService.create(buildBookCreatePayload(item, meta, 'imported'));
    } catch (error: unknown) {
      this.eventHistory.create({
        bookId: null,
        bookTitle: item.title,
        authorName: item.authorName ?? null,
        narratorName: meta?.narrators?.[0] ?? null,
        downloadId: null,
        eventType: 'import_failed',
        source: 'manual',
        reason: { error: getErrorMessage(error, 'Import failed') },
      }).catch(err => this.log.warn({ err }, 'Failed to record manual import failed event'));
      throw error;
    }

    // Record book_added event (fire-and-forget)
    this.eventHistory.create({
      bookId: book.id,
      bookTitle: book.title,
      authorName: book.authors?.map(a => a.name).join(', ') || null,
      eventType: 'book_added',
      source: 'manual',
    }).catch(err => this.log.warn({ err }, 'Failed to record book_added event'));

    try {
      const enriched = await this.enrichImportedBook(item, book, meta, mode);
      return { imported: true, bookId: book.id, enriched };
    } catch (error: unknown) {
      // Record failure event (fire-and-forget) then re-throw so the route returns 500
      this.eventHistory.create({
        bookId: book.id,
        bookTitle: item.title,
        authorName: item.authorName ?? null,
        narratorName: meta?.narrators?.[0] ?? null,
        downloadId: null,
        eventType: 'import_failed',
        source: 'manual',
        reason: { error: getErrorMessage(error, 'Import failed') },
      }).catch(err => this.log.warn({ err }, 'Failed to record manual import failed event'));
      throw error;
    }
  }

  private async enrichImportedBook(
    item: ImportConfirmItem,
    book: { id: number; narrators?: Array<{ name: string }> | null; duration?: number | null; coverUrl?: string | null; genres?: string[] | null },
    meta: BookMetadata | null,
    mode?: ImportMode,
  ): Promise<boolean> {
    let finalPath = item.path;
    if (mode) {
      finalPath = await this.copyToLibrary(item, book as Parameters<typeof this.copyToLibrary>[1], meta, mode);
    }

    const stats = await getAudioStats(finalPath, this.log);
    await this.db.update(books).set({ path: finalPath, size: stats.totalSize, updatedAt: new Date() }).where(eq(books.id, book.id));

    const { audioEnriched } = await orchestrateBookEnrichment(
      book.id, finalPath, buildEnrichmentBookInput(book), this.enrichmentDeps, buildAudnexusConfig(item, meta, book),
    );

    this.eventHistory.create(buildImportedEventPayload(book.id, item, meta?.narrators?.[0] ?? null, resolve(finalPath), mode))
      .catch(err => this.log.warn({ err }, 'Failed to record manual import event'));

    this.log.info({ bookId: book.id, title: item.title, enriched: audioEnriched, mode: mode ?? 'pointer' }, 'Single book imported');
    return audioEnriched;
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
    const namingOptions = toNamingOptions(librarySettings);
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
      namingOptions,
    );

    // Skip file operations when source already is the target (book already in library at correct path)
    if (resolve(item.path) === resolve(targetPath)) {
      this.log.info({ path: targetPath, mode }, 'Source and target are the same path — skipping file operation');
      return targetPath;
    }

    // Guard: block sources inside (or equal to) the library root
    const rel = relative(resolve(librarySettings.path), resolve(item.path));
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      throw new Error('Source path is inside the library root — cannot import a path already managed by the library');
    }

    await mkdir(targetPath, { recursive: true });
    this.log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
    await cp(item.path, targetPath, { recursive: true, errorOnExist: false });

    // Verify copy (99% threshold) — compare audio-only sizes to avoid false failures from non-audio files
    const sourceSize = await getAudioPathSize(item.path);
    const targetSize = await getAudioPathSize(targetPath);
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
        // Duplicate safety-net check (bypassed when forceImport is explicitly set)
        if (!item.forceImport) {
          const existing = await this.bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
          if (existing) {
            this.log.debug({ title: item.title }, 'Skipping duplicate during import');
            continue;
          }
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

        // Record book_added event (fire-and-forget)
        this.eventHistory.create({
          bookId: book.id,
          bookTitle: book.title,
          authorName: book.authors?.map(a => a.name).join(', ') || null,
          eventType: 'book_added',
          source: 'manual',
        }).catch(err => this.log.warn({ err }, 'Failed to record book_added event'));

        accepted.push({ bookId: book.id, item });
      } catch (error: unknown) {
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
      } catch (error: unknown) {
        this.log.error({ error, bookId, title: item.title }, 'Book import failed');
        await this.db.update(books).set({
          status: 'missing',
          updatedAt: new Date(),
        }).where(eq(books.id, bookId));
        // Record failure event (fire-and-forget)
        this.eventHistory.create({
          bookId,
          bookTitle: item.title,
          authorName: item.authorName ?? null,
          narratorName: item.metadata?.narrators?.[0] ?? null,
          downloadId: null,
          eventType: 'import_failed',
          source: 'manual',
          reason: { error: getErrorMessage(error, 'Import failed') },
        }).catch(err => this.log.warn({ err }, 'Failed to record import failed event'));
      }
    }
  }

  private async processOneImport(bookId: number, item: ImportConfirmItem, mode?: ImportMode): Promise<void> {
    this.log.debug({ bookId, title: item.title, mode: mode ?? 'pointer' }, 'Processing import');

    const extracted = extractImportMetadata(item);

    let finalPath = item.path;
    if (mode) {
      const bookRecord = await this.db.select().from(books).where(eq(books.id, bookId)).limit(1);
      if (bookRecord.length > 0) {
        finalPath = await this.copyToLibrary(item, bookRecord[0], extracted.meta ?? null, mode);
      }
    }

    const stats = await getAudioStats(finalPath, this.log);
    this.log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');
    await this.db.update(books).set({ path: finalPath, size: stats.totalSize, updatedAt: new Date() }).where(eq(books.id, bookId));

    // Read current genres from DB (may have been filled since placeholder creation)
    const [currentBook] = await this.db.select({ genres: books.genres }).from(books).where(eq(books.id, bookId)).limit(1);

    this.log.debug({ bookId }, 'Starting audio enrichment');
    await orchestrateBookEnrichment(
      bookId, finalPath,
      buildEnrichmentBookInput({ ...extracted.bookInput, genres: currentBook?.genres ?? null }),
      this.enrichmentDeps,
      buildBackgroundAudnexusConfig(item, extracted, currentBook?.genres ?? null),
    );

    await this.db.update(books).set({ status: 'imported', updatedAt: new Date() }).where(eq(books.id, bookId));

    this.eventHistory.create(buildImportedEventPayload(bookId, item, extracted.narratorName, resolve(finalPath), mode))
      .catch(err => this.log.warn({ err }, 'Failed to record manual import event'));
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
