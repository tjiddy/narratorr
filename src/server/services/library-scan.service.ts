import { access } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, authors, bookAuthors } from '../../db/schema.js';
import { eq, inArray, and } from 'drizzle-orm';
import { slugify } from '../../core/utils/parse.js';
import { discoverBooks, type DiscoveredFolder } from '../../core/utils/book-discovery.js';
import { transitionBookStatus } from '../utils/book-status.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { type ImportPipelineDeps } from './import-orchestration.helpers.js';
import { buildDiscoveredBook } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import type { ConnectorImportItem } from '../../core/connectors/index.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { parseFolderStructure } from '../utils/folder-parsing.js';
import { buildTitleShape, titlesMatchForDedup, type TitleShape } from '../../shared/dedup.js';
import type { DiscoveredBook } from '../../shared/schemas/library-scan.js';


export type { DiscoveredBook };

export type ImportMode = 'copy' | 'move';

/**
 * Interim scan-time hint (#1711 F6) for a title+author folder that matches an
 * existing library book but carries no decisive ASIN. Display-only; the match job
 * later replaces it with the authoritative recording verdict once narrators exist.
 */
export const SCAN_RECORDING_REVIEW_HINT = 'Possible match to an existing book — checking recording';

/**
 * Display-only within-scan hint (#1925): the second-and-later folder of a
 * title+author collision *inside one scan* carries this so the user still notices
 * two folders of the same title during triage. Distinct from
 * `SCAN_RECORDING_REVIEW_HINT` (an *existing-library* collision) — a within-scan
 * collision is a different situation and never a decision. Never affects selection,
 * counts, or submission; the recording ladder decides identity at confirm time.
 */
export const SCAN_WITHIN_SCAN_REVIEW_HINT = 'Possible duplicate folder in this scan';

/** An existing-library row in a pairwise dedup bucket (#1891), ordered by `id` asc. */
interface ExistingTitleEntry {
  id: number;
  shape: TitleShape;
}

/**
 * A prior scanned row in a within-scan dedup bucket (#1891), in scan order. Only the
 * title `shape` is retained — the second-and-later row needs nothing but a shape to
 * pairwise-match against for the display hint (#1925); the row's own path is no longer
 * carried, since the first-path field it used to feed was removed (#1925 F6).
 */
interface WithinScanEntry {
  shape: TitleShape;
}

/** In-memory maps/buckets shared across one scan's folder classification (#1891). */
interface ScanClassificationMaps {
  existingPathMap: Map<string, number>;
  existingAsinMap: Map<string, number>;
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
        .select({ id: books.id, path: books.path, status: books.status, title: books.title })
        .from(books)
        .where(inArray(books.status, ['imported', 'missing']));

      let scanned = 0;
      let missing = 0;
      let restored = 0;
      const restoredItems: ConnectorImportItem[] = [];

      for (const row of rows) {
        const outcome = await this.reconcileBookPath(row, resolvedRoot);
        if (outcome === 'skipped') continue;
        scanned++;
        if (outcome === 'missing') missing++;
        else if (outcome === 'restored') {
          restored++;
          // row.path is non-null here: a 'restored' outcome requires an existing path.
          restoredItems.push({ bookId: row.id, title: row.title, libraryPath: row.path! });
        }
      }

      // Fire-and-forget: connector refresh for rows that flipped missing→imported.
      // Never enqueued when there were zero restorations.
      if (this.connectorService && restoredItems.length > 0) {
        fireAndForget(
          this.connectorService.notifyRefresh('restored', restoredItems),
          this.log,
          'Failed to enqueue connector refresh on library rescan',
        );
      }

