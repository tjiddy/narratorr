import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename as fsRename, rm, unlink } from 'node:fs/promises';
import { basename, join, normalize, resolve } from 'node:path';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books, bookAuthors, authors } from '../../db/schema.js';
import type { RenameService } from './rename.service.js';
import { RenameError } from './rename.service.js';
import type { TaggingService } from './tagging.service.js';
import { RetagError } from './tagging.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { extname } from 'node:path';
import { toSourceBitrateKbps, logBitrateCapping } from '../utils/audio-bitrate.js';

// ============ Types ============

export type BulkOpType = 'rename' | 'retag' | 'convert';

export interface BulkJobStatus {
  jobId: string;
  type: BulkOpType;
  status: 'running' | 'completed';
  completed: number;
  total: number;
  failures: number;
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

  async countRenameEligible(): Promise<{ mismatched: number; alreadyMatching: number }> {
    const librarySettings = await this.settingsService.get('library');
    const namingOptions = toNamingOptions(librarySettings);

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

    let mismatched = 0;
    let alreadyMatching = 0;
    for (const row of deduped) {
      const targetPath = buildTargetPath(
        librarySettings.path,
        librarySettings.folderFormat,
        row,
        row.authorName ?? null,
        namingOptions,
      );
      // Normalize both paths before comparing (handles backslash separators on Windows imports)
      const normalizedCurrent = normalize(resolve(row.path!.split('\\').join('/')));
      const normalizedTarget = normalize(resolve(targetPath));
      if (normalizedCurrent !== normalizedTarget) {
        mismatched++;
      } else {
        alreadyMatching++;
      }
    }
    return { mismatched, alreadyMatching };
  }

  async countRetagEligible(): Promise<{ total: number }> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(books)
      .where(and(eq(books.status, 'imported'), isNotNull(books.path)));
    return { total: Number(result[0]?.count ?? 0) };
  }

  async countConvertEligible(): Promise<{ total: number }> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(books)
      .where(
        and(
          eq(books.status, 'imported'),
          or(isNull(books.audioFileFormat), sql`LOWER(${books.audioFileFormat}) != 'm4b'`),
        ),
      );
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
    const job = new BulkJob(id, 'rename', this.log, async (setTotal, tick) => {
      // Fetch all imported books with paths + first author for path comparison
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

      // Deduplicate and find only mismatched books
      const seen = new Set<number>();
      const mismatchedIds: number[] = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const targetPath = buildTargetPath(librarySettings.path, librarySettings.folderFormat, row, row.authorName ?? null, renameNamingOptions);
        const normalizedCurrent = normalize(resolve(row.path!.split('\\').join('/')));
        const normalizedTarget = normalize(resolve(targetPath));
        if (normalizedCurrent !== normalizedTarget) {
          mismatchedIds.push(row.id);
        }
      }

      setTotal(mismatchedIds.length);

      for (const bookId of mismatchedIds) {
        try {
          await this.renameService.renameBook(bookId);
        } catch (error: unknown) {
          if (error instanceof RenameError && error.code === 'NO_PATH') {
            tick(false); // skip silently
            continue;
          }
          this.log.warn({ bookId, jobId: id, error }, 'Bulk rename: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    this.jobs.set(id, job);
    this.activeJobId = id;
    job.start();
    this.log.info({ jobId: id }, 'Bulk rename job started');
    return id;
  }

  startRetagJob(): string {
    this.assertNoActiveJob();
    const id = randomUUID();
    const job = new BulkJob(id, 'retag', this.log, async (setTotal, tick) => {
      const rows = await this.db
        .select({ id: books.id })
        .from(books)
        .where(and(eq(books.status, 'imported'), isNotNull(books.path)));

      setTotal(rows.length);

      for (const { id: bookId } of rows) {
        try {
          await this.taggingService.retagBook(bookId);
        } catch (error: unknown) {
          if (error instanceof RetagError && error.code === 'NO_PATH') {
            tick(false); // skip silently
            continue;
          }
          this.log.warn({ bookId, jobId: id, error }, 'Bulk re-tag: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    this.jobs.set(id, job);
    this.activeJobId = id;
    job.start();
    this.log.info({ jobId: id }, 'Bulk re-tag job started');
    return id;
  }

  async startConvertJob(): Promise<string> {
    this.assertNoActiveJob();
    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings.ffmpegPath?.trim()) {
      throw new BulkOpError('ffmpeg not configured', 'FFMPEG_NOT_CONFIGURED');
    }
    const id = randomUUID();
    const job = new BulkJob(id, 'convert', this.log, async (setTotal, tick) => {
      const rows = await this.db
        .select({ id: books.id, path: books.path, title: books.title })
        .from(books)
        .where(
          and(
            eq(books.status, 'imported'),
            or(isNull(books.audioFileFormat), sql`LOWER(${books.audioFileFormat}) != 'm4b'`),
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
          this.log.warn({ bookId: row.id, jobId: id, error }, 'Bulk convert: book failed');
          tick(true); // failure
          continue;
        }
        tick(false); // success
      }
    }, () => this.onJobComplete(id));

    this.jobs.set(id, job);
    this.activeJobId = id;
    job.start();
    this.log.info({ jobId: id }, 'Bulk convert job started');
    return id;
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
    processingSettings: { ffmpegPath: string; outputFormat?: 'm4b' | 'mp3'; bitrate?: number | null },
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
          outputFormat: 'm4b',
          mergeBehavior: 'always',
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

// ============ BulkJob ============

type WorkFn = (setTotal: (n: number) => void, tick: (isFailure: boolean) => void) => Promise<void>;

class BulkJob {
  private _completed = 0;
  private _failures = 0;
  private _total = 0;
  private _status: 'running' | 'completed' = 'running';
  private startMs = Date.now();

  constructor(
    private id: string,
    private type: BulkOpType,
    private log: FastifyBaseLogger,
    private work: WorkFn,
    private onComplete: () => void,
  ) {}

  getStatus(): BulkJobStatus {
    return {
      jobId: this.id,
      type: this.type,
      status: this._status,
      completed: this._completed,
      total: this._total,
      failures: this._failures,
    };
  }

  start(): void {
    this.run().catch(err => {
      this.log.error({ err, jobId: this.id }, 'Bulk job failed unexpectedly');
      this._status = 'completed';
      this.onComplete();
    });
  }

  private async run(): Promise<void> {
    try {
      await this.work(
        (n) => { this._total = n; },
        (isFailure) => {
          this._completed++;
          if (isFailure) this._failures++;
        },
      );
    } finally {
      this._status = 'completed';
      this.log.info(
        { jobId: this.id, type: this.type, total: this._total, failures: this._failures, elapsedMs: Date.now() - this.startMs },
        'Bulk job completed',
      );
      this.onComplete();
    }
  }
}
