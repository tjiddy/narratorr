import { stat, rm, statfs, mkdir, cp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Stats } from 'node:fs';
import { join, extname, basename, normalize } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { transitionDownloadState } from './download-state.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/index.js';
import { getErrorMessage } from './error-message.js';
import type { TaggingService } from '../services/tagging.service.js';
import { serializeError } from './serialize-error.js';

// Re-export side-effect functions for backwards compatibility
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
  assertCopyVerified, ContentFailureError,
} from './import-helpers.js';
import { runPostProcessingScript } from './post-processing-script.js';
import { revertBookStatus } from './book-status.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from './paths.js';
import { removeImportSibling, removeMarker, markerPresent } from './import-staging.js';

// Staged-import siblings machinery (.import-tmp/.import-bak) lives in import-staging.ts;
// re-exported here so existing importers (import.service.ts, manual path, tests) are unchanged.
export {
  prepareImportSiblings, commitStagedImport, cleanupImportSiblings, stagedAudioReplace, removeImportSibling,
  markerPresent, BackupRecoveryError, findCommitPendingMarkers, sweepCommitPendingMarkers,
  convergeStrandedMarker, assertMarkerPathWritable, MarkerPathConflictError,
} from './import-staging.js';
export type {
  PrepareImportSiblingsArgs, CommitStagedImportArgs, CleanupImportSiblingsArgs, StagedAudioReplaceArgs,
  MarkerSweepResult,
} from './import-staging.js';

// ── isContentFailure ────────────────────────────────────────────────────