      this.log.info({ scanned, missing, restored, elapsedMs: Date.now() - startMs }, 'Library rescan complete');
      return { scanned, missing, restored };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Reconcile a single book row's on-disk presence against its persisted status.
   * Returns `'skipped'` for rows outside the library root or with no path (not
   * counted as scanned), `'missing'`/`'restored'` when a guarded transition
   * lands, or `null` when scanned but unchanged. The `expected` guard ensures a
   * concurrent in-flight import (`importing`) is never clobbered by the scan's
   * reconciliation, which read the row status before the import landed.
   */
  private async reconcileBookPath(
    row: { id: number; path: string | null; status: string; title: string },
    resolvedRoot: string,
  ): Promise<'skipped' | 'missing' | 'restored' | null> {
    if (!row.path) return 'skipped';

    // Path ancestry check — skip books outside library root
    const rel = relative(resolvedRoot, resolve(row.path));
    if (rel.startsWith('..') || isAbsolute(rel)) return 'skipped';

    let exists = false;
    try {
      await access(row.path);
      exists = true;
    } catch {
      // path does not exist
    }

    if (row.status === 'imported' && !exists) {
      const flipped = await transitionBookStatus(this.db, row.id, { status: 'missing', expected: { status: 'imported' } });
      if (flipped) {
        this.log.warn({ bookId: row.id, path: row.path }, 'Book path missing from disk');
        return 'missing';
      }
    } else if (row.status === 'missing' && exists) {
      const flipped = await transitionBookStatus(this.db, row.id, { status: 'imported', expected: { status: 'missing' } });
      if (flipped) {
        this.log.info({ bookId: row.id, path: row.path }, 'Book path restored on disk');
        return 'restored';
      }
    }
    return null;
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

    // Pre-fetch all title + author slug pairs (and ASINs) with IDs for O(1) checks.
    // Ordered by books.id so the pairwise bucket below yields the LOWEST matching id
    // first (deterministic existing-library representative, #1891).
    const titleAuthorRows = await this.db
      .select({ id: books.id, title: books.title, slug: authors.slug, asin: books.asin })
      .from(books)
      .leftJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .orderBy(books.id);
    // Bucket existing rows by author slug + `colonBase` (#1891). The predicate is
    // non-transitive so it cannot be a single map key — a bucket + pairwise filter is
    // required. `colonBase` is a COMPLETE retrieval index (equal `fullNormalized` ⟹
    // equal `colonBase`), so both predicate arms are captured, including a
    // `fullNormalized`-only match like `"Dune (Edition: Deluxe)"` ~ `"Dune"`.
    const existingTitleAuthorBucket = new Map<string, ExistingTitleEntry[]>();
    for (const r of titleAuthorRows) {
      if (!r.title || !r.slug) continue;
      const shape = buildTitleShape(r.title);
      const key = `${shape.colonBase}|${r.slug}`;
      const arr = existingTitleAuthorBucket.get(key) ?? [];
      arr.push({ id: r.id, shape });
      existingTitleAuthorBucket.set(key, arr);
    }
    // Decisive-ASIN map (#1711 F6): a parsed-folder ASIN equal to an incumbent's
    // non-null ASIN is `same-recording` deterministically — flag owned at scan and
    // exclude from match. Case-insensitive (ASINs are not globally normalized).
    const existingAsinMap = new Map<string, number>(
      titleAuthorRows
        .filter((r) => r.asin != null)
        .map((r) => [r.asin!.toLowerCase(), r.id] as [string, number]),
    );

    const discoveries: DiscoveredBook[] = [];
    const withinScanBucket = new Map<string, WithinScanEntry[]>();

    for (const folder of folders) {
      const parsed = parseFolderStructure(folder.folderParts);
      // Precompute the title shape / bucket key once for an authored row (both title
      // AND author present). Used by classification (existing/within-scan lookups)
      // and by the registration step below.
      const authored = Boolean(parsed.title && parsed.author);
      const shape = authored ? buildTitleShape(parsed.title!) : undefined;
      const bucketKey = shape ? `${shape.colonBase}|${slugify(parsed.author!)}` : undefined;

      discoveries.push(this.classifyScannedFolder(folder, parsed, shape, bucketKey, {
        existingPathMap,
        existingAsinMap,
        existingTitleAuthorBucket,
        withinScanBucket,
      }));

      // Register EVERY authored parsed row into the within-scan bucket (#1891),
      // regardless of which branch emitted it (path / decisive-ASIN / existing-title /
      // within-scan / normal), AFTER the within-scan lookup above so a row never
      // matches itself. Load-bearing under the non-transitive predicate: a later row
      // can pairwise-match a row that was itself emitted as a within-scan duplicate.
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

  /**
   * Classify a single scanned folder into a `DiscoveredBook` (#1891). Ordered
   * precedence: (1) path match, (2) decisive-ASIN match, (3) existing-library
   * title+author review hint, (4) within-scan title+author collision (#1925 — a
   * NORMAL candidate carrying a display-only hint, NOT a hard flag; recording
   * identity is deferred to the confirm ladder), (5) normal. The title+author branches now bucket by
   * author+`colonBase` and pairwise-filter (the predicate is non-transitive), picking
   * the lowest existing `books.id` (bucket is id-ordered) and the first prior scan row
   * (bucket is scan-ordered). Registration into the within-scan bucket is the caller's
   * job (runs for every authored row, all five branches).
   */
  private classifyScannedFolder(
    folder: DiscoveredFolder,
    parsed: ReturnType<typeof parseFolderStructure>,
    shape: TitleShape | undefined,
    bucketKey: string | undefined,
    maps: ScanClassificationMaps,
  ): DiscoveredBook {
    const reviewReason = folder.reviewReason;
    const base = [folder.path, parsed, folder.audioFileCount, folder.totalSize] as const;

    // (1) Duplicate by path (in-memory Map lookup).
    if (maps.existingPathMap.has(folder.path)) {
      this.log.debug({ path: folder.path }, 'Duplicate detected (path match)');
      return buildDiscoveredBook(...base, { isDuplicate: true, existingBookId: maps.existingPathMap.get(folder.path), duplicateReason: 'path', reviewReason });
    }

    // (2) Decisive ASIN at scan time (#1711 F6): a parsed-folder ASIN equal to an
    // incumbent's non-null ASIN is the same recording deterministically → flag owned
    // now and exclude from the match job, exactly as before.
    if (parsed.asin && maps.existingAsinMap.has(parsed.asin.toLowerCase())) {
      this.log.debug({ path: folder.path, asin: parsed.asin }, 'Duplicate detected (decisive ASIN match)');
      return buildDiscoveredBook(...base, { isDuplicate: true, existingBookId: maps.existingAsinMap.get(parsed.asin.toLowerCase()), duplicateReason: 'slug', reviewReason });
    }

    if (shape && bucketKey) {
      // (3) Existing-library title+author collision, NO decisive ASIN (#1711 F6): NOT
      // a hard duplicate. Library Import has no narrators at scan time, so the
      // same-vs-different-recording verdict cannot be decided here — emit a normal
      // candidate carrying a display-only review hint so it FLOWS THROUGH the match
      // job, where `applyLibraryDuplicate` computes the real 3-way verdict. Owned-book
      // protection is preserved by the post-match and confirm-time `findDuplicate`,
      // both of which run once narrators exist. Lowest matching `books.id` wins
      // (bucket is id-ordered).
      const existingMatch = (maps.existingTitleAuthorBucket.get(bucketKey) ?? []).find((e) => titlesMatchForDedup(e.shape, shape));
      if (existingMatch) {
        this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Possible title+author match — deferring recording verdict to match job');
        return buildDiscoveredBook(...base, { isDuplicate: false, existingBookId: existingMatch.id, reviewReason: reviewReason ?? SCAN_RECORDING_REVIEW_HINT });
      }

      // (4) Within-scan title+author collision (#1925): a prior scan row pairwise-matches.
      // NOT a hard duplicate — scan time has no narrators, so "same recording?" cannot be
      // answered here; deciding it a second time (in disagreement with the confirm-time
      // recording ladder) is exactly the bug. Emit a NORMAL candidate so both folders flow
      // through the match job and the sequential confirm runner decides identity where
      // narrators exist (same-recording → skip, different-recording → edition, unsure →
      // held). Carry a display-only within-scan hint on the second-and-later folder so the
      // user still notices the collision during triage; preserve any upstream reviewReason.
      const withinMatch = (maps.withinScanBucket.get(bucketKey) ?? []).find((e) => titlesMatchForDedup(e.shape, shape));
      if (withinMatch) {
        this.log.debug({ path: folder.path, title: parsed.title, author: parsed.author }, 'Within-scan title+author match — deferring recording verdict to confirm ladder');
        return buildDiscoveredBook(...base, { isDuplicate: false, reviewReason: reviewReason ?? SCAN_WITHIN_SCAN_REVIEW_HINT });
      }
    }

    // (5) Normal candidate.
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
