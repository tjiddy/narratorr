import { eq, and, isNotNull } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '@db/schema.js';
import { renameFilesWithTemplate } from '../utils/paths.js';
import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import { withBookAdmissionLock } from './book-admission.js';
import { beginRootCommit } from './library-root-gate.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import type { DownloadClientService } from './download-client.service.js';
import type { SettingsService } from './settings.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { BookService, BookWithAuthor } from './book.service.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import { canonicalPath } from '../utils/path-identity.js';
import { resolveSavePath } from '../utils/download-path.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { toNamingOptions } from '@core/utils/naming.js';
import {
  validateSource, checkDiskSpace, prepareImportSiblings, copyToLibrary,
  verifyCopy, commitStagedImport, cleanupOldBookPath, handleImportFailure,
  assertMarkerPathWritable,
} from '../utils/import-steps.js';
import { deriveImportSiblings } from '../utils/import-sibling-paths.js';
import type { DownloadRow } from './types.js';
import { removeOrDeferTorrent, type TorrentRemovalResult } from './torrent-removal.helpers.js';
import { transitionDownloadState, qualityGateEligibleDownloadCondition } from '../utils/download-state.js';
import { transitionBookStatus } from '../utils/book-status.js';
import { deriveDisplayStatus } from '@shared/download-status-registry.js';

import type { ImportResult } from '../utils/import-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ImportJobPhase } from '@shared/schemas/import-job.js';

export type { ImportResult } from '../utils/import-helpers.js';

export interface ImportProgressCallbacks {
  setPhase?: (phase: ImportJobPhase) => Promise<void>;
  emitProgress?: (phase: ImportJobPhase, progress: number, byteCounter?: { current: number; total: number }) => void;
}

async function notifyPhase(callbacks: ImportProgressCallbacks | undefined, phase: ImportJobPhase): Promise<void> {
  if (callbacks?.setPhase) await callbacks.setPhase(phase);
}

function bindCopyProgress(callbacks?: ImportProgressCallbacks) {
  const emit = callbacks?.emitProgress;
  if (!emit) return undefined;
  return (ratio: number, byteCounter: { current: number; total: number }) => emit('copying', ratio, byteCounter);
}

function bindRenameProgress(callbacks?: ImportProgressCallbacks) {
  const emit = callbacks?.emitProgress;
  if (!emit) return undefined;
  return (current: number, total: number) => emit('renaming', total > 0 ? current / total : 1, { current, total });
}

export interface ImportContext {
  downloadId: number;
  downloadTitle: string;
  downloadStatus: DownloadStatus;
  bookId: number;
  bookTitle: string;
  bookStatus: BookStatus;
  /** Durable pre-grab status used for failure rollback. */
  bookStatusAtGrab: BookStatus | null;
  bookPath: string | null;
  authorName: string | null;
  book: BookWithAuthor;
  infoHash: string | null;
  guid: string | null;
}

export class ImportService {
  constructor(
    private db: Db,
    private downloadClientService: DownloadClientService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private remotePathMappingService?: RemotePathMappingService,
    private bookService?: BookService,
  ) {}

  async getImportContext(downloadId: number): Promise<ImportContext> {
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const book = await this.bookService!.getById(download.bookId);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;

    return {
      downloadId,
      downloadTitle: download.title,
      downloadStatus: deriveDisplayStatus(download.clientStatus, download.pipelineStage),
      bookId: book.id,
      bookTitle: book.title,
      bookStatus: book.status,
      bookStatusAtGrab: download.bookStatusAtGrab ?? null,
      bookPath: book.path,
      authorName,
      book,
      infoHash: download.infoHash ?? null,
      guid: download.guid ?? null,
    };
  }

  /**
   * Execute filesystem/DB import; the orchestrator owns external side effects.
   *
   * Download resolution stays outside the lock — it names the book, so it has to run first — and
   * everything the target is derived from runs inside it.
   */
  async importDownload(downloadId: number, callbacks?: ImportProgressCallbacks): Promise<ImportResult> {
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    return withBookAdmissionLock(download.bookId, () =>
      this.importWithinAdmissionLock(downloadId, download, callbacks));
  }

