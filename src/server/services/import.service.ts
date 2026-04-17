import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import { Semaphore } from '../utils/semaphore.js';
import { resolveSavePath } from '../utils/download-path.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import {
  validateSource, checkDiskSpace, copyToLibrary, runAudioProcessing,
  verifyCopy, cleanupOldBookPath, handleImportFailure,
} from '../utils/import-steps.js';
import type { DownloadRow } from './types.js';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';

import type { ImportResult } from '../utils/import-helpers.js';
import { serializeError } from '../utils/serialize-error.js';

export type { ImportResult } from '../utils/import-helpers.js';

/** Lightweight context for orchestrator side-effect dispatch. */
export interface ImportContext {
  downloadId: number;
  downloadTitle: string;
  downloadStatus: string;
  bookId: number;
  bookTitle: string;
  bookStatus: string;
  bookPath: string | null;
  authorName: string | null;
  narratorStr: string | null;
  book: BookWithAuthor;
  infoHash: string | null;
  guid: string | null;
}

export class ImportService {
  private readonly semaphore = new Semaphore(2);

  /** Try to acquire a concurrency slot. Returns true if acquired, false if all slots are taken. */
  tryAcquireSlot(): boolean {
    return this.semaphore.tryAcquire();
  }

  /** Release a previously acquired concurrency slot. */
  releaseSlot(): void {
    this.semaphore.release();
  }

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private remotePathMappingService?: RemotePathMappingService,
    private bookService?: BookService,
  ) {}

  /**
   * Load context for orchestrator side-effect dispatch.
   * Returns download + book + author data needed for SSE, notifications, event recording.
   */
  async getImportContext(downloadId: number): Promise<ImportContext> {
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const book = await this.bookService!.getById(download.bookId);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;
    const narratorNames = book.narrators.map(n => n.name);
    const narratorStr = narratorNames.length > 0 ? narratorNames.join(', ') : null;

    return {
      downloadId,
      downloadTitle: download.title,
      downloadStatus: download.status,
      bookId: book.id,
      bookTitle: book.title,
      bookStatus: book.status,
      bookPath: book.path,
      authorName,
      narratorStr,
      book,
      infoHash: download.infoHash ?? null,
      guid: download.guid ?? null,
    };
  }

  /**
   * Import a single completed download into the library.
   * Core import lifecycle: copies files, updates DB records, enriches from audio, handles torrent removal.
   * Side effects (SSE, notifications, events, tagging, post-processing) are dispatched by the orchestrator.
   */
  async importDownload(downloadId: number): Promise<ImportResult> {
    const startMs = Date.now();
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const book = await this.bookService!.getById(download.bookId);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;

    await this.db.update(downloads).set({ status: 'importing' }).where(eq(downloads.id, downloadId));

    let targetPath: string | undefined;
    try {
      const { resolvedPath: savePath, originalPath } = await resolveSavePath(download, this.downloadClientService, this.remotePathMappingService);
      this.log.debug({ downloadId, bookTitle: book.title, resolvedPath: savePath, originalPath }, 'Resolved save path');
      const [librarySettings, importSettings, processingSettings] = await Promise.all([
        this.settingsService.get('library'),
        this.settingsService.get('import'),
        this.settingsService.get('processing'),
      ]);
      const processingEnabled = !!processingSettings?.enabled;
      const namingOptions = toNamingOptions(librarySettings);
      targetPath = buildTargetPath(librarySettings.path, librarySettings.folderFormat, book, authorName, namingOptions);
      this.log.debug({ downloadId, bookTitle: book.title, targetPath }, 'Built target path');

      const { sourcePath, fileCount, sourceStats } = await validateSource(savePath, this.remotePathMappingService, download.downloadClientId);
      this.log.debug({ downloadId, bookTitle: book.title, fileCount, sourceSize: sourceStats.size }, 'Validated source');
      const diskSpace = await checkDiskSpace({ sourcePath, sourceStats, libraryPath: librarySettings.path, minFreeSpaceGB: importSettings.minFreeSpaceGB, processingEnabled });
      this.log.debug({ downloadId, bookTitle: book.title, freeGB: diskSpace.freeGB, requiredGB: diskSpace.requiredGB }, 'Disk space check passed');
      await copyToLibrary({ sourcePath, targetPath, sourceStats, log: this.log });
      await runAudioProcessing({ processingSettings, librarySettings, targetPath, book: book, authorName: authorName || 'Unknown Author', sourceBitrateBps: book.audioBitrate, namingOptions, db: this.db, log: this.log });

      if (librarySettings.fileFormat) {
        await renameFilesWithTemplate(targetPath, librarySettings.fileFormat, book, authorName, this.log, namingOptions);
      }
      const targetSize = await verifyCopy({ targetPath, sourcePath, processingEnabled });
      this.log.debug({ downloadId, bookTitle: book.title, sourceSize: sourceStats.size, targetSize }, 'Copy verified');
      await cleanupOldBookPath({ bookPath: book.path, targetPath, log: this.log });

      await this.db.transaction(async (tx) => {
        await tx.update(books).set({ status: 'imported', path: targetPath, size: targetSize, lastGrabGuid: download.guid ?? null, lastGrabInfoHash: download.infoHash ?? null, updatedAt: new Date() }).where(eq(books.id, book.id));
        await tx.update(downloads).set({ status: 'imported' }).where(eq(downloads.id, downloadId));
      });

      const ffprobePath = resolveFfprobePathFromSettings(processingSettings?.ffmpegPath);
      await this.enrichAfterImport(book.id, targetPath!, book, ffprobePath);

      this.log.info({ downloadId, bookId: book.id, bookTitle: book.title, targetPath, fileCount, totalSize: targetSize, elapsedMs: Date.now() - startMs }, 'Import completed successfully');

      if (importSettings.deleteAfterImport) {
        await this.handleTorrentRemoval(download, importSettings);
      }
      return { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize };
    } catch (error: unknown) {
      // handleImportFailure does core cleanup (rm files, revert DB) then rethrows.
      // Orchestrator catches the rethrow for failure-path side effects.
      return handleImportFailure({
        error, targetPath, db: this.db, downloadId,
        book, log: this.log, elapsedMs: Date.now() - startMs,
      });
    }
  }

  private async enrichAfterImport(bookId: number, targetPath: string, book: BookWithAuthor, ffprobePath?: string): Promise<void> {
    try {
      const enrichResult = await enrichBookFromAudio(bookId, targetPath, book, this.db, this.log, this.bookService, ffprobePath);
      if (enrichResult && typeof enrichResult === 'object' && 'enriched' in enrichResult && !enrichResult.enriched) {
        this.log.warn({ bookId, error: (enrichResult as { error?: string }).error }, 'Audio enrichment failed — import successful but metadata incomplete');
      }
    } catch (error: unknown) {
      this.log.warn({ bookId, error: serializeError(error) }, 'Audio enrichment threw — import successful but metadata incomplete');
    }
  }

  /**
   * Query eligible downloads and apply semaphore admission.
   * Returns download IDs that acquired a slot. Downloads that couldn't acquire
   * a slot are set to processing_queued.
   */
  async getEligibleDownloads(): Promise<number[]> {
    const processingSettings = await this.settingsService.get('processing');
    this.semaphore.setMax(processingSettings.maxConcurrentProcessing);

    const eligibleDownloads = await this.db
      .select()
      .from(downloads)
      .where(and(
        inArray(downloads.status, ['completed', 'processing_queued']),
        isNotNull(downloads.externalId),
        isNotNull(downloads.completedAt),
      ))
      .orderBy(downloads.completedAt, downloads.id);

    if (eligibleDownloads.length === 0) {
      this.log.trace('No completed downloads to import');
      return [];
    }

    this.log.info({ count: eligibleDownloads.length }, 'Processing completed downloads for import');
    const admitted: number[] = [];

    for (const download of eligibleDownloads) {
      if (!download.bookId) {
        this.log.debug({ id: download.id }, 'Skipping download with no linked book');
        continue;
      }

      if (!this.semaphore.tryAcquire()) {
        if (download.status !== 'processing_queued') {
          await this.db.update(downloads).set({ status: 'processing_queued' }).where(eq(downloads.id, download.id));
        }
        this.log.debug({ downloadId: download.id }, 'Concurrency limit reached, queuing for next tick');
        continue;
      }

      admitted.push(download.id);
    }

    return admitted;
  }

  /** Set a download to processing_queued status (for deferred import). */
  async setProcessingQueued(downloadId: number): Promise<void> {
    await this.db.update(downloads).set({ status: 'processing_queued' }).where(eq(downloads.id, downloadId));
  }

  /** Get the next processing_queued download (oldest first). Returns null if none queued. */
  async getNextQueuedDownload(): Promise<{ id: number; bookId: number } | null> {
    const rows = await this.db
      .select({ id: downloads.id, bookId: downloads.bookId })
      .from(downloads)
      .where(and(
        eq(downloads.status, 'processing_queued'),
        isNotNull(downloads.bookId),
      ))
      .orderBy(downloads.completedAt, downloads.id)
      .limit(1);
    if (!rows[0] || rows[0].bookId === null) return null;
    return { id: rows[0].id, bookId: rows[0].bookId };
  }

  /** Atomically claim a processing_queued download for import. Returns true if claimed. */
  async claimQueuedDownload(downloadId: number): Promise<boolean> {
    const result = await this.db
      .update(downloads)
      .set({ status: 'importing' })
      .where(and(eq(downloads.id, downloadId), eq(downloads.status, 'processing_queued')));
    const rowsAffected = (result as unknown as { rowsAffected?: number }).rowsAffected;
    if (rowsAffected === undefined) {
      this.log.warn({ downloadId }, 'claimQueuedDownload: rowsAffected missing from update result');
      throw new Error(`claimQueuedDownload: rowsAffected missing from update result for download ${downloadId}`);
    }
    return rowsAffected === 1;
  }

  private async getDownload(id: number): Promise<DownloadRow | null> {
    const results = await this.db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
    return results[0] ?? null;
  }

  private async handleTorrentRemoval(download: DownloadRow, importSettings: { minSeedTime: number; minSeedRatio: number }): Promise<void> {
    if (!download.downloadClientId || !download.externalId) return;

    try {
      // Fetch current ratio from download client if ratio gating is enabled
      let currentRatio = 0;
      if (importSettings.minSeedRatio > 0) {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
        if (!liveState) {
          // Cannot determine ratio — defer for retry
          this.log.info({ downloadId: download.id }, 'Skipping torrent removal — cannot fetch current state, deferring');
          await this.db.update(downloads).set({ pendingCleanup: new Date() }).where(eq(downloads.id, download.id));
          return;
        }
        currentRatio = liveState.ratio;
      }

      if (isTorrentRemovalDeferred(download, importSettings, currentRatio)) {
        this.log.info({ downloadId: download.id, currentRatio, minSeedRatio: importSettings.minSeedRatio, minSeedTime: importSettings.minSeedTime }, 'Skipping torrent removal — seed conditions not met, deferring');
        await this.db.update(downloads).set({ pendingCleanup: new Date() }).where(eq(downloads.id, download.id));
        return;
      }

      const client = await this.downloadClientService.getById(download.downloadClientId);
      const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
      if (adapter) {
        await adapter.removeDownload(download.externalId, true);
        this.log.info({ downloadId: download.id, externalId: download.externalId, clientType: client?.type, deleteFiles: true }, 'Torrent removed from client after import');
      }
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed to remove torrent after import');
    }
  }

  /**
   * Re-check imported downloads with pendingCleanup set.
   * Removes torrent from client when seed time + ratio conditions are met, then clears pendingCleanup.
   * Called by the import job on a 60-second schedule.
   */
  async cleanupDeferredImports(): Promise<void> {
    let importSettings: { minSeedTime: number; minSeedRatio: number; deleteAfterImport: boolean };
    try {
      importSettings = await this.settingsService.get('import');
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Failed to read import settings for deferred import cleanup — skipping cycle');
      return;
    }

    if (!importSettings.deleteAfterImport) return;

    const candidates = await this.db.select().from(downloads)
      .where(and(eq(downloads.status, 'imported'), isNotNull(downloads.pendingCleanup)));
    if (candidates.length === 0) return;

    for (const download of candidates) {
      try {
        if (!download.downloadClientId || !download.externalId) continue;

        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
        const currentRatio = liveState?.ratio ?? 0;

        if (isTorrentRemovalDeferred(download, importSettings, currentRatio)) {
          continue; // Still deferred — leave pendingCleanup for next cycle
        }

        if (!adapter) {
          this.log.warn({ downloadId: download.id }, 'Deferred torrent removal skipped — adapter not found, will retry');
          continue;
        }
        const client = await this.downloadClientService.getById(download.downloadClientId);
        await adapter.removeDownload(download.externalId, true);
        this.log.info({ downloadId: download.id, externalId: download.externalId, clientType: client?.type }, 'Deferred torrent removal completed after import');
        await this.db.update(downloads).set({ pendingCleanup: null }).where(eq(downloads.id, download.id));
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed deferred torrent removal — will retry next cycle');
      }
    }
  }
}
