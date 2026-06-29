import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename as fsRename, rm, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books, bookAuthors, authors, narrators, bookNarrators } from '../../db/schema.js';
import type { RenameService } from './rename.service.js';
import { RenameError } from './rename.service.js';
import type { TaggingService } from './tagging.service.js';
import { RetagError } from './tagging.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import { computeFolderTarget, toLibraryRelative } from '../utils/rename-target.js';
import { BulkJob } from './bulk-job.js';
import { runSidecarReconcile } from './bulk-sidecar-reconcile.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { extname } from 'node:path';
import { toSourceBitrateKbps, logBitrateCapping } from '../utils/audio-bitrate.js';
import { serializeError } from '../utils/serialize-error.js';


// ============ Types ============

export type BulkOpType = 'rename' | 'retag' | 'convert' | 'write_metadata_sidecars';

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  failures: number;
}

/** A single mismatched-folder row in the bulk rename preview (library-relative from→to). */
export interface BulkRenamePreviewItem {
  bookId: number;
  title: string;
  from: string;
  to: string;
}

/**
 * Capped mismatch list + global patterns + true totals for the Rename All preview.
 *
 * `folderMatching` means "folder already matches the format" — NOT "book is fully
 * organized". A folder-matching book can still have file-level work when `fileFormat`
 * is set, which is why the job visits all imported books in that case. `importedTotal`
 * is the full imported-book set; `jobTotal` is how many books the run will actually
 * call `renameBook` on (= `importedTotal` when `fileFormat` is set, else the folder
 * mismatch count) — it's the honest progress denominator the modal shows up front.
 */
export interface BulkRenamePreview {
  libraryRoot: string;
  folderFormat: string;
  fileFormat: string;
  items: BulkRenamePreviewItem[];
  mismatchedTotal: number;
  folderMatching: number;
  importedTotal: number;
  jobTotal: number;
}

/** Max preview rows returned by `previewRenameEligible` — totals still reflect the full count. */
export const BULK_RENAME_PREVIEW_CAP = 100;

/** Deduped, narrator-enriched book row used for folder-target computation across count/preview/job. */
interface RenameEligibleRow {
  id: number;
  path: string | null;
  title: string;
  seriesName: string | null;
  seriesPosition: number | null;
  publishedDate: string | null;
  authorName: string | null;
  narrators: Array<{ name: string }>;
}

export class BulkOpError extends Error {
  constructor(
    message: string,
    public code: 'BULK_OP_IN_PROGRESS' | 'FFMPEG_NOT_CONFIGURED' | 'LIBRARY_NOT_CONFIGURED',
  ) {
    super(message);
    this.name = 'BulkOpError';
  }
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes after completion

// ============ Service ============

export class BulkOperationService {
  private jobs = new Map<string, BulkJob>();
  private activeJobId: string | null = null;

  constructor(
    private db: Db,
    private renameService: RenameService,
    private taggingService: TaggingService,
    private settingsService: SettingsService,
    private bookService: BookService,
    private log: FastifyBaseLogger,
  ) {}

  /**
   * Rename preview: the capped from→to folder-mismatch list plus true totals.
   * Pure DB + string work — never touches the filesystem (per-book file diffs and
   * conflict checks stay on the lazy `GET /api/books/:id/rename/preview` path).
   *
   * `jobTotal` is the honest progress denominator: when `fileFormat` is set the job
   * visits every imported book (file-level renames can apply even to folder-matching
   * books), so `jobTotal === importedTotal`; otherwise only folder mismatches are
   * visited and `jobTotal === mismatchedTotal`. Kept in lockstep with the job's
   * `setTotal` in `startRenameJob`.
   */
  async previewRenameEligible(cap = BULK_RENAME_PREVIEW_CAP): Promise<BulkRenamePreview> {
    const librarySettings = await this.settingsService.get('library');
    const namingOptions = toNamingOptions(librarySettings);
    const rows = await this.loadRenameRows();
    const hasFileRule = Boolean(librarySettings.fileFormat);

    const items: BulkRenamePreviewItem[] = [];
    let importedTotal = 0;
    let mismatchedTotal = 0;
    let folderMatching = 0;
    for (const row of rows) {
      if (!row.path) continue; // mirror job NO_PATH skip — never a broken row
      importedTotal++;
      const { targetPath, changed } = computeFolderTarget(
        { ...row, path: row.path },
        row.authorName ?? null,
        librarySettings,
        namingOptions,
      );
      if (!changed) {
        folderMatching++;
        continue;
      }
      mismatchedTotal++;
      if (items.length < cap) {
        items.push({
          bookId: row.id,
          title: row.title,
          from: toLibraryRelative(row.path, librarySettings.path),
          to: toLibraryRelative(targetPath, librarySettings.path),
        });
      }
    }

    return {
      libraryRoot: librarySettings.path,
      folderFormat: librarySettings.folderFormat,
      fileFormat: librarySettings.fileFormat,
      items,
      mismatchedTotal,
      folderMatching,
      importedTotal,
      jobTotal: hasFileRule ? importedTotal : mismatchedTotal,
    };
  }