  /**
   * Caller must hold the admission lock for `download.bookId`.
   *
   * The row read, the canonical library root, the naming options, the target, `protectTarget`, the
   * marker preflight and the root-dependent disk-space check all sit inside the section and ahead of
   * the first target mutation. An import that woke behind a rename would otherwise build its target
   * — and prove its free space — against a root or a `book.path` that no longer applies.
   */
  private async importWithinAdmissionLock(
    downloadId: number,
    download: DownloadRow,
    callbacks?: ImportProgressCallbacks,
  ): Promise<ImportResult> {
    const startMs = Date.now();
    // `import.minFreeSpaceGB` is a threshold, not a root, so it is safe to read before registering;
    // the check that consumes it is not, because its `libraryPath` argument is the root.
    const importSettings = await this.settingsService.get('import');
    const rootCommit = await beginRootCommit(this.settingsService);
    try {
      return await this.runImportCommit(downloadId, download, importSettings, rootCommit.library, startMs, callbacks);
    } finally {
      rootCommit.release();
    }
  }

  private async runImportCommit(
    downloadId: number,
    download: DownloadRow,
    importSettings: { minFreeSpaceGB: number; deleteAfterImport: boolean; minSeedTime: number; minSeedRatio: number },
    librarySettings: AppSettings['library'],
    startMs: number,
    callbacks?: ImportProgressCallbacks,
  ): Promise<ImportResult> {
    const book = await this.bookService!.getById(download.bookId!);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;

    await transitionDownloadState(this.db, downloadId, { pipelineStage: 'importing' });

    let targetPath: string | undefined;
    let stagingPath: string | undefined;
    let backupPath: string | undefined;
    let libraryRoot: string | undefined;
    let protectTarget = false;
    try {
      const { resolvedPath: savePath, originalPath } = await resolveSavePath(download, this.downloadClientService, this.remotePathMappingService);
      this.log.debug({ downloadId, bookTitle: book.title, resolvedPath: savePath, originalPath }, 'Resolved save path');
      const namingOptions = toNamingOptions(librarySettings);
      libraryRoot = librarySettings.path;
      targetPath = buildTargetPath(librarySettings.path, librarySettings.folderFormat, book, authorName, namingOptions, book.editionLabel);
      // Same-path re-imports own existing audio and must never be blanket-removed on failure.
      // Compute before marker preflight so collision cleanup already has protection set.
      // `canonicalPath`, not a raw compare: pointer/adopt persists `books.path` verbatim, so the
      // stored spelling can differ from the computed target by trailing separator or separator
      // flavor — and this guard must agree with the claim lock, which keys on the same function.
      protectTarget = book.path != null && canonicalPath(targetPath) === canonicalPath(book.path);
      // Check marker collision before deriving/clearing siblings; an adjacent backup must survive.
      await assertMarkerPathWritable(targetPath);
      // Dot-led scratch prevents concurrent library scans from ingesting partial copies.
      ({ stagingPath, backupPath } = deriveImportSiblings(targetPath));
      this.log.debug({ downloadId, bookTitle: book.title, targetPath, protectTarget }, 'Built target path');

      const { sourcePath, fileCount, sourceStats } = await validateSource(savePath, this.remotePathMappingService, download.downloadClientId);
      this.log.debug({ downloadId, bookTitle: book.title, fileCount, sourceSize: sourceStats.size }, 'Validated source');
      const diskSpace = await checkDiskSpace({ sourcePath, sourceStats, libraryPath: librarySettings.path, minFreeSpaceGB: importSettings.minFreeSpaceGB });
      this.log.debug({ downloadId, bookTitle: book.title, freeGB: diskSpace.freeGB, requiredGB: diskSpace.requiredGB }, 'Disk space check passed');

      // Stage and verify without touching the existing target, so copy failure preserves it.
      await prepareImportSiblings({ targetPath, libraryRoot, log: this.log });
      await notifyPhase(callbacks, 'copying');
      await copyToLibrary({
        sourcePath, targetPath: stagingPath, sourceStats, log: this.log,
        onProgress: bindCopyProgress(callbacks),
      });

      if (librarySettings.fileFormat) {
        await notifyPhase(callbacks, 'renaming');
        await renameFilesWithTemplate(
          stagingPath, librarySettings.fileFormat, book, authorName, this.log, namingOptions,
          bindRenameProgress(callbacks),
        );
      }
      const targetSize = await verifyCopy({ targetPath: stagingPath, sourcePath });
      this.log.debug({ downloadId, bookTitle: book.title, sourceSize: sourceStats.size, targetSize }, 'Copy verified');

      // After verification, backup/swap with rollback so mid-commit cannot leave a partial target.
      await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log: this.log });
      // Later failures must never remove the committed target.
      protectTarget = true;

