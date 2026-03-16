import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, authors } from '../../db/schema.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import { Semaphore } from '../utils/semaphore.js';
import { resolveSavePath } from '../utils/download-path.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import {
  validateSource, checkDiskSpace, copyToLibrary, runAudioProcessing,
  verifyCopy, cleanupOldBookPath, embedTagsForImport,
  runImportPostProcessing, emitImportSuccess, emitImportingStatus,
  notifyImportComplete, recordImportEvent, handleImportFailure,
} from '../utils/import-steps.js';
import type { DownloadRow } from './types.js';

import type { ImportResult, BookRow, AuthorRow } from '../utils/import-helpers.js';
export type { ImportResult } from '../utils/import-helpers.js';

/** Milliseconds per minute — used for seed time calculations. */
const MS_PER_MINUTE = 60_000;

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
    private notifierService?: NotifierService,
    private remotePathMappingService?: RemotePathMappingService,
    private taggingService?: TaggingService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
  ) {}

  /**
   * Import a single completed download into the library.
   * Copies files, updates DB records, optionally removes torrent.
   */
  async importDownload(downloadId: number): Promise<ImportResult> {
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const bookData = await this.getBookWithAuthor(download.bookId);
    if (!bookData) throw new Error(`Book ${download.bookId} not found`);
    const { book, author } = bookData;
    const authorName = author?.name ?? null;

    await this.db.update(downloads).set({ status: 'importing' }).where(eq(downloads.id, downloadId));
    emitImportingStatus({ broadcaster: this.broadcaster, downloadId, book, downloadStatus: download.status as DownloadStatus, log: this.log });

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
      await runAudioProcessing({ processingSettings, librarySettings, targetPath, book, authorName: authorName || 'Unknown Author', db: this.db, log: this.log });

      if (librarySettings.fileFormat) {
        await renameFilesWithTemplate(targetPath, librarySettings.fileFormat, book, authorName, this.log);
      }
      const targetSize = await verifyCopy({ targetPath, sourcePath, processingEnabled });
      await cleanupOldBookPath({ bookPath: book.path, targetPath, log: this.log });

      await this.db.update(books).set({ status: 'imported', path: targetPath, size: targetSize, updatedAt: new Date() }).where(eq(books.id, book.id));
      await enrichBookFromAudio(book.id, targetPath, book, this.db, this.log);

      const taggingSettings = await this.settingsService.get('tagging');
      const processingForTags = await this.settingsService.get('processing');
      await embedTagsForImport({
        taggingService: this.taggingService, taggingEnabled: taggingSettings.enabled,
        ffmpegPath: processingForTags.ffmpegPath, taggingMode: taggingSettings.mode, embedCover: taggingSettings.embedCover,
        bookId: book.id, targetPath, book: { title: book.title, authorName, narrator: book.narrator, seriesName: book.seriesName, seriesPosition: book.seriesPosition, coverUrl: book.coverUrl },
        log: this.log,
      });

      const processingForScript = await this.settingsService.get('processing');
      await runImportPostProcessing({ postProcessingScript: processingForScript.postProcessingScript, postProcessingScriptTimeout: processingForScript.postProcessingScriptTimeout, targetPath, bookTitle: book.title, bookAuthor: authorName, fileCount, bookId: book.id, log: this.log });

      await this.db.update(downloads).set({ status: 'imported' }).where(eq(downloads.id, downloadId));
      this.log.info({ downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize }, 'Import completed successfully');
      emitImportSuccess({ broadcaster: this.broadcaster, downloadId, bookId: book.id, bookTitle: book.title, log: this.log });
      notifyImportComplete({ notifierService: this.notifierService, bookTitle: book.title, authorName, targetPath, fileCount, log: this.log });
      recordImportEvent({ eventHistory: this.eventHistory, bookId: book.id, bookTitle: book.title, authorName, downloadId, bookPath: book.path, targetPath, fileCount, totalSize: targetSize, log: this.log });

      if (importSettings.deleteAfterImport) {
        await this.handleTorrentRemoval(download, importSettings.minSeedTime);
      }
      return { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize };
    } catch (error) {
      // handleImportFailure always rethrows — return satisfies TS control flow
      return handleImportFailure({
        error, targetPath, db: this.db, downloadId, downloadTitle: download.title,
        book, authorName, broadcaster: this.broadcaster, notifierService: this.notifierService,
        eventHistory: this.eventHistory, log: this.log,
      });
    }
  }

  /**
   * Process all completed and queued downloads that are ready for import.
   * Uses semaphore-based parallel admission up to maxConcurrentProcessing.
   */
  async processCompletedDownloads(): Promise<ImportResult[]> {
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
    const importPromises: Promise<ImportResult | null>[] = [];

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

      importPromises.push(
        this.importDownload(download.id)
          .then((result): ImportResult => result)
          .catch((_error): null => {
            this.log.warn({ downloadId: download.id }, 'Skipping failed import, continuing with next');
            return null;
          })
          .finally(() => { this.semaphore.release(); }),
      );
    }

    const settled = await Promise.allSettled(importPromises);
    const results: ImportResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push(outcome.value);
      }
    }
    return results;
  }

  /** Set a download to processing_queued status (for deferred import). */
  async setProcessingQueued(downloadId: number): Promise<void> {
    await this.db.update(downloads).set({ status: 'processing_queued' }).where(eq(downloads.id, downloadId));
  }

  private async getDownload(id: number): Promise<DownloadRow | null> {
    const results = await this.db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
    return results[0] ?? null;
  }

  private async getBookWithAuthor(bookId: number): Promise<{ book: BookRow; author: AuthorRow | undefined } | null> {
    const results = await this.db
      .select({ book: books, author: authors })
      .from(books)
      .leftJoin(authors, eq(books.authorId, authors.id))
      .where(eq(books.id, bookId))
      .limit(1);

    if (results.length === 0) return null;
    return { book: results[0].book, author: results[0].author ?? undefined };
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
    } catch (error) {
      this.log.error({ error, downloadId: download.id }, 'Failed to remove torrent after import');
    }
  }
}
