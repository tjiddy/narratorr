import { access } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, bookAuthors } from '../../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { slugify } from '../../core/utils/parse.js';
import { discoverBooks } from '../../core/utils/book-discovery.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { confirmImport as confirmImportHelper, type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { buildDiscoveredBook } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { parseFolderStructure } from '../utils/folder-parsing.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';
import { WireOnce } from './wire-helpers.js';


export type { DiscoveredBook };

export type ImportMode = 'copy' | 'move';

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
  narrators?: string[];
  seriesPosition?: number;
  coverUrl?: string;
  asin?: string;
  metadata?: BookMetadata;
  /** When true, bypasses the title+author safety-net duplicate check */
  forceImport?: boolean;
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

export interface LibraryScanServiceWireDeps {
  nudgeImportWorker: () => void;
}

export class LibraryScanService {
  private scanning = false;
  private wired = new WireOnce<LibraryScanServiceWireDeps>('LibraryScanService');

  constructor(
    private db: Db,
    private bookService: BookService,
    private bookImportService: BookImportService,
    private metadataService: MetadataService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
  ) {}

  /** Wire cyclic / late-bound deps after construction. Call once during composition. */
  wire(deps: LibraryScanServiceWireDeps): void {
    this.wired.set(deps);
  }

  private get enrichmentDeps(): EnrichmentDeps {
    return { db: this.db, log: this.log, settingsService: this.settingsService, bookService: this.bookService, metadataService: this.metadataService };
  }

  get importDeps(): ImportPipelineDeps {
    return { db: this.db, log: this.log, bookService: this.bookService, bookImportService: this.bookImportService, settingsService: this.settingsService, eventHistory: this.eventHistory, enrichmentDeps: this.enrichmentDeps, broadcaster: this.eventBroadcaster };
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

  async confirmImport(items: ImportConfirmItem[], mode?: ImportMode): Promise<{ accepted: number }> {
    const { nudgeImportWorker } = this.wired.require();
    return confirmImportHelper(items, this.importDeps, mode, nudgeImportWorker);
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
