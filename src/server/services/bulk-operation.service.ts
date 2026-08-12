import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books, bookAuthors, authors, narrators, bookNarrators } from '@db/schema.js';
import type { RenameService } from './rename.service.js';
import { RenameError } from './rename.service.js';
import type { TaggingService } from './tagging.service.js';
import { RetagError } from './tagging.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import type { ConnectorService } from './connector.service.js';
import { enqueueRetagRefresh } from '../utils/enqueue-book-refresh.js';
import { computeFolderTarget, toLibraryRelative } from '../utils/rename-target.js';
import { BulkJob } from './bulk-job.js';
import { toShortErrorText } from '../utils/short-error-text.js';
import { runSidecarReconcile } from './bulk-sidecar-reconcile.js';
import { triggerCompanionSweep, type CompanionSweepTrigger } from './companion-ebook-trigger.js';
import { toNamingOptions } from '@core/utils/naming.js';
import { serializeError } from '../utils/serialize-error.js';


// Canonical shared type; re-export preserves the existing server import path.
import type { BulkJobStatus } from '@shared/bulk-operation-types.js';

export type { BulkOpType, BulkJobStatus } from '@shared/bulk-operation-types.js';

export interface BulkRenamePreviewItem {
  bookId: number;
  title: string;
  from: string;
  to: string;
}

// folderMatching covers only folders; file rules may still require work.
// jobTotal is all imported books with a file rule, otherwise only folder mismatches.
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

interface RenameEligibleRow {
  id: number;
  path: string | null;
  title: string;
  seriesName: string | null;
  seriesPosition: number | null;
  publishedDate: string | null;
  editionLabel: string | null;
  authorName: string | null;
  narrators: Array<{ name: string }>;
}

export class BulkOpError extends Error {
  constructor(
    message: string,
    public code: 'BULK_OP_IN_PROGRESS' | 'LIBRARY_NOT_CONFIGURED',
  ) {
    super(message);
    this.name = 'BulkOpError';
  }
}

const TTL_MS = 10 * 60 * 1000;

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
    private connectorService?: ConnectorService,
    private companionEbook?: CompanionSweepTrigger,
  ) {}

  // Preview is DB/string-only; per-book filesystem conflicts stay on the lazy route.
  // Keep jobTotal in lockstep with startRenameJob's setTotal.
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
      if (!row.path) continue;
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

  // Preview and job must compute targets from the same first-author/ordered-narrator rows.
  private async loadRenameRows(): Promise<RenameEligibleRow[]> {
    const rows = await this.db
      .select({
        id: books.id,
        path: books.path,
        title: books.title,
        seriesName: books.seriesName,
        seriesPosition: books.seriesPosition,
        publishedDate: books.publishedDate,
        editionLabel: books.editionLabel,
        authorName: authors.name,
      })
      .from(books)
      .leftJoin(bookAuthors, eq(books.id, bookAuthors.bookId))
      .leftJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(and(eq(books.status, 'imported'), isNotNull(books.path)));

    // Match renameBook's first-author choice.
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

  // Shared retag predicate keeps preview count and job rows aligned.
  // Keep it separate from rename eligibility even while their SQL happens to match.
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
      // With a file rule visit every imported book; otherwise only folder mismatches.
      // This selection must match preview jobTotal.
      const rows = await this.loadRenameRows();
      // Retain titles so failure records can name books.
      const targets: Array<{ id: number; title: string }> = [];
      for (const row of rows) {
        if (!row.path) continue;
        if (hasFileRule) {
          targets.push({ id: row.id, title: row.title });
          continue;
        }
        const { changed } = computeFolderTarget(
          { ...row, path: row.path },
          row.authorName ?? null,
          librarySettings,
          renameNamingOptions,
        );
        if (changed) targets.push({ id: row.id, title: row.title });
      }

      setTotal(targets.length);

      for (const { id: bookId, title } of targets) {
        try {
          await this.renameService.renameBook(bookId);
        } catch (error: unknown) {
          if (error instanceof RenameError && error.code === 'NO_PATH') {
            tick(false);
            continue;
          }
          this.log.warn({ bookId, jobId: id, error: serializeError(error) }, 'Bulk rename: book failed');
          tick(true, { bookId, title, error: toShortErrorText(error) });
          continue;
        }
        tick(false);
      }

      // Run one coalesced sweep after the loop, even with failures; per-book runs would fan out.
      // Skip an empty target set.
      if (targets.length > 0) {
        triggerCompanionSweep(this.companionEbook, this.log, 'Companion ebook sweep failed after bulk rename');
      }
    }, () => this.onJobComplete(id));

    return this.launch(id, job, 'Bulk rename job started');
  }

  startRetagJob(): string {
    this.assertNoActiveJob();
    const id = randomUUID();
    const job = new BulkJob(id, 'retag', this.log, async (setTotal, tick) => {
      // Retain titles so failure records can name books.
      const rows = await this.db
        .select({ id: books.id, title: books.title })
        .from(books)
        .where(this.retagEligibleWhere());

      setTotal(rows.length);

      for (const { id: bookId, title } of rows) {
        try {
          const result = await this.taggingService.retagBook(bookId);
          // Refresh from the pre-mutation item captured before in-place tag rewriting.
          enqueueRetagRefresh(this.connectorService, this.log, result);
        } catch (error: unknown) {
          if (error instanceof RetagError && error.code === 'NO_PATH') {
            tick(false);
            continue;
          }
          this.log.warn({ bookId, jobId: id, error: serializeError(error) }, 'Bulk re-tag: book failed');
          tick(true, { bookId, title, error: toShortErrorText(error) });
          continue;
        }
        tick(false);
      }
    }, () => this.onJobComplete(id));

    return this.launch(id, job, 'Bulk re-tag job started');
  }

  // Explicit bulk opt-in rewrites sidecars regardless of tagging.writeOpf; the helper owns the loop.
  startWriteMetadataSidecarsJob(): string {
    this.assertNoActiveJob();
    const id = randomUUID();
    const reconcileDeps = { db: this.db, bookService: this.bookService, log: this.log, jobId: id, where: this.retagEligibleWhere(), connectorService: this.connectorService };
    const job = new BulkJob(id, 'write_metadata_sidecars', this.log,
      (setTotal, tick) => runSidecarReconcile(reconcileDeps, setTotal, tick),
      () => this.onJobComplete(id));
    return this.launch(id, job, 'Bulk write-metadata-sidecars job started');
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
    // Completion callback may not have cleared this race yet.
    this.activeJobId = null;
  }

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
