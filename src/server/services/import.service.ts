/* eslint-disable max-lines -- linear import pipeline with copy, process, rename, tag, enrich steps */
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { mkdir, cp, stat, readdir, rm, statfs } from 'node:fs/promises';
import { join, extname, basename, normalize } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books, authors } from '../../db/schema.js';
import { renderTemplate, toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { applyPathMapping } from '../../core/utils/path-mapping.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { Semaphore } from '../utils/semaphore.js';

type DownloadRow = typeof downloads.$inferSelect;
type BookRow = typeof books.$inferSelect;
type AuthorRow = typeof authors.$inferSelect;

/** Extract a 4-digit year from a date string like "2010-11-02" or "2010". */
function extractYear(publishedDate: string | null | undefined): string | undefined {
  if (!publishedDate) return undefined;
  const match = publishedDate.match(/(\d{4})/);
  return match ? match[1] : undefined;
}

/** Build the target directory from a folder format string and book metadata. */
export function buildTargetPath(
  libraryPath: string,
  folderFormat: string,
  book: {
    title: string;
    seriesName?: string | null;
    seriesPosition?: number | null;
    narrator?: string | null;
    publishedDate?: string | null;
  },
  authorName: string | null,
): string {
  const author = authorName || 'Unknown Author';
  const tokens: Record<string, string | number | undefined> = {
    author,
    authorLastFirst: toLastFirst(author),
    title: book.title,
    titleSort: toSortTitle(book.title),
    series: book.seriesName || undefined,
    seriesPosition: book.seriesPosition ?? undefined,
    narrator: book.narrator || undefined,
    narratorLastFirst: book.narrator ? toLastFirst(book.narrator) : undefined,
    year: extractYear(book.publishedDate),
  };

  const rendered = renderTemplate(folderFormat, tokens);
  return join(libraryPath, ...rendered.split('/'));
}

/** Recursively get total size of a path (file or directory). */
export async function getPathSize(path: string): Promise<number> {
  const stats = await stat(path);
  if (stats.isFile()) return stats.size;

  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isFile()) {
      const s = await stat(entryPath);
      total += s.size;
    } else if (entry.isDirectory()) {
      total += await getPathSize(entryPath);
    }
  }
  return total;
}

/** Check if a path contains audio files (recursively). */
async function containsAudioFiles(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      return true;
    }
    if (entry.isDirectory()) {
      if (await containsAudioFiles(join(dirPath, entry.name))) return true;
    }
  }
  return false;
}

/** Recursively copy only audio files from source to target, preserving directory structure. */
async function copyAudioFiles(source: string, target: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(source, entry.name);
    const destPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyAudioFiles(srcPath, destPath);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      await mkdir(target, { recursive: true });
      await cp(srcPath, destPath, { errorOnExist: false });
    }
  }
}

export interface ImportResult {
  downloadId: number;
  bookId: number;
  targetPath: string;
  fileCount: number;
  totalSize: number;
}

