import { stat, rm, statfs, mkdir, cp } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join, extname, basename, normalize } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { downloads, books } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { toLastFirst, toSortTitle, AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import type { TaggingService } from '../services/tagging.service.js';

// Re-export side-effect functions for backwards compatibility
export {
  emitDownloadImporting, emitBookImporting, emitImportSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
} from './import-side-effects.js';
export type {
  EmitDownloadImportingArgs, EmitBookImportingArgs, EmitImportSuccessArgs,
  EmitImportFailureArgs, NotifyImportCompleteArgs, NotifyImportFailureArgs,
  RecordImportEventArgs, RecordImportFailedEventArgs,
} from './import-side-effects.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import {
  containsAudioFiles, countAudioFiles, copyAudioFiles, getPathSize,
  extractYear, COPY_VERIFICATION_THRESHOLD,
} from './import-helpers.js';
import { runPostProcessingScript } from './post-processing-script.js';
import { revertBookStatus } from './book-status.js';

// ── validateSource ──────────────────────────────────────────────────────

export interface ValidateSourceResult {
  sourcePath: string;
  fileCount: number;
  sourceStats: Stats;
}

/** Validate the source path exists and contains audio files. */
export async function validateSource(
  savePath: string,
  remotePathMappingService: RemotePathMappingService | undefined,
  downloadClientId: number | null,
): Promise<ValidateSourceResult> {
  let sourceStats: Stats;
  try {
    sourceStats = await stat(savePath);
  } catch (statError) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
      const hasMapping = remotePathMappingService && downloadClientId
        ? (await remotePathMappingService.getByClientId(downloadClientId)).length > 0
        : false;
      if (hasMapping) {
        throw new Error(`Path not found: ${savePath} (mapped from download client). Check your remote path mapping configuration.`);
      } else {
        throw new Error(`Path not found: ${savePath}. If the download client runs in Docker or on a remote machine, add a Remote Path Mapping in Settings > Download Clients.`);
      }
    }
    throw statError;
  }

  let fileCount = 0;
  if (sourceStats.isDirectory()) {
    if (!(await containsAudioFiles(savePath))) {
      throw new Error(`No audio files found in ${savePath}`);
    }
    fileCount = await countAudioFiles(savePath);
  } else if (sourceStats.isFile()) {
    fileCount = 1;
  }

  return { sourcePath: savePath, fileCount, sourceStats };
}

// ── checkDiskSpace ──────────────────────────────────────────────────────

export interface CheckDiskSpaceArgs {
  sourcePath: string;
  sourceStats: Stats;
  libraryPath: string;
  minFreeSpaceGB: number;
  processingEnabled: boolean;
}

