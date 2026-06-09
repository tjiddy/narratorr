import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { normalize } from 'node:path';
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
import type { BookStatus } from '../../shared/schemas/book.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import { resolveSavePath } from '../utils/download-path.js';
import { buildTargetPath } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import {
  validateSource, checkDiskSpace, prepareImportSiblings, copyToLibrary,
  verifyCopy, commitStagedImport, cleanupOldBookPath, handleImportFailure,
} from '../utils/import-steps.js';
import type { DownloadRow } from './types.js';
import { removeOrDeferTorrent, type TorrentRemovalResult } from './torrent-removal.helpers.js';

import type { ImportResult } from '../utils/import-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ImportJobPhase } from '../../shared/schemas/import-job.js';

export type { ImportResult } from '../utils/import-helpers.js';

/** Optional phase/progress callbacks threaded from the adapter through the orchestrator. */
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

/** Lightweight context for orchestrator side-effect dispatch. */
export interface ImportContext {
  downloadId: number;
  downloadTitle: string;
  downloadStatus: DownloadStatus;
  bookId: number;
  bookTitle: string;
  bookStatus: BookStatus;
  bookPath: string | null;
  authorName: string | null;
  narratorStr: string | null;
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
  async importDownload(downloadId: number, callbacks?: ImportProgressCallbacks): Promise<ImportResult> {
    const startMs = Date.now();
    const download = await this.getDownload(downloadId);
    if (!download) throw new Error(`Download ${downloadId} not found`);
    if (!download.bookId) throw new Error(`Download ${downloadId} has no linked book`);

    const book = await this.bookService!.getById(download.bookId);
    if (!book) throw new Error(`Book ${download.bookId} not found`);
    const authorName = book.authors[0]?.name ?? null;

    await this.db.update(downloads).set({ status: 'importing' }).where(eq(downloads.id, downloadId));

    let targetPath: string | undefined;
    let stagingPath: string | undefined;
    let backupPath: string | undefined;
    let libraryRoot: string | undefined;
    let protectTarget = false;
    try {
      const { resolvedPath: savePath, originalPath } = await resolveSavePath(download, this.downloadClientService, this.remotePathMappingService);
      this.log.debug({ downloadId, bookTitle: book.title, resolvedPath: savePath, originalPath }, 'Resolved save path');
      const [librarySettings, importSettings, processingSettings] = await Promise.all([
        this.settingsService.get('library'),
        this.settingsService.get('import'),
        this.settingsService.get('processing'),
      ]);
      const namingOptions = toNamingOptions(librarySettings);
      libraryRoot = librarySettings.path;
      targetPath = buildTargetPath(librarySettings.path, librarySettings.folderFormat, book, authorName, namingOptions);
      stagingPath = `${targetPath}.import-tmp`;
      backupPath = `${targetPath}.import-bak`;
      // Same-path re-import: targetPath IS the user's existing book folder, so the
      // commit must back-up-and-rollback rather than destroy, and failure cleanup
      // must never blanket-rm it. First import / move-path: targetPath is disposable.
      protectTarget = book.path != null && normalize(targetPath) === normalize(book.path);
      this.log.debug({ downloadId, bookTitle: book.title, targetPath, protectTarget }, 'Built target path');

      const { sourcePath, fileCount, sourceStats } = await validateSource(savePath, this.remotePathMappingService, download.downloadClientId);
      this.log.debug({ downloadId, bookTitle: book.title, fileCount, sourceSize: sourceStats.size }, 'Validated source');
      const diskSpace = await checkDiskSpace({ sourcePath, sourceStats, libraryPath: librarySettings.path, minFreeSpaceGB: importSettings.minFreeSpaceGB });
      this.log.debug({ downloadId, bookTitle: book.title, freeGB: diskSpace.freeGB, requiredGB: diskSpace.requiredGB }, 'Disk space check passed');

      // ── Phase 1: stage + verify into a sibling (non-destructive) ──────────
      // Copy, rename and verify the new version into `.import-tmp`. The existing
      // targetPath is never touched here, so a copy failure can't destroy the
      // current book — old audio, cover and metadata all remain in place.
      await prepareImportSiblings({ stagingPath, backupPath, libraryRoot, log: this.log });
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

      // ── Phase 2: commit (backup existing audio, move staged in, rollback) ─
      // Only after Phase 1 verifies do we touch targetPath. The swap backs up the
      // old audio before moving the new files in and rolls back on any failure,
      // so a mid-commit error can't leave the book missing or half-replaced.
      await commitStagedImport({ stagingPath, targetPath, backupPath, libraryRoot, log: this.log });
      // Committed: targetPath now holds the new version. Protect it so a later
      // failure never blanket-rm's the committed files (matters for move re-imports
      // and first imports, where protectTarget started false).
      protectTarget = true;

      await this.db.transaction(async (tx) => {
        await tx.update(books).set({ status: 'imported', path: targetPath, size: targetSize, lastGrabGuid: download.guid ?? null, lastGrabInfoHash: download.infoHash ?? null, updatedAt: new Date() }).where(eq(books.id, book.id));
        await tx.update(downloads).set({ status: 'imported' }).where(eq(downloads.id, downloadId));
      });

      // Delete the old folder only after the DB durably points the book at
      // targetPath. Deleting earlier would strand the DB on a deleted path if the
      // transaction rolled back. No-op for first import / same-path re-import.
      await cleanupOldBookPath({ bookPath: book.path, targetPath, libraryRoot: librarySettings.path, log: this.log });

      const ffprobePath = resolveFfprobePathFromSettings(processingSettings?.ffmpegPath);
      await notifyPhase(callbacks, 'fetching_metadata');
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
        error, targetPath, stagingPath, backupPath, libraryRoot, protectTarget,
        db: this.db, downloadId, book, log: this.log, elapsedMs: Date.now() - startMs,
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
   * Query eligible downloads for import enqueueing.
   * Returns download IDs + bookIds. No slot admission — caller enqueues to import_jobs.
   */
  async getEligibleDownloads(): Promise<Array<{ id: number; bookId: number }>> {
    const eligibleDownloads = await this.db
      .select({ id: downloads.id, bookId: downloads.bookId })
      .from(downloads)
      .where(and(
        inArray(downloads.status, ['completed']),
        isNotNull(downloads.externalId),
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
      // The import path defers when the live ratio cannot be fetched — it treats "unknown
      // state" as "not yet safe to remove". outputPath-nulling is intentionally NOT done here.
      const result = await removeOrDeferTorrent(download, importSettings,
        { downloadClientService: this.downloadClientService, log: this.log },
        { deferOnUnavailableRatio: true });
      await this.applyImportRemovalResult(download, importSettings, result);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed to remove torrent after import');
    }
  }

  /** Map the shared removal result onto the initial-import bookkeeping (defer markers + logs). */
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

        const result = await removeOrDeferTorrent(download, importSettings,
          { downloadClientService: this.downloadClientService, log: this.log },
          { deferOnUnavailableRatio: false });
        await this.applyDeferredImportResult(download, result);
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error), downloadId: download.id }, 'Failed deferred torrent removal — will retry next cycle');
      }
    }
  }

  /** Map the shared removal result onto the deferred-import retry bookkeeping (clears pendingCleanup on success). */
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
      // 'deferred' (seed conditions not yet met) and 'live-state-unavailable' (unreachable with
      // deferOnUnavailableRatio: false) both leave the existing pendingCleanup marker for next cycle.
      case 'deferred':
      case 'live-state-unavailable':
        return;
    }
  }
}
