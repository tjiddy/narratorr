import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import { Semaphore } from '../utils/semaphore.js';
import { resolveSavePath } from '../utils/download-path.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import {
  validateSource, checkDiskSpace, copyToLibrary, runAudioProcessing,
  verifyCopy, cleanupOldBookPath, handleImportFailure,
} from '../utils/import-steps.js';
import type { DownloadRow } from './types.js';

import type { ImportResult } from '../utils/import-helpers.js';
export type { ImportResult } from '../utils/import-helpers.js';

/** Milliseconds per minute — used for seed time calculations. */
const MS_PER_MINUTE = 60_000;

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
    };
  }

  /**
   * Import a single completed download into the library.
   * Core import lifecycle: copies files, updates DB records, enriches from audio, handles torrent removal.
   * Side effects (SSE, notifications, events, tagging, post-processing) are dispatched by the orchestrator.
   */
  async importDownload(downloadId: number): Promise<ImportResult> {
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const book = await this.bookService!.getById(download.bookId);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;

    await this.db.update(downloads).set({ status: 'importing' }).where(eq(downloads.id, downloadId));

    let targetPath: string | undefined;
    try {
      const savePath = await resolveSavePath(download, this.downloadClientService, this.remotePathMappingService);
      const [librarySettings, importSettings, processingSettings] = await Promise.all([
        this.settingsService.get('library'),
        this.settingsService.get('import'),
        this.settingsService.get('processing'),
      ]);
      const processingEnabled = !!processingSettings?.enabled;
      targetPath = buildTargetPath(librarySettings.path, librarySettings.folderFormat, book, authorName);

      const { sourcePath, fileCount, sourceStats } = await validateSource(savePath, this.remotePathMappingService, download.downloadClientId);
      await checkDiskSpace({ sourcePath, sourceStats, libraryPath: librarySettings.path, minFreeSpaceGB: importSettings.minFreeSpaceGB, processingEnabled });
      await copyToLibrary({ sourcePath, targetPath, sourceStats, log: this.log });
      await runAudioProcessing({ processingSettings, librarySettings, targetPath, book: book, authorName: authorName || 'Unknown Author', db: this.db, log: this.log });

      if (librarySettings.fileFormat) {
        await renameFilesWithTemplate(targetPath, librarySettings.fileFormat, book, authorName, this.log);
      }
      const targetSize = await verifyCopy({ targetPath, sourcePath, processingEnabled });
      await cleanupOldBookPath({ bookPath: book.path, targetPath, log: this.log });

      await this.db.update(books).set({ status: 'imported', path: targetPath, size: targetSize, updatedAt: new Date() }).where(eq(books.id, book.id));
      await enrichBookFromAudio(book.id, targetPath, book, this.db, this.log);

      await this.db.update(downloads).set({ status: 'imported' }).where(eq(downloads.id, downloadId));
      this.log.info({ downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize }, 'Import completed successfully');

      if (importSettings.deleteAfterImport) {
        await this.handleTorrentRemoval(download, importSettings.minSeedTime);
      }
      return { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize };
    } catch (error: unknown) {
      // handleImportFailure does core cleanup (rm files, revert DB) then rethrows.
      // Orchestrator catches the rethrow for failure-path side effects.
      return handleImportFailure({
        error, targetPath, db: this.db, downloadId,
        book, log: this.log,
      });
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
      this.log.debug('No completed downloads to import');
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

  private async getDownload(id: number): Promise<DownloadRow | null> {
    const results = await this.db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
    return results[0] ?? null;
  }

  private async handleTorrentRemoval(download: DownloadRow, minSeedTimeMinutes: number): Promise<void> {
    if (!download.downloadClientId || !download.externalId) return;

    if (download.completedAt && minSeedTimeMinutes > 0) {
      const elapsedMs = Date.now() - download.completedAt.getTime();
      const minSeedMs = minSeedTimeMinutes * MS_PER_MINUTE;
      if (elapsedMs < minSeedMs) {
        this.log.info({ downloadId: download.id, remainingMinutes: Math.ceil((minSeedMs - elapsedMs) / MS_PER_MINUTE) }, 'Skipping torrent removal — min seed time not elapsed');
        return;
      }
    }

    try {
      const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
      if (adapter) {
        await adapter.removeDownload(download.externalId, true);
        this.log.info({ downloadId: download.id }, 'Torrent removed from client after import');
      }
    } catch (error: unknown) {
      this.log.error({ error, downloadId: download.id }, 'Failed to remove torrent after import');
    }
  }
}
