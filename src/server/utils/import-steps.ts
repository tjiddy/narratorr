import { stat, statfs, mkdir, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Stats } from 'node:fs';
import { join, extname, basename, normalize } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { transitionDownloadState } from './download-state.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/index.js';
import { getErrorMessage } from './error-message.js';
import type { TaggingService } from '../services/tagging.service.js';
import { serializeError } from './serialize-error.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';

// Re-export side-effect functions for backwards compatibility.
export {
  emitDownloadImporting, emitBookImporting, emitImportStatusSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
} from './import-side-effects.js';
export type {
  EmitDownloadImportingArgs, EmitBookImportingArgs, EmitImportStatusSuccessArgs,
  EmitImportFailureArgs, NotifyImportCompleteArgs, NotifyImportFailureArgs,
  RecordImportEventArgs, RecordImportFailedEventArgs,
} from './import-side-effects.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import {
  containsAudioFiles, countAudioFiles, copyAudioFiles, getPathSize, getAudioPathSize,
  getVisiblePathSize, assertCopyVerified, ContentFailureError,
} from './import-helpers.js';
import { runPostProcessingScript } from './post-processing-script.js';
import { revertBookStatus } from './book-status.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { assertRealPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import { removeImportSibling, removeMarker, markerPresent } from './import-staging.js';
import { deleteManagedBookFiles } from './delete-managed-files.js';

export {
  prepareImportSiblings, commitStagedImport, cleanupImportSiblings, stagedAudioReplace, removeImportSibling,
  markerPresent, BackupRecoveryError, BackupAmbiguityError,
  assertMarkerPathWritable, MarkerPathConflictError,
} from './import-staging.js';
export type {
  PrepareImportSiblingsArgs, CommitStagedImportArgs, CleanupImportSiblingsArgs, StagedAudioReplaceArgs,
} from './import-staging.js';
export { findCommitPendingMarkers, sweepCommitPendingMarkers, convergeStrandedMarker } from './import-marker-sweep.js';
export type { MarkerSweepResult } from './import-marker-sweep.js';

// Bound cause traversal like serializeError; cycles are rejected separately.
const MAX_CAUSE_DEPTH = 5;

// Content faults are typed, never inferred from message text. Walk bounded, cycle-safe causes
// so wrappers retain classification; serialized plain objects conservatively remain environment faults.
export function isContentFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof ContentFailureError) return true;
    if (!(current instanceof Error) || seen.has(current)) return false;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

export interface ValidateSourceResult {
  sourcePath: string;
  fileCount: number;
  sourceStats: Stats;
}

export async function validateSource(
  savePath: string,
  remotePathMappingService: RemotePathMappingService | undefined,
  downloadClientId: number | null,
): Promise<ValidateSourceResult> {
  let sourceStats: Stats;
  try {
    sourceStats = await stat(savePath);
  } catch (statError: unknown) {
    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
      const hasMapping = remotePathMappingService && downloadClientId
        ? (await remotePathMappingService.getByClientId(downloadClientId)).length > 0
        : false;
      if (hasMapping) {
        throw new Error(`Path not found: ${savePath} (mapped from download client). Check your remote path mapping configuration.`, { cause: statError });
      } else {
        throw new Error(`Path not found: ${savePath}. If the download client runs in Docker or on a remote machine, add a Remote Path Mapping in Settings > Download Clients.`, { cause: statError });
      }
    }
    throw statError;
  }

  // Download-client paths are untrusted; reject hidden file or directory roots before I/O.
  const rootName = basename(savePath);
  if (isHiddenName(rootName)) {
    throw new ContentFailureError(`Source path is hidden (leading dot), not importable: ${rootName}`);
  }

  let fileCount = 0;
  if (sourceStats.isDirectory()) {
    if (!(await containsAudioFiles(savePath))) {
      throw new ContentFailureError(`No audio files found in ${savePath}`);
    }
    fileCount = await countAudioFiles(savePath);
  } else if (sourceStats.isFile()) {
    if (!AUDIO_EXTENSIONS.has(extname(savePath).toLowerCase())) {
      throw new ContentFailureError(`Source file is not a supported audio format: ${rootName}`);
    }
    fileCount = 1;
  }

  return { sourcePath: savePath, fileCount, sourceStats };
}

export interface CheckDiskSpaceArgs {
  sourcePath: string;
  sourceStats: Stats;
  libraryPath: string;
  minFreeSpaceGB: number;
}

export interface DiskSpaceResult {
  freeGB: number;
  requiredGB: number;
}