/** Check that enough disk space is available for the import. */
export async function checkDiskSpace(args: CheckDiskSpaceArgs): Promise<void> {
  const { sourcePath, sourceStats, libraryPath, minFreeSpaceGB, processingEnabled } = args;
  if (minFreeSpaceGB <= 0) return;

  const sourceSize = sourceStats.isDirectory() ? await getPathSize(sourcePath) : sourceStats.size;
  const multiplier = processingEnabled ? 1.5 : 1;
  const estimatedOutputSize = sourceSize * multiplier;
  const requiredBytes = minFreeSpaceGB * 1024 ** 3 + estimatedOutputSize;

  let freeBytes: number;
  try {
    const fsStats = await statfs(libraryPath);
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

// ── copyToLibrary ───────────────────────────────────────────────────────

export interface CopyToLibraryArgs {
  sourcePath: string;
  targetPath: string;
  sourceStats: Stats;
  log: FastifyBaseLogger;
}

/** Copy audio files from source to target library path. */
export async function copyToLibrary(args: CopyToLibraryArgs): Promise<void> {
  const { sourcePath, targetPath, sourceStats, log } = args;
  await mkdir(targetPath, { recursive: true });
  log.info({ source: sourcePath, target: targetPath }, 'Copying files to library');

  if (sourceStats.isDirectory()) {
    await copyAudioFiles(sourcePath, targetPath);
  } else {
    if (!AUDIO_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
      throw new Error(`Source file is not a supported audio format: ${basename(sourcePath)}`);
    }
    await cp(sourcePath, join(targetPath, basename(sourcePath)), { errorOnExist: false });
  }
}

// ── runAudioProcessing ──────────────────────────────────────────────────

export interface RunAudioProcessingArgs {
  processingSettings: {
    enabled?: boolean;
    ffmpegPath: string;
    outputFormat: 'm4b' | 'mp3';
    keepOriginalBitrate: boolean;
    bitrate: number;
    mergeBehavior: 'always' | 'multi-file-only' | 'never';
  };
  librarySettings: { fileFormat: string };
  targetPath: string;
  book: {
    id: number;
    title: string;
    seriesName: string | null;
    seriesPosition: number | null;
    narrator: string | null;
    publishedDate: string | null;
  };
  authorName: string;
  db: Db;
  log: FastifyBaseLogger;
}

/** Run audio processing (merge/convert) on imported files. Throws on failure. */
export async function runAudioProcessing(args: RunAudioProcessingArgs): Promise<void> {
  const { processingSettings, librarySettings, targetPath, book, authorName, db, log } = args;
  if (!processingSettings?.enabled) return;

  log.info({ targetPath, config: processingSettings }, 'Running audio processing');
  if (processingSettings.outputFormat === 'mp3' && processingSettings.mergeBehavior !== 'never') {
    log.warn('MP3 output does not support embedded chapters');
  }

  const processingResult = await processAudioFiles(targetPath, {
    ffmpegPath: processingSettings.ffmpegPath,
    outputFormat: processingSettings.outputFormat,
    bitrate: processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate,
    mergeBehavior: processingSettings.mergeBehavior,
  }, {
    author: authorName, title: book.title, fileFormat: librarySettings.fileFormat,
    bookTokens: {
      authorLastFirst: toLastFirst(authorName), titleSort: toSortTitle(book.title),
      series: book.seriesName || undefined, seriesPosition: book.seriesPosition ?? undefined,
      narrator: book.narrator || undefined,
      narratorLastFirst: book.narrator ? toLastFirst(book.narrator) : undefined,
      year: extractYear(book.publishedDate),
    },
  });

  if (!processingResult.success) {
    await db.update(books).set({ status: 'failed', updatedAt: new Date() }).where(eq(books.id, book.id));
    throw new Error(`Audio processing failed: ${processingResult.error}`);
  }
  log.info({ outputFiles: processingResult.outputFiles.length }, 'Audio processing completed');
}

// ── verifyCopy ──────────────────────────────────────────────────────────

export interface VerifyCopyArgs {
  targetPath: string;
  sourcePath: string;
  processingEnabled: boolean;
}

/** Verify that copy produced files of expected size (skip if processing changed sizes). */
export async function verifyCopy(args: VerifyCopyArgs): Promise<number> {
  const { targetPath, sourcePath, processingEnabled } = args;
  const targetSize = await getPathSize(targetPath);
  if (!processingEnabled) {
    const sourceSize = await getPathSize(sourcePath);
    if (targetSize < sourceSize * COPY_VERIFICATION_THRESHOLD) {
      throw new Error(`Copy verification failed: source ${sourceSize} bytes, target ${targetSize} bytes`);
    }
  }
  return targetSize;
}

// ── cleanupOldBookPath ──────────────────────────────────────────────────

export interface CleanupOldBookPathArgs {
  bookPath: string | null;
  targetPath: string;
  log: FastifyBaseLogger;
}

/** Delete old book files when upgrading (book already had a different path). Awaited, nonfatal. */
export async function cleanupOldBookPath(args: CleanupOldBookPathArgs): Promise<void> {
  const { bookPath, targetPath, log } = args;
  if (!bookPath || normalize(targetPath) === normalize(bookPath)) return;
  try {
    await rm(bookPath, { recursive: true, force: true });
    log.info({ oldPath: bookPath, newPath: targetPath }, 'Deleted old book files during upgrade');
  } catch (rmError) {
    log.warn({ error: rmError, oldPath: bookPath }, 'Failed to delete old book files during upgrade — continuing');
  }
}

// ── embedTagsForImport ──────────────────────────────────────────────────

export interface EmbedTagsArgs {
  taggingService: TaggingService | undefined;
  taggingEnabled: boolean;
  ffmpegPath: string;
  taggingMode: 'populate_missing' | 'overwrite';
  embedCover: boolean;
  bookId: number;
  targetPath: string;
  book: {
    title: string;
    authorName: string | null;
    narrator: string | null | undefined;
    seriesName: string | null | undefined;
    seriesPosition: number | null | undefined;
    coverUrl: string | null | undefined;
  };
  log: FastifyBaseLogger;
}

/** Embed audio tags into imported files. Awaited but nonfatal. */
export async function embedTagsForImport(args: EmbedTagsArgs): Promise<void> {
  const { taggingService, taggingEnabled, ffmpegPath, taggingMode, embedCover, bookId, targetPath, book, log } = args;
  if (!taggingService) return;
  if (!taggingEnabled) return;
  if (!ffmpegPath?.trim()) {
    log.debug({ bookId }, 'Tag embedding enabled but ffmpeg path not configured — skipping');
    return;
  }

  try {
    const tagResult = await taggingService.tagBook(bookId, targetPath, book, ffmpegPath, taggingMode, embedCover);
    log.info(
      { bookId, tagged: tagResult.tagged, skipped: tagResult.skipped, failed: tagResult.failed },
      'Tag embedding during import',
    );
  } catch (tagError) {
    log.warn({ error: tagError, bookId }, 'Tag embedding failed during import — continuing');
  }
}

// ── runImportPostProcessing ─────────────────────────────────────────────

export interface RunImportPostProcessingArgs {
  postProcessingScript: string | null | undefined;
  postProcessingScriptTimeout: number | null | undefined;
  targetPath: string;
  bookTitle: string;
  bookAuthor: string | null;
  fileCount: number;
  bookId: number;
  log: FastifyBaseLogger;
}

/** Run a post-processing script hook. Awaited but nonfatal. */
export async function runImportPostProcessing(args: RunImportPostProcessingArgs): Promise<void> {
  const { postProcessingScript, postProcessingScriptTimeout, targetPath, bookTitle, bookAuthor, fileCount, bookId, log } = args;
  if (!postProcessingScript?.trim()) return;

  try {
    await runPostProcessingScript({
      scriptPath: postProcessingScript,
      timeoutSeconds: postProcessingScriptTimeout ?? 300,
      audiobookPath: targetPath,
      bookTitle,
      bookAuthor,
      fileCount,
      log,
    });
  } catch (scriptError) {
    log.warn({ error: scriptError, bookId }, 'Post-processing script failed during import — continuing');
  }
}

// ── handleImportFailure ─────────────────────────────────────────────────

export interface HandleImportFailureArgs {
  error: unknown;
  targetPath: string | undefined;
  db: Db;
  downloadId: number;
  book: { id: number; title: string; path: string | null };
  log: FastifyBaseLogger;
}

/** Clean up after a failed import: remove files, revert DB statuses. Rethrows. */
export async function handleImportFailure(args: HandleImportFailureArgs): Promise<never> {
  const { error, targetPath, db, downloadId, book, log } = args;

  // Clean up copied files
  if (targetPath) {
    await rm(targetPath, { recursive: true, force: true })
      .catch((rmError) => log.warn({ error: rmError, targetPath }, 'Failed to clean up target path after import failure'));
  }

  // Revert download to failed
  await db.update(downloads).set({
    status: 'failed',
    errorMessage: error instanceof Error ? error.message : 'Import failed',
  }).where(eq(downloads.id, downloadId));

  // Recover book status
  const revertStatus = await revertBookStatus(db, book);

  log.error({ error, downloadId, bookStatus: revertStatus }, 'Import failed');

  throw error;
}
