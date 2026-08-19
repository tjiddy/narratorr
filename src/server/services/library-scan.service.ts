import { access } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, bookAuthors } from '@db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { slugify } from '@core/utils/parse.js';
import { bookHoldsFile } from '@shared/book-holds-file.js';
import { discoverBooks, type DiscoveredFolder } from '@core/utils/book-discovery.js';
import { transitionBookStatus } from '../utils/book-status.js';
import { errnoCode, isDefinitiveAbsence } from '../utils/fs-errno.js';
import { serializeError } from '../utils/serialize-error.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '@core/metadata/index.js';
import { type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { buildDiscoveredBook } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import type { ConnectorImportItem } from '@core/connectors/index.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { parseFolderStructure } from '../utils/folder-parsing.js';
import { buildTitleShape, titlesMatchForDedup, type TitleShape } from '@shared/dedup.js';
import type { DiscoveredBook } from '@shared/schemas/library-scan.js';


export type { DiscoveredBook };

export type ImportMode = 'copy' | 'move';

// Display-only until narrator-aware matching supplies the authoritative recording verdict.
export const SCAN_RECORDING_REVIEW_HINT = 'Possible match to an existing book — checking recording';

// Within-scan collisions are only hints; confirmation owns recording identity.
export const SCAN_WITHIN_SCAN_REVIEW_HINT = 'Possible duplicate folder in this scan';

/** Bucket order is ascending book id; the first pairwise match wins. */
interface ExistingTitleEntry {
  id: number;
  shape: TitleShape;
}

/** Bucket order is scan order; later rows need only the prior title shape. */
interface WithinScanEntry {
  shape: TitleShape;
}

/** An ASIN-matched incumbent plus whether it actually owns a folder (#2435 AC12). */
interface AsinMatch {
  id: number;
  holdsFile: boolean;
}

interface ScanClassificationMaps {
  existingPathMap: Map<string, number>;
  existingAsinMap: Map<string, AsinMatch>;
  existingTitleAuthorBucket: Map<string, ExistingTitleEntry[]>;
  withinScanBucket: Map<string, WithinScanEntry[]>;
}

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

export class LibraryScanService {
  private scanning = false;

  constructor(
    private db: Db,
    private bookService: BookService,
    private bookImportService: BookImportService,
    private metadataService: MetadataService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
    private connectorService?: ConnectorService,
  ) {}

  private get enrichmentDeps(): EnrichmentDeps {
    return { db: this.db, log: this.log, settingsService: this.settingsService, bookService: this.bookService, metadataService: this.metadataService };
  }

  get importDeps(): ImportPipelineDeps {
    return { db: this.db, log: this.log, bookService: this.bookService, bookImportService: this.bookImportService, settingsService: this.settingsService, eventHistory: this.eventHistory, enrichmentDeps: this.enrichmentDeps, broadcaster: this.eventBroadcaster, connectorService: this.connectorService };
  }

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

      try {
        await access(libraryRoot);
      } catch {
        throw new LibraryPathError(`Library path is not accessible: ${libraryRoot}`);
      }
      const resolvedRoot = resolve(libraryRoot);

      const rows = await this.db
        .select({ id: books.id, path: books.path, status: books.status, title: books.title })
        .from(books)
        .where(inArray(books.status, ['imported', 'missing']));

      let scanned = 0;
      let missing = 0;
      let restored = 0;
      // Tallied for diagnostics but deliberately excluded from the public three-field `RescanResult`.
      let unreachable = 0;
      const unreachableCodes = new Set<string>();
      const restoredItems: ConnectorImportItem[] = [];

      for (const row of rows) {
        const outcome = await this.reconcileBookPath(row, resolvedRoot, unreachableCodes);
        if (outcome === 'skipped') continue;
        scanned++;
        if (outcome === 'missing') missing++;
        else if (outcome === 'unreachable') unreachable++;
        else if (outcome === 'restored') {
          restored++;
          // A restored outcome guarantees a non-null path.
          restoredItems.push({ bookId: row.id, title: row.title, libraryPath: row.path! });
        }
      }

      // Connector refresh is best-effort and only for actual restorations.
      if (this.connectorService && restoredItems.length > 0) {
        fireAndForget(
          this.connectorService.notifyRefresh('restored', restoredItems),
          this.log,
          'Failed to enqueue connector refresh on library rescan',
        );
      }

      // Aggregate unreachable rows to avoid one warning per book on a down mount.
      if (unreachable > 0) {
        this.log.warn(
          { unreachable, codes: [...unreachableCodes].sort() },
          'Library rescan could not reach some book paths — statuses retained',
        );
      }

      this.log.info({ scanned, missing, restored, unreachable, elapsedMs: Date.now() - startMs }, 'Library rescan complete');
      return { scanned, missing, restored };
    } finally {
      this.scanning = false;
    }
  }

  /** Only ENOENT/ENOTDIR prove absence; every other probe failure retains persisted status. */
  private classifyProbeFailure(
    row: { id: number; path: string },
    error: unknown,
    unreachableCodes: Set<string>,
  ): 'absent' | 'unreachable' {
    if (isDefinitiveAbsence(error)) return 'absent';

    const code = errnoCode(error);
    if (code) unreachableCodes.add(code);
    this.log.debug(
      { bookId: row.id, path: row.path, error: serializeError(error) },
      'Book path unreachable during rescan — status retained',
    );
    return 'unreachable';
  }

  /** Expected-status transitions prevent a stale scan from clobbering a concurrent import. */
  private async reconcileBookPath(
    row: { id: number; path: string | null; status: string; title: string },
    resolvedRoot: string,
    unreachableCodes: Set<string>,
  ): Promise<'skipped' | 'missing' | 'restored' | 'unreachable' | null> {
    if (!row.path) return 'skipped';

    const rel = relative(resolvedRoot, resolve(row.path));
    if (rel.startsWith('..') || isAbsolute(rel)) return 'skipped';

    let probe: 'reachable' | 'absent' | 'unreachable' = 'reachable';
    try {
      await access(row.path);
    } catch (error: unknown) {
      probe = this.classifyProbeFailure({ id: row.id, path: row.path }, error, unreachableCodes);
    }
    if (probe === 'unreachable') return 'unreachable';

    if (row.status === 'imported' && probe === 'absent') {
      const flipped = await transitionBookStatus(this.db, row.id, { status: 'missing', expected: { status: 'imported' } });
      if (flipped) {
        this.log.warn({ bookId: row.id, path: row.path }, 'Book path missing from disk');
        return 'missing';
      }
    } else if (row.status === 'missing' && probe === 'reachable') {
      const flipped = await transitionBookStatus(this.db, row.id, { status: 'imported', expected: { status: 'missing' } });
      if (flipped) {
        this.log.info({ bookId: row.id, path: row.path }, 'Book path restored on disk');
        return 'restored';
      }
    }
    return null;
  }

  async scanDirectory(rootPath: string): Promise<ScanResult> {
    this.log.info({ rootPath }, 'Starting directory scan');

    const folders = await discoverBooks(rootPath, { log: this.log });
    this.log.info({ count: folders.length }, 'Found audio folders');

    const existingPathRows = await this.db
      .select({ id: books.id, path: books.path })
      .from(books);
    const existingPathMap = new Map(
      existingPathRows.filter((r) => r.path != null).map((r) => [r.path!, r.id] as const),
    );

    // Ascending id makes the first pairwise incumbent deterministic.
    const titleAuthorRows = await this.db
      // `path` is selected for the ASIN map's file-holding fact (#2435 AC12), not for matching.
      .select({ id: books.id, title: books.title, slug: authors.slug, asin: books.asin, path: books.path })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .orderBy(books.id);
    // Matching is non-transitive: bucket by the complete `colonBase` retrieval key, then pairwise-filter.
    const existingTitleAuthorBucket = new Map<string, ExistingTitleEntry[]>();
    for (const r of titleAuthorRows) {
      if (!r.title || !r.slug) continue;
      const shape = buildTitleShape(r.title);
      const key = `${shape.colonBase}|${r.slug}`;
      const arr = existingTitleAuthorBucket.get(key) ?? [];
      arr.push({ id: r.id, shape });
      existingTitleAuthorBucket.set(key, arr);
    }
    // ASIN equality is decisive here; normalize case because stored ASINs are not globally canonical.
    // The file-holding fact rides along so the classifier never re-derives it (#2435 AC1).
    const existingAsinMap = new Map<string, AsinMatch>(
      titleAuthorRows
        .filter((r) => r.asin != null)
        .map((r) => [r.asin!.toLowerCase(), { id: r.id, holdsFile: bookHoldsFile(r.path) }] as [string, AsinMatch]),
    );

    const discoveries: DiscoveredBook[] = [];
    const withinScanBucket = new Map<string, WithinScanEntry[]>();

    for (const folder of folders) {
      const parsed = parseFolderStructure(folder.folderParts);
      const authored = Boolean(parsed.title && parsed.author);
      const shape = authored ? buildTitleShape(parsed.title!) : undefined;
      const bucketKey = shape ? `${shape.colonBase}|${slugify(parsed.author!)}` : undefined;

      discoveries.push(this.classifyScannedFolder(folder, parsed, shape, bucketKey, {
        existingPathMap,
        existingAsinMap,
        existingTitleAuthorBucket,
        withinScanBucket,
      }));

      // Register after classification; non-transitive matching requires later rows to see every prior authored row.
      if (shape && bucketKey) {
        const arr = withinScanBucket.get(bucketKey) ?? [];
        arr.push({ shape });
        withinScanBucket.set(bucketKey, arr);
      }
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

  /** Precedence: path, decisive ASIN, existing-library hint, within-scan hint, then normal. */
  private classifyScannedFolder(
    folder: DiscoveredFolder,
    parsed: ReturnType<typeof parseFolderStructure>,
    shape: TitleShape | undefined,
    bucketKey: string | undefined,
    maps: ScanClassificationMaps,
  ): DiscoveredBook {
    const reviewReason = folder.reviewReason;
    const base = [folder.path, parsed, folder.audioFileCount, folder.totalSize] as const;

    if (maps.existingPathMap.has(folder.path)) {
      this.log.debug({ path: folder.path }, 'Duplicate detected (path match)');
      return buildDiscoveredBook(...base, { isDuplicate: true, existingBookId: maps.existingPathMap.get(folder.path), duplicateReason: 'path', reviewReason });
    }

    const asinMatch = parsed.asin ? maps.existingAsinMap.get(parsed.asin.toLowerCase()) : undefined;
    if (asinMatch) {
      // #2435: the ASIN still decides WHICH book this is, but a book holding no file is the record
      // this folder fulfils. Keep it selectable, and keep naming the incumbent so confirm can attach.
      if (!asinMatch.holdsFile) {
        this.log.info({ path: folder.path, asin: parsed.asin, existingBookId: asinMatch.id }, 'Decisive ASIN match on a FILELESS book — importable as an attach');
        return buildDiscoveredBook(...base, { isDuplicate: false, existingBookId: asinMatch.id, reviewReason });
      }
      this.log.debug({ path: folder.path, asin: parsed.asin }, 'Duplicate detected (decisive ASIN match)');
      return buildDiscoveredBook(...base, { isDuplicate: true, existingBookId: asinMatch.id, duplicateReason: 'slug', reviewReason });
    }

    if (shape && bucketKey) {
      // Without a decisive ASIN or narrators, existing-library title matches remain hints.
      const existingMatch = (maps.existingTitleAuthorBucket.get(bucketKey) ?? []).find((e) => titlesMatchForDedup(e.shape, shape));
      if (existingMatch) {
        this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Possible title+author match — deferring recording verdict to match job');
        return buildDiscoveredBook(...base, { isDuplicate: false, existingBookId: existingMatch.id, reviewReason: reviewReason ?? SCAN_RECORDING_REVIEW_HINT });
      }

      // Keep both within-scan folders normal; confirmation has narrators and owns the verdict.
      const withinMatch = (maps.withinScanBucket.get(bucketKey) ?? []).find((e) => titlesMatchForDedup(e.shape, shape));
      if (withinMatch) {
        this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Within-scan title+author match — deferring recording verdict to confirm ladder');
        return buildDiscoveredBook(...base, { isDuplicate: false, reviewReason: reviewReason ?? SCAN_WITHIN_SCAN_REVIEW_HINT });
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
    return buildDiscoveredBook(...base, { isDuplicate: false, reviewReason });
  }

}

export { parseFolderStructure, cleanName, extractYear } from '../utils/folder-parsing.js';

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