export async function checkDiskSpace(args: CheckDiskSpaceArgs): Promise<DiskSpaceResult> {
  const { sourcePath, sourceStats, libraryPath, minFreeSpaceGB } = args;
  if (minFreeSpaceGB <= 0) return { freeGB: -1, requiredGB: 0 };

  // Match copyAudioFiles' visible bytes; verification intentionally uses hidden-inclusive target size.
  const sourceSize = sourceStats.isDirectory() ? await getVisiblePathSize(sourcePath) : sourceStats.size;
  const estimatedOutputSize = sourceSize;
  const requiredBytes = minFreeSpaceGB * 1024 ** 3 + estimatedOutputSize;

  let freeBytes: number;
  try {
    const fsStats = await statfs(libraryPath);
    freeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  } catch (statfsError: unknown) {
    throw new Error(`Disk space check failed: ${getErrorMessage(statfsError)}`, { cause: statfsError });
  }

  const freeGB = Math.round((freeBytes / 1024 ** 3) * 10) / 10;
  const requiredGB = Math.round((requiredBytes / 1024 ** 3) * 10) / 10;

  if (freeBytes < requiredBytes) {
    throw new Error(`Import blocked — insufficient disk space (${freeGB.toFixed(1)} GB free, ${requiredGB.toFixed(1)} GB required)`);
  }

  return { freeGB, requiredGB };
}

export interface CopyToLibraryArgs {
  sourcePath: string;
  targetPath: string;
  sourceStats: Stats;
  log: FastifyBaseLogger;
  onProgress?: ((progress: number, byteCounter: { current: number; total: number }) => void) | undefined;
}

export async function copyToLibrary(args: CopyToLibraryArgs): Promise<void> {
  const { sourcePath, targetPath, sourceStats, log, onProgress } = args;
  await mkdir(targetPath, { recursive: true });
  log.info({ source: sourcePath, target: targetPath }, 'Copying files to library');

  if (sourceStats.isDirectory()) {
    await copyAudioFiles(sourcePath, targetPath, onProgress);
    return;
  }

  if (!AUDIO_EXTENSIONS.has(extname(sourcePath).toLowerCase())) {
    throw new ContentFailureError(`Source file is not a supported audio format: ${basename(sourcePath)}`);
  }

  const destPath = join(targetPath, basename(sourcePath));
  if (!onProgress) {
    await cp(sourcePath, destPath, { errorOnExist: false });
    return;
  }

  const totalSize = sourceStats.size;
  let bytesCopied = 0;
  const tracker = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesCopied += chunk.length;
      const progress = totalSize > 0 ? bytesCopied / totalSize : 1;
      onProgress(progress, { current: bytesCopied, total: totalSize });
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(sourcePath), tracker, createWriteStream(destPath));
}

export interface VerifyCopyArgs {
  targetPath: string;
  sourcePath: string;
}

export async function verifyCopy(args: VerifyCopyArgs): Promise<number> {
  const { targetPath, sourcePath } = args;
  const targetSize = await getPathSize(targetPath);
  const sourceSize = await getAudioPathSize(sourcePath);
  assertCopyVerified(sourceSize, targetSize);
  return targetSize;
}

export interface CleanupOldBookPathArgs {
  bookPath: string | null;
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

// Delete managed old-book files on re-import; awaited but nonfatal, foreign files preserved.
export async function cleanupOldBookPath(args: CleanupOldBookPathArgs): Promise<void> {
  const { bookPath, targetPath, libraryRoot, log } = args;
  if (!bookPath || normalize(targetPath) === normalize(bookPath)) return;
  try {
    // Reject in-library symlinks whose real path escapes the root.
    await assertRealPathInsideLibrary(bookPath, libraryRoot);
  } catch (gateError: unknown) {
    if (gateError instanceof PathOutsideLibraryError) {
      log.error({ bookPath, libraryRoot }, 'Refusing to delete old book path outside library root — leaving foreign path untouched');
      return;
    }
    throw gateError;
  }
  try {
    // Containment passed; preserve foreign files and keep cleanup nonfatal.
    const cleanup = await deleteManagedBookFiles(bookPath, libraryRoot, log, { assertInsideLibrary: false });
    log.info(
      { oldPath: bookPath, newPath: targetPath, deleted: cleanup.deletedManaged.length, preservedForeign: cleanup.preservedForeign.length },
      'Cleaned old book managed files during re-import (foreign files preserved)',
    );
  } catch (cleanupError: unknown) {
    log.warn({ error: serializeError(cleanupError), oldPath: bookPath }, 'Failed to clean old book files during re-import — continuing');
  }
}

export interface EmbedTagsArgs {
  taggingService: TaggingService | undefined;
  taggingEnabled: boolean;
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
    asin?: string | null | undefined;
    subtitle?: string | null | undefined;
    description?: string | null | undefined;
    publisher?: string | null | undefined;
    publishedDate?: string | null | undefined;
    genres?: string[] | null | undefined;
    coverUrl: string | null | undefined;
  };
  log: FastifyBaseLogger;
}