  /**
   * Load imported books (deduped by bookId, first author) enriched with ordered
   * narrators — the exact metadata `buildTargetPath` needs to render every allowed
   * folder token. Shared by the rename preview and job so both compute targets from
   * the same inputs as `planRename`.
   */
  private async loadRenameRows(): Promise<RenameEligibleRow[]> {
    const rows = await this.db
      .select({
        id: books.id,
        path: books.path,
        title: books.title,
        seriesName: books.seriesName,
        seriesPosition: books.seriesPosition,
        publishedDate: books.publishedDate,
        authorName: authors.name,
      })
      .from(books)
      .leftJoin(bookAuthors, eq(books.id, bookAuthors.bookId))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(and(eq(books.status, 'imported'), isNotNull(books.path)));

    // Deduplicate by bookId — take first author per book (same as renameBook)
    const seen = new Set<number>();
    const deduped: typeof rows = [];
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        deduped.push(row);
      }
    }

    const narratorsByBook = await this.loadNarratorsByBook();
    return deduped.map(row => ({ ...row, narrators: narratorsByBook.get(row.id) ?? [] }));
  }

  /** Ordered narrators (primary first) per imported book, keyed by bookId. */
  private async loadNarratorsByBook(): Promise<Map<number, Array<{ name: string }>>> {
    const rows = await this.db
      .select({
        bookId: bookNarrators.bookId,
        name: narrators.name,
        position: bookNarrators.position,
      })
      .from(bookNarrators)
      .innerJoin(narrators, eq(bookNarrators.narratorId, narrators.id))
      .innerJoin(books, eq(bookNarrators.bookId, books.id))
      .where(and(eq(books.status, 'imported'), isNotNull(books.path)))
      .orderBy(bookNarrators.bookId, bookNarrators.position);

    const map = new Map<number, Array<{ name: string }>>();
    for (const row of rows) {
      const list = map.get(row.bookId) ?? [];
      list.push({ name: row.name });
      map.set(row.bookId, list);
    }
    return map;
  }

  /**
   * The single source of truth for "which books qualify for bulk re-tag":
   * imported books that have a path on disk. Consumed by both `countRetagEligible`
   * (the preview denominator) and `startRetagJob` (the job's `setTotal` / row set)
   * so the modal's "re-tag N books" can never drift from what the job actually
   * touches. Intentionally kept separate from the rename eligibility predicate
   * (`loadRenameRows` / `computeFolderTarget`) — same WHERE today, different question.
   */
  private retagEligibleWhere(): SQL | undefined {
    return and(eq(books.status, 'imported'), isNotNull(books.path));
  }

  async countRetagEligible(): Promise<{ total: number }> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(books)
      .where(this.retagEligibleWhere());
    return { total: Number(result[0]?.count ?? 0) };
  }

  async startRenameJob(): Promise<string> {
    this.assertNoActiveJob();
    const librarySettings = await this.settingsService.get('library');
    const renameNamingOptions = toNamingOptions(librarySettings);
    if (!librarySettings.path?.trim()) {
      throw new BulkOpError('Library path not configured', 'LIBRARY_NOT_CONFIGURED');
    }
    const id = randomUUID();
    const hasFileRule = Boolean(librarySettings.fileFormat);
    const job = new BulkJob(id, 'rename', this.log, async (setTotal, tick) => {
      // Same rows/dedup/target math as the preview — keeps the job's eligibility
      // decision in lockstep with what the modal showed. When a `fileFormat` rule
      // exists, visit EVERY imported book: a folder-matching book can still have
      // file-level renames, and `renameBook` is idempotent ("Already organized"
      // ticks as a silent skip). Without a file rule, file work is impossible, so
      // fall back to the folder-mismatch-only filter.
      const rows = await this.loadRenameRows();
      const targetIds: number[] = [];
      for (const row of rows) {
        if (!row.path) continue;
        if (hasFileRule) {
          targetIds.push(row.id);
          continue;
        }
        const { changed } = computeFolderTarget(
          { ...row, path: row.path },
          row.authorName ?? null,
          librarySettings,
          renameNamingOptions,
        );
        if (changed) targetIds.push(row.id);
      }

      setTotal(targetIds.length);

      for (const bookId of targetIds) {
        try {
          await this.renameService.renameBook(bookId);
        } catch (error: unknown) {
          if (error instanceof RenameError && error.code === 'NO_PATH') {
            tick(false); // skip silently
            continue;
          }
          this.log.warn({ bookId, jobId: id, error: serializeError(error) }, 'Bulk rename: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    return this.launch(id, job, 'Bulk rename job started');
  }

  startRetagJob(): string {
    this.assertNoActiveJob();
    const id = randomUUID();
    const job = new BulkJob(id, 'retag', this.log, async (setTotal, tick) => {
      const rows = await this.db
        .select({ id: books.id })
        .from(books)
        .where(this.retagEligibleWhere());

      setTotal(rows.length);

      for (const { id: bookId } of rows) {
        try {
          await this.taggingService.retagBook(bookId);
        } catch (error: unknown) {
          if (error instanceof RetagError && error.code === 'NO_PATH') {
            tick(false); // skip silently
            continue;
          }
          this.log.warn({ bookId, jobId: id, error: serializeError(error) }, 'Bulk re-tag: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    return this.launch(id, job, 'Bulk re-tag job started');
  }

  /**
   * Library reconcile: (re)write the `metadata.opf` + folder cover sidecar for every imported book
   * with a path, backfilling existing libraries and backstopping any drift. The per-book body and
   * row loop live in `bulk-sidecar-reconcile.ts` (this file is at the line cap). No cancel — the
   * bulk infra is start+poll only. Writes regardless of `tagging.writeOpf` (the button is the opt-in).
   */
  startWriteMetadataSidecarsJob(): string {
    this.assertNoActiveJob();
    const id = randomUUID();
    const reconcileDeps = { db: this.db, bookService: this.bookService, log: this.log, jobId: id, where: this.retagEligibleWhere() };
    const job = new BulkJob(id, 'write_metadata_sidecars', this.log,
      (setTotal, tick) => runSidecarReconcile(reconcileDeps, setTotal, tick),
      () => this.onJobComplete(id));
    return this.launch(id, job, 'Bulk write-metadata-sidecars job started');
  }

  async startConvertJob(): Promise<string> {
    this.assertNoActiveJob();
    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings.ffmpegPath?.trim()) {
      throw new BulkOpError('ffmpeg not configured', 'FFMPEG_NOT_CONFIGURED');
    }
    const targetFormat = processingSettings.outputFormat ?? 'm4b';
    const id = randomUUID();
    const job = new BulkJob(id, 'convert', this.log, async (setTotal, tick) => {
      const rows = await this.db
        .select({ id: books.id, path: books.path, title: books.title })
        .from(books)
        .where(
          and(
            eq(books.status, 'imported'),
            or(isNull(books.audioFileFormat), sql`LOWER(${books.audioFileFormat}) != ${targetFormat}`),
          ),
        );

      setTotal(rows.length);

      for (const row of rows) {
        if (!row.path) {
          tick(false); // skip silently
          continue;
        }
        try {
          await this.convertBook(row.id, row.path, row.title, processingSettings);
        } catch (error: unknown) {
          this.log.warn({ bookId: row.id, jobId: id, error: serializeError(error) }, 'Bulk convert: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    return this.launch(id, job, 'Bulk convert job started');
  }

  getJob(jobId: string): BulkJobStatus | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return job.getStatus();
  }

  getActiveJob(): BulkJobStatus | null {
    if (!this.activeJobId) return null;
    const job = this.jobs.get(this.activeJobId);
    if (!job) return null;
    const status = job.getStatus();
    if (status.status !== 'running') return null;
    return status;
  }

  private assertNoActiveJob(): void {
    if (!this.activeJobId) return;
    const job = this.jobs.get(this.activeJobId);
    if (job && job.getStatus().status === 'running') {
      throw new BulkOpError('A bulk operation is already running', 'BULK_OP_IN_PROGRESS');
    }
    // Completed but not cleared yet (race) — clear it
    this.activeJobId = null;
  }

  /** Move converted output files to the book directory and remove originals that weren't outputs. */
  private async swapConvertedFiles(outputFiles: string[], originalFiles: string[], bookPath: string): Promise<void> {
    if (outputFiles.length === 0) return;
    const outputFileNames = new Set(outputFiles.map(f => basename(f)));
    for (const outputFile of outputFiles) {
      await fsRename(outputFile, join(bookPath, basename(outputFile)));
    }
    for (const file of originalFiles) {
      if (!outputFileNames.has(file)) {
        await unlink(join(bookPath, file)).catch(() => {});
      }
    }
  }

  private async convertBook(
    bookId: number,
    bookPath: string,
    bookTitle: string,
    processingSettings: { ffmpegPath: string; outputFormat?: 'm4b' | 'mp3'; mergeBehavior?: 'always' | 'multi-file-only' | 'never'; bitrate?: number | null },
  ): Promise<void> {
    const stagingDir = bookPath + '.convert-tmp';
    const book = await this.bookService.getById(bookId);
    const authorName = book?.authors?.[0]?.name ?? 'Unknown Author';
    const sourceBitrateKbps = toSourceBitrateKbps(book?.audioBitrate);
    const targetBitrateKbps = processingSettings.bitrate ?? undefined;
    logBitrateCapping(sourceBitrateKbps, targetBitrateKbps, this.log);

    await mkdir(stagingDir, { recursive: true });
    try {
      // Copy audio files to staging
      const entries = await readdir(bookPath);
      const audioFiles = entries.filter(f => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
      for (const file of audioFiles) {
        await cp(join(bookPath, file), join(stagingDir, file));
      }

      const result = await processAudioFiles(
        stagingDir,
        {
          ffmpegPath: processingSettings.ffmpegPath,
          outputFormat: processingSettings.outputFormat ?? 'm4b',
          mergeBehavior: processingSettings.mergeBehavior ?? 'always',
          bitrate: targetBitrateKbps,
          sourceBitrateKbps,
        },
        { author: authorName, title: bookTitle },
      );

      if (!result.success) {
        throw new Error(result.error);
      }
      result.warnings?.forEach(w => this.log.warn({ bookId }, w));

      await this.swapConvertedFiles(result.outputFiles, audioFiles, bookPath);

      // Refresh DB audio fields
      const ffprobePath = resolveFfprobePathFromSettings(processingSettings.ffmpegPath);
      const enrichResult = await enrichBookFromAudio(
        bookId,
        bookPath,
        book ?? { narrators: null, duration: null, coverUrl: null },
        this.db,
        this.log,
        this.bookService,
        ffprobePath,
      );
      if (!enrichResult.enriched) {
        this.log.warn({ bookId }, 'Post-convert enrichment did not enrich — audio fields may be stale');
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Register a freshly-built job as the active one, start it, log, and return its id. */
  private launch(id: string, job: BulkJob, startedMsg: string): string {
    this.jobs.set(id, job);
    this.activeJobId = id;
    job.start();
    this.log.info({ jobId: id }, startedMsg);
    return id;
  }

  private onJobComplete(jobId: string): void {
    if (this.activeJobId === jobId) {
      this.activeJobId = null;
    }
    this.scheduleCleanup(jobId);
  }

  private scheduleCleanup(jobId: string): void {
    setTimeout(() => {
      this.jobs.delete(jobId);
      this.log.debug({ jobId }, 'Bulk job expired and removed');
    }, TTL_MS);
  }
}