      await this.db.transaction(async (tx) => {
        // Promote book and pipeline atomically.
        await transitionBookStatus(tx, book.id, { status: 'imported', path: targetPath!, size: targetSize, lastGrabGuid: download.guid ?? null, lastGrabInfoHash: download.infoHash ?? null });
        await transitionDownloadState(tx, downloadId, { pipelineStage: 'imported' });
      });

      // Delete the old folder only after DB commit; otherwise rollback can strand its path.
      await cleanupOldBookPath({ bookPath: book.path, targetPath, libraryRoot: librarySettings.path, log: this.log, db: this.db });

      const ffprobePath = resolveFfprobePathFromSettings(await resolveFfmpegPath());
      await notifyPhase(callbacks, 'fetching_metadata');
      await this.enrichAfterImport(book.id, targetPath!, book, ffprobePath);

      this.log.info({ downloadId, bookId: book.id, bookTitle: book.title, targetPath, fileCount, totalSize: targetSize, elapsedMs: Date.now() - startMs }, 'Import completed successfully');

      if (importSettings.deleteAfterImport) {
        await this.handleTorrentRemoval(download, importSettings);
      }
      return { downloadId, bookId: book.id, targetPath, fileCount, totalSize: targetSize };
    } catch (error: unknown) {
      // Core cleanup rethrows for orchestrator failure side effects.
      return handleImportFailure({
        error, targetPath, stagingPath, backupPath, libraryRoot, protectTarget,
        db: this.db, downloadId, book, bookStatusAtGrab: download.bookStatusAtGrab ?? null,
        log: this.log, elapsedMs: Date.now() - startMs,
      });
    }
  }

  private async enrichAfterImport(bookId: number, targetPath: string, book: BookWithAuthor, ffprobePath?: string): Promise<void> {
    try {
      const enrichResult = await enrichBookFromAudioWithinAdmissionLock(bookId, targetPath, book, this.db, this.log, this.bookService, ffprobePath);
      if (enrichResult && typeof enrichResult === 'object' && 'enriched' in enrichResult && !enrichResult.enriched) {
        this.log.warn({ bookId, error: (enrichResult as { error?: string }).error }, 'Audio enrichment failed — import successful but metadata incomplete');
      }
    } catch (error: unknown) {
      this.log.warn({ bookId, error: serializeError(error) }, 'Audio enrichment threw — import successful but metadata incomplete');
    }
  }

  // Shared quality-gate eligibility prevents drift; completedAt/bookId remain import-specific.
  // This returns queue candidates, not slot admission.
  async getEligibleDownloads(): Promise<Array<{ id: number; bookId: number }>> {
    const eligibleDownloads = await this.db
      .select({ id: downloads.id, bookId: downloads.bookId })
      .from(downloads)
      .where(and(
        qualityGateEligibleDownloadCondition(),
        isNotNull(downloads.completedAt),
        isNotNull(downloads.bookId),
      ))
      .orderBy(downloads.completedAt, downloads.id);

    if (eligibleDownloads.length === 0) {
      this.log.trace('No completed downloads to import');
      return [];
    }

    this.log.info({ count: eligibleDownloads.length }, 'Eligible downloads for import');
    return eligibleDownloads.filter((d): d is { id: number; bookId: number } => d.bookId != null);
  }

  private async getDownload(id: number): Promise<DownloadRow | null> {
    const results = await this.db.select().from(downloads).where(eq(downloads.id, id)).limit(1);
    return results[0] ?? null;
  }

  private async handleTorrentRemoval(download: DownloadRow, importSettings: { minSeedTime: number; minSeedRatio: number }): Promise<void> {
    if (!download.downloadClientId || !download.externalId) return;

    try {
      // Unknown live ratio defers torrents but not usenet, where ratio is meaningless.
      // This stage intentionally leaves outputPath intact.
      const deferOnUnavailableRatio = download.protocol === 'torrent';
      const result = await removeOrDeferTorrent(download, importSettings,
        { downloadClientService: this.downloadClientService, log: this.log },
        { deferOnUnavailableRatio });
      await this.applyImportRemovalResult(download, importSettings, result);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed to remove torrent after import');
    }
  }

  private async applyImportRemovalResult(download: DownloadRow, importSettings: { minSeedTime: number; minSeedRatio: number }, result: TorrentRemovalResult): Promise<void> {
    switch (result.outcome) {
      case 'live-state-unavailable':
        this.log.info({ downloadId: download.id }, 'Skipping torrent removal — cannot fetch current state, deferring');
        await this.db.update(downloads).set({ pendingCleanup: new Date() }).where(eq(downloads.id, download.id));
        return;
      case 'deferred':
        this.log.info({ downloadId: download.id, currentRatio: result.currentRatio, minSeedRatio: importSettings.minSeedRatio, minSeedTime: importSettings.minSeedTime }, 'Skipping torrent removal — seed conditions not met, deferring');
        await this.db.update(downloads).set({ pendingCleanup: new Date() }).where(eq(downloads.id, download.id));
        return;
      case 'removed': {
        const client = await this.downloadClientService.getById(download.downloadClientId!);
        this.log.info({ downloadId: download.id, externalId: download.externalId, clientType: client?.type, deleteFiles: true }, 'Torrent removed from client after import');
        return;
      }
      case 'remove-failed':
        this.log.error({ error: serializeError(result.error), downloadId: download.id }, 'Failed to remove torrent after import');
        return;
      case 'no-adapter':
        return;
    }
  }

  /** Re-check pendingCleanup imports and clear the marker only after torrent removal. */
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
      .where(and(eq(downloads.pipelineStage, 'imported'), isNotNull(downloads.pendingCleanup)));
    if (candidates.length === 0) return;

    for (const download of candidates) {
      try {
        if (!download.downloadClientId || !download.externalId) continue;

        const result = await removeOrDeferTorrent(download, importSettings,
          { downloadClientService: this.downloadClientService, log: this.log },
          { deferOnUnavailableRatio: false });
        await this.applyDeferredImportResult(download, result);
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed deferred torrent removal — will retry next cycle');
      }
    }
  }

  private async applyDeferredImportResult(download: DownloadRow, result: TorrentRemovalResult): Promise<void> {
    switch (result.outcome) {
      case 'no-adapter':
        this.log.warn({ downloadId: download.id }, 'Deferred torrent removal skipped — adapter not found, will retry');
        return;
      case 'remove-failed':
        this.log.error({ error: serializeError(result.error), downloadId: download.id }, 'Failed deferred torrent removal — will retry next cycle');
        return;
      case 'removed': {
        const client = await this.downloadClientService.getById(download.downloadClientId!);
        this.log.info({ downloadId: download.id, externalId: download.externalId, clientType: client?.type }, 'Deferred torrent removal completed after import');
        await this.db.update(downloads).set({ pendingCleanup: null }).where(eq(downloads.id, download.id));
        return;
      }
      // Both outcomes retain pendingCleanup; live-state-unavailable is unreachable with this policy.
      case 'deferred':
      case 'live-state-unavailable':
        return;
    }
  }
}