/** Cause-chain walk bound — mirrors `serializeError`'s depth-5 cap with cycle detection
 * (`serialize-error.ts`). Caps the wrapped-cause traversal below so a self-referential or
 * pathologically deep chain can't spin. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Classify an import error as content-caused (bad release) or environment-caused (host/config).
 *
 * Classification rides ENTIRELY on the typed `ContentFailureError` (#1346): every content-failure
 * throw site constructs one, so rewording any message can no longer silently break blacklist+retry
 * routing — the failure mode the #1304 family exists to eliminate. The former
 * `CONTENT_FAILURE_PATTERNS` substring fallback was retired here; an environment error whose
 * message happens to contain a former pattern (e.g. `Path not found: .../No audio files found`)
 * no longer mis-classifies.
 *
 * Walks `error.cause` (bounded + cycle-safe, mirroring `serializeError`) so a `ContentFailureError`
 * wrapped via the in-file `new Error(msg, { cause })` pattern still classifies. Non-`Error` values
 * never classify — a JSON-revived plain object that lost its prototype is treated conservatively as
 * environment, not content (the sole production consumer, `ImportOrchestrator`, catches the error
 * live and pre-serialization, so the typed `instanceof` path is always available there).
 */
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

  let fileCount = 0;
  if (sourceStats.isDirectory()) {
    if (!(await containsAudioFiles(savePath))) {
      throw new ContentFailureError(`No audio files found in ${savePath}`);
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
}

export interface DiskSpaceResult {
  freeGB: number;
  requiredGB: number;
}

/** Check that enough disk space is available for the import. */
export async function checkDiskSpace(args: CheckDiskSpaceArgs): Promise<DiskSpaceResult> {
  const { sourcePath, sourceStats, libraryPath, minFreeSpaceGB } = args;
  if (minFreeSpaceGB <= 0) return { freeGB: -1, requiredGB: 0 };

  const sourceSize = sourceStats.isDirectory() ? await getPathSize(sourcePath) : sourceStats.size;
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

// ── copyToLibrary ───────────────────────────────────────────────────────

export interface CopyToLibraryArgs {
  sourcePath: string;
  targetPath: string;
  sourceStats: Stats;
  log: FastifyBaseLogger;
  onProgress?: ((progress: number, byteCounter: { current: number; total: number }) => void) | undefined;
}

/** Copy audio files from source to target library path. */
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

// ── verifyCopy ──────────────────────────────────────────────────────────

export interface VerifyCopyArgs {
  targetPath: string;
  sourcePath: string;
}

/** Verify that copy produced files of expected size. */
export async function verifyCopy(args: VerifyCopyArgs): Promise<number> {
  const { targetPath, sourcePath } = args;
  const targetSize = await getPathSize(targetPath);
  const sourceSize = await getAudioPathSize(sourcePath);
  assertCopyVerified(sourceSize, targetSize);
  return targetSize;
}

// ── cleanupOldBookPath ──────────────────────────────────────────────────

export interface CleanupOldBookPathArgs {
  bookPath: string | null;
  targetPath: string;
  libraryRoot: string;
  log: FastifyBaseLogger;
}

/** Delete old book files when re-importing (book already had a different path). Awaited, nonfatal. */
export async function cleanupOldBookPath(args: CleanupOldBookPathArgs): Promise<void> {
  const { bookPath, targetPath, libraryRoot, log } = args;
  if (!bookPath || normalize(targetPath) === normalize(bookPath)) return;
  try {
    assertPathInsideLibrary(bookPath, libraryRoot);
  } catch (gateError: unknown) {
    if (gateError instanceof PathOutsideLibraryError) {
      log.error({ bookPath, libraryRoot }, 'Refusing to delete old book path outside library root — leaving foreign path untouched');
      return;
    }
    throw gateError;
  }
  try {
    await rm(bookPath, { recursive: true, force: true });
    log.info({ oldPath: bookPath, newPath: targetPath }, 'Deleted old book files during re-import');
  } catch (rmError: unknown) {
    log.warn({ error: serializeError(rmError), oldPath: bookPath }, 'Failed to delete old book files during re-import — continuing');
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
  } catch (tagError: unknown) {
    log.warn({ error: serializeError(tagError), bookId }, 'Tag embedding failed during import — continuing');
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
  } catch (scriptError: unknown) {
    log.warn({ error: serializeError(scriptError), bookId }, 'Post-processing script failed during import — continuing');
  }
}

// ── handleImportFailure ─────────────────────────────────────────────────

export interface HandleImportFailureArgs {
  error: unknown;
  targetPath: string | undefined;
  /** Transient staging sibling (`.import-tmp`) to clean up, if one was created. */
  stagingPath?: string | undefined;
  /** Transient backup sibling (`.import-bak`) to clean up, if one was created. */
  backupPath?: string | undefined;
  /** Library root for the ancestry guard on every destructive cleanup step (#759). */
  libraryRoot?: string | undefined;
  /**
   * True when `targetPath` is the user's pre-existing book folder (a same-path
   * re-import). In that case `commitStagedImport`'s own rollback already restored
   * it, so blanket-removing it here would re-introduce the data loss this guards
   * against — only the transient siblings are cleaned. False (first import /
   * move-path re-import) means `targetPath` is the import's own scratch dir and
   * any partial files it left must be removed.
   */
  protectTarget?: boolean | undefined;
  db: Db;
  downloadId: number;
  book: { id: number; title: string; path: string | null };
  log: FastifyBaseLogger;
  elapsedMs?: number;
}

/** Clean up after a failed import: remove files, revert DB statuses. Rethrows. */
export async function handleImportFailure(args: HandleImportFailureArgs): Promise<never> {
  const { targetPath, stagingPath, backupPath, libraryRoot, protectTarget, log } = args;

  // #1336: preservation rides on the durable disk signal (the commit-pending marker), NOT
  // on the error's identity. A kill-recovery leaves the marker + stranded originals in
  // `.import-bak`; deleting them because the failure reached us as a plain Error (a raw
  // readdir/stat error during recovery, a pre-flight `validateSource`/`checkDiskSpace`
  // throw before recovery even runs, or a `BackupRecoveryError` re-wrapped via
  // `new Error(msg, { cause })`) is the exact #1290 data loss through a different door.
  // While the marker is present, never delete `.import-bak` or the marker; staging is
  // still re-derivable scratch. `markerPresent` fails toward preservation on a stat error.
  const preserveBackup = targetPath ? await markerPresent(targetPath, log) : false;

  // Always clean up the transient staging sibling (guarded, nonfatal).
  if (stagingPath) await removeImportSibling(stagingPath, libraryRoot, log, 'staging');
  if (backupPath && !preserveBackup) await removeImportSibling(backupPath, libraryRoot, log, 'backup');
  if (targetPath && !preserveBackup) await removeMarker(targetPath, libraryRoot, log);

  // Only blanket-remove targetPath when it is NOT a protected pre-existing book
  // folder, and never during a preserved recovery (the half-restored originals live
  // there). `targetPath` is always derived from librarySettings.path via
  // buildTargetPath() at the single call site (import.service.ts) — guarded by
  // libraryRoot when provided (#759).
  if (targetPath && !protectTarget && !preserveBackup) {
    if (libraryRoot) {
      try {
        assertPathInsideLibrary(targetPath, libraryRoot);
      } catch (gateError: unknown) {
        if (gateError instanceof PathOutsideLibraryError) {
          log.error({ targetPath, libraryRoot }, 'Refusing to clean up target path outside library root — leaving foreign path untouched');
          return revertAndRethrow(args);
        }
        throw gateError;
      }
    }
    await rm(targetPath, { recursive: true, force: true })
      .catch((rmError) => log.warn({ error: serializeError(rmError), targetPath }, 'Failed to clean up target path after import failure'));
  }

  return revertAndRethrow(args);
}

/** Revert download + book statuses after a failed import, then rethrow the original error. */
async function revertAndRethrow(args: HandleImportFailureArgs): Promise<never> {
  const { error, db, downloadId, book, log, elapsedMs } = args;

  // Import failure → canonical failure tuple in one guarded UPDATE.
  await transitionDownloadState(db, downloadId, {
    clientStatus: 'failed',
    pipelineStage: 'idle',
    errorMessage: getErrorMessage(error),
  });

  // Recover book status
  const revertStatus = await revertBookStatus(db, book);

  log.error({ error: serializeError(error), downloadId, bookStatus: revertStatus, elapsedMs }, 'Import failed');

  throw error;
}