export async function embedTagsForImport(args: EmbedTagsArgs): Promise<void> {
  const { taggingService, taggingEnabled, taggingMode, embedCover, bookId, targetPath, book, log } = args;
  if (!taggingService) return;
  if (!taggingEnabled) return;
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    log.debug({ bookId }, 'Tag embedding enabled but ffmpeg not available — skipping');
    return;
  }

  try {
    const tagResult = await taggingService.tagBook(bookId, targetPath, book, ffmpegPath, taggingMode, embedCover);
    log.info(
      { bookId, tagged: tagResult.tagged, skipped: tagResult.skipped, failed: tagResult.failed },
      'Tag embedding during import',
    );
  } catch (tagError: unknown) {
    log.warn({ error: serializeError(tagError), bookId }, 'Tag embedding failed during import — continuing');
  }
}

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
  } catch (scriptError: unknown) {
    log.warn({ error: serializeError(scriptError), bookId }, 'Post-processing script failed during import — continuing');
  }
}

export interface HandleImportFailureArgs {
  error: unknown;
  targetPath: string | undefined;
  stagingPath?: string | undefined;
  backupPath?: string | undefined;
  libraryRoot?: string | undefined;
  /** Preserve a pre-existing same-path target already restored by commit rollback. */
  protectTarget?: boolean | undefined;
  db: Db;
  downloadId: number;
  book: { id: number; title: string; path: string | null };
  /** Pre-grab lifecycle snapshot; absent legacy rows use the conservative fallback. */
  bookStatusAtGrab?: BookStatus | null;
  log: FastifyBaseLogger;
  elapsedMs?: number;
}

// Clean up after a failed import, revert DB statuses, then rethrow.
export async function handleImportFailure(args: HandleImportFailureArgs): Promise<never> {
  const { targetPath, stagingPath, backupPath, libraryRoot, protectTarget, log } = args;

  // The marker, not error identity, is the durable preservation signal. Present or
  // uncertain markers retain backup + marker; staging remains disposable (#1336).
  const preserveBackup = targetPath ? await markerPresent(targetPath, log) : false;

  if (stagingPath) await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
  if (backupPath && !preserveBackup) await removeImportSibling(backupPath, libraryRoot, log, 'backup');
  if (targetPath && !preserveBackup) await removeMarker(targetPath, libraryRoot, log);

  // Never clean a protected pre-existing or half-restored target.
  if (targetPath && !protectTarget && !preserveBackup) {
    if (libraryRoot) {
      try {
        // Reject in-library symlinks whose real path escapes.
        await assertRealPathInsideLibrary(targetPath, libraryRoot);
      } catch (gateError: unknown) {
        if (gateError instanceof PathOutsideLibraryError) {
          log.error({ targetPath, libraryRoot }, 'Refusing to clean up target path outside library root — leaving foreign path untouched');
          return revertAndRethrow(args);
        }
        throw gateError;
      }
      // Containment passed; delete managed files only so foreign files survive.
      await deleteManagedBookFiles(targetPath, libraryRoot, log, { assertInsideLibrary: false })
        .catch((cleanupError) => log.warn({ error: serializeError(cleanupError), targetPath }, 'Failed to clean up target path after import failure'));
    } else {
      // Production assigns libraryRoot before targetPath; only preflight failures omit it.
      log.debug({ targetPath }, 'No library root for target cleanup — skipping blanket managed-file delete');
    }
  }

  return revertAndRethrow(args);
}

async function revertAndRethrow(args: HandleImportFailureArgs): Promise<never> {
  const { error, db, downloadId, book, bookStatusAtGrab, log, elapsedMs } = args;

  await transitionDownloadState(db, downloadId, {
    clientStatus: 'failed',
    pipelineStage: 'idle',
    errorMessage: getErrorMessage(error),
  });

  // Restore the captured pre-grab state; never infer it from paths.
  const revertStatus = await revertBookStatus(db, book, bookStatusAtGrab ?? null);

  log.error({ error: serializeError(error), downloadId, bookStatus: revertStatus, elapsedMs }, 'Import failed');

  throw error;
}