export class ImportService {
  readonly semaphore = new Semaphore(2);

  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private notifierService?: NotifierService,
    private remotePathMappingService?: RemotePathMappingService,
    private taggingService?: TaggingService,
    private eventHistory?: EventHistoryService,
  ) {}

  /**
   * Import a single completed download into the library.
   * Copies files, updates DB records, optionally removes torrent.
   */
  // eslint-disable-next-line complexity, max-lines-per-function -- linear 10-step import pipeline with error recovery and upgrade flow
  async importDownload(downloadId: number): Promise<ImportResult> {
    // 1. Get the download + linked book
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const bookData = await this.getBookWithAuthor(download.bookId);
    if (!bookData) throw new Error(`Book ${download.bookId} not found`);

    const { book, author } = bookData;

    // 2. Mark as importing
    await this.db.update(downloads).set({ status: 'importing' }).where(eq(downloads.id, downloadId));

    let targetPath: string | undefined;
    try {
      // 3. Get save path from download client
      const savePath = await this.resolveSavePath(download);

      // 4. Build target path
      const [librarySettings, importSettings, processingSettings] = await Promise.all([
        this.settingsService.get('library'),
        this.settingsService.get('import'),
        this.settingsService.get('processing'),
      ]);

      targetPath = buildTargetPath(
        librarySettings.path,
        librarySettings.folderFormat,
        book,
        author?.name ?? null,
      );

      // 5. Determine source: could be a single file or a directory
      let sourceStats;
      try {
        sourceStats = await stat(savePath);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
          const hasMapping = this.remotePathMappingService
            ? (await this.remotePathMappingService.getByClientId(download.downloadClientId!)).length > 0
            : false;
          if (hasMapping) {
            throw new Error(`Path not found: ${savePath} (mapped from download client). Check your remote path mapping configuration.`);
          } else {
            throw new Error(`Path not found: ${savePath}. If the download client runs in Docker or on a remote machine, add a Remote Path Mapping in Settings > Download Clients.`);
          }
        }
        throw statError;
      }
      let sourcePath = savePath;
      let fileCount = 0;

      if (sourceStats.isDirectory()) {
        if (!(await containsAudioFiles(savePath))) {
          throw new Error(`No audio files found in ${savePath}`);
        }
        fileCount = await this.countAudioFiles(savePath);
        sourcePath = savePath;
      } else if (sourceStats.isFile()) {
        fileCount = 1;
      }

      // 5b. Disk space check before copy
      if (importSettings.minFreeSpaceGB > 0) {
        const sourceSize = sourceStats.isDirectory() ? await getPathSize(sourcePath) : sourceStats.size;
        const multiplier = processingSettings?.enabled ? 1.5 : 1;
        const estimatedOutputSize = sourceSize * multiplier;
        const requiredBytes = importSettings.minFreeSpaceGB * 1024 ** 3 + estimatedOutputSize;

        let freeBytes: number;
        try {
          const fsStats = await statfs(librarySettings.path);
          freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
        } catch (statfsError) {
          throw new Error(`Disk space check failed: ${statfsError instanceof Error ? statfsError.message : 'unknown error'}`);
        }

        if (freeBytes < requiredBytes) {
          const freeGB = (freeBytes / 1024 ** 3).toFixed(1);
          const requiredGB = (requiredBytes / 1024 ** 3).toFixed(1);
          throw new Error(`Import blocked — insufficient disk space (${freeGB} GB free, ${requiredGB} GB required)`);
        }
      }

      // 6. Create target directory and copy
      await mkdir(targetPath, { recursive: true });
      this.log.info({ source: sourcePath, target: targetPath }, 'Copying files to library');

      if (sourceStats.isDirectory()) {
        await copyAudioFiles(sourcePath, targetPath);
      } else {
        // Single file — only copy if it's an audio file
        if (!AUDIO_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
          throw new Error(`Source file is not a supported audio format: ${basename(sourcePath)}`);
        }
        const targetFile = join(targetPath, basename(sourcePath));
        await cp(sourcePath, targetFile, { errorOnExist: false });
      }

      // 6b. Audio processing (merge/convert) — only for download imports when enabled
      if (processingSettings?.enabled) {
        this.log.info({ targetPath, config: processingSettings }, 'Running audio processing');

        if (processingSettings.outputFormat === 'mp3' && processingSettings.mergeBehavior !== 'never') {
          this.log.warn('MP3 output does not support embedded chapters');
        }

        const authorName = author?.name ?? 'Unknown Author';
        const processingResult = await processAudioFiles(
          targetPath,
          {
            ffmpegPath: processingSettings.ffmpegPath,
            outputFormat: processingSettings.outputFormat,
            bitrate: processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate,
            mergeBehavior: processingSettings.mergeBehavior,
          },
          {
            author: authorName,
            title: book.title,
            fileFormat: librarySettings.fileFormat,
            bookTokens: {
              authorLastFirst: toLastFirst(authorName),
              titleSort: toSortTitle(book.title),
              series: book.seriesName || undefined,
              seriesPosition: book.seriesPosition ?? undefined,
              narrator: book.narrator || undefined,
              narratorLastFirst: book.narrator ? toLastFirst(book.narrator) : undefined,
              year: extractYear(book.publishedDate),
            },
          },
        );

        if (!processingResult.success) {
          // Set book status to 'failed', preserve source files
          await this.db.update(books).set({
            status: 'failed',
            updatedAt: new Date(),
          }).where(eq(books.id, book.id));

          throw new Error(`Audio processing failed: ${processingResult.error}`);
        }

        this.log.info(
          { outputFiles: processingResult.outputFiles.length },
          'Audio processing completed',
        );
      }

      // 6c. Rename files using file format template (after processing, so it applies to final output)
      if (librarySettings.fileFormat) {
        await renameFilesWithTemplate(targetPath, librarySettings.fileFormat, book, author?.name ?? null, this.log);
      }

      // 7. Verify copy (skip when processing ran — merge/convert changes file sizes)
      const targetSize = await getPathSize(targetPath);
      if (!processingSettings?.enabled) {
        const sourceSize = await getPathSize(sourcePath);

        if (targetSize < sourceSize * 0.99) {
          throw new Error(`Copy verification failed: source ${sourceSize} bytes, target ${targetSize} bytes`);
        }
      }

      // 7b. Upgrade: delete old files if book already had a path
      if (book.path && normalize(targetPath) !== normalize(book.path)) {
        try {
          await rm(book.path, { recursive: true, force: true });
          this.log.info({ oldPath: book.path, newPath: targetPath }, 'Deleted old book files during upgrade');
        } catch (rmError) {
          this.log.warn({ error: rmError, oldPath: book.path }, 'Failed to delete old book files during upgrade — continuing');
        }
      }

      // 8. Update book: status='imported', path=targetPath
      await this.db.update(books).set({
        status: 'imported',
        path: targetPath,
        size: targetSize,
        updatedAt: new Date(),
      }).where(eq(books.id, book.id));
      // 8b. File-based audio enrichment
      await enrichBookFromAudio(book.id, targetPath, book, this.db, this.log);

      // 8c. Tag embedding (after enrichment, before notification)
      if (this.taggingService) {
        const taggingSettings = await this.settingsService.get('tagging');
        if (taggingSettings.enabled) {
          const processingSettings = await this.settingsService.get('processing');
          const ffmpegPath = processingSettings.ffmpegPath;
          if (ffmpegPath?.trim()) {
            try {
              const tagResult = await this.taggingService.tagBook(
                book.id,
                targetPath,
                {
                  title: book.title,
                  authorName: author?.name ?? null,
                  narrator: book.narrator,
                  seriesName: book.seriesName,
                  seriesPosition: book.seriesPosition,
                  coverUrl: book.coverUrl,
                },
                ffmpegPath,
                taggingSettings.mode,
                taggingSettings.embedCover,
              );
              this.log.info(
                { bookId: book.id, tagged: tagResult.tagged, skipped: tagResult.skipped, failed: tagResult.failed },
                'Tag embedding during import',
              );
            } catch (tagError) {
              this.log.warn({ error: tagError, bookId: book.id }, 'Tag embedding failed during import — continuing');
            }
          } else {
            this.log.debug({ bookId: book.id }, 'Tag embedding enabled but ffmpeg path not configured — skipping');
          }
        }
      }

      // 9. Update download: status='imported'
      await this.db.update(downloads).set({ status: 'imported' }).where(eq(downloads.id, downloadId));
      this.log.info(
        { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize },
        'Import completed successfully',
      );

      // 9b. Notify on import
      this.notifierService?.notify('on_import', {
        event: 'on_import',
        book: { title: book.title, author: author?.name },
        import: { libraryPath: targetPath, fileCount },
      }).catch((err) => this.log.warn(err, 'Failed to send import notification'));

      // 9c. Record imported/upgraded event (fire-and-forget)
      const isUpgrade = !!book.path;
      this.eventHistory?.create({
        bookId: book.id,
        bookTitle: book.title,
        authorName: author?.name,
        downloadId: downloadId,
        eventType: isUpgrade ? 'upgraded' : 'imported',
        source: 'auto',
        reason: { targetPath, fileCount, totalSize: targetSize },
      }).catch((err) => this.log.warn(err, 'Failed to record import event'));

      // 10. Handle torrent removal
      if (importSettings.deleteAfterImport) {
        await this.handleTorrentRemoval(download, importSettings.minSeedTime);
      }
      return { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize };
    } catch (error) {
      // Clean up copied files to avoid orphaned data on disk
      if (targetPath) {
        await rm(targetPath, { recursive: true, force: true })
          .catch((rmError) => this.log.warn({ error: rmError, targetPath }, 'Failed to clean up target path after import failure'));
      }

      // Revert download to failed so import can be retried
      await this.db.update(downloads).set({
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Import failed',
      }).where(eq(downloads.id, downloadId));

      // Recover book status based on whether it was previously imported
      const revertStatus = book.path ? 'imported' : 'wanted';
      await this.db.update(books).set({
        status: revertStatus,
        updatedAt: new Date(),
      }).where(eq(books.id, book.id));

      this.log.error({ error, downloadId, bookStatus: revertStatus }, 'Import failed');

      // Notify on failure
      this.notifierService?.notify('on_failure', {
        event: 'on_failure',
        book: { title: download.title },
        error: { message: error instanceof Error ? error.message : 'Import failed', stage: 'import' },
      }).catch((err) => this.log.warn(err, 'Failed to send failure notification'));

      // Record import_failed event (fire-and-forget)
      this.eventHistory?.create({
        bookId: book.id,
        bookTitle: book.title,
        authorName: author?.name,
        downloadId: downloadId,
        eventType: 'import_failed',
        source: 'auto',
        reason: { error: error instanceof Error ? error.message : 'Import failed' },
      }).catch((err) => this.log.warn(err, 'Failed to record import_failed event'));

      throw error;
    }
  }

  /**
   * Process all completed and queued downloads that are ready for import.
   * Uses semaphore-based parallel admission up to maxConcurrentProcessing.
   */
  async processCompletedDownloads(): Promise<ImportResult[]> {
    // Read concurrency limit and update semaphore
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
        // No slot available — mark as processing_queued for next tick
        if (download.status !== 'processing_queued') {
          await this.db.update(downloads).set({ status: 'processing_queued' }).where(eq(downloads.id, download.id));
        }
        this.log.debug({ downloadId: download.id }, 'Concurrency limit reached, queuing for next tick');
        continue;
      }

      // Slot acquired — launch import wrapped in finally to release
      importPromises.push(
        this.importDownload(download.id)
          .then((result): ImportResult => result)
          .catch((_error): null => {
            this.log.warn({ downloadId: download.id }, 'Skipping failed import, continuing with next');
            return null;
          })
          .finally(() => {
            this.semaphore.release();
          }),
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

  private async resolveSavePath(download: DownloadRow): Promise<string> {
    if (!download.downloadClientId || !download.externalId) {
      throw new Error(`Download ${download.id} missing client or external ID`);
    }

    const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
    if (!adapter) {
      throw new Error(`Download client ${download.downloadClientId} not found`);
    }

    const item = await adapter.getDownload(download.externalId);
    if (!item) {
      throw new Error(`Download ${download.externalId} not found in client`);
    }

    let fullPath = join(item.savePath, item.name);

    // Apply remote path mapping if configured
    if (this.remotePathMappingService && download.downloadClientId) {
      const mappings = await this.remotePathMappingService.getByClientId(download.downloadClientId);
      if (mappings.length > 0) {
        const mapped = applyPathMapping(fullPath, mappings);
        if (mapped !== fullPath) {
          this.log.info({ original: fullPath, mapped }, 'Applied remote path mapping');
          fullPath = mapped;
        }
      }
    }

    return fullPath;
  }

  private async countAudioFiles(dirPath: string): Promise<number> {
    let count = 0;
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        count++;
      } else if (entry.isDirectory()) {
        count += await this.countAudioFiles(join(dirPath, entry.name));
      }
    }
    return count;
  }

  private async handleTorrentRemoval(download: DownloadRow, minSeedTimeMinutes: number): Promise<void> {
    if (!download.downloadClientId || !download.externalId) return;

    // Check if min seed time has elapsed
    if (download.completedAt && minSeedTimeMinutes > 0) {
      const elapsedMs = Date.now() - download.completedAt.getTime();
      const minSeedMs = minSeedTimeMinutes * 60_000;
      if (elapsedMs < minSeedMs) {
        this.log.info({ downloadId: download.id, remainingMinutes: Math.ceil((minSeedMs - elapsedMs) / 60_000) }, 'Skipping torrent removal — min seed time not elapsed');
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

