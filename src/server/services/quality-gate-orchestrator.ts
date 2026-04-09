import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { QualityGateService } from './quality-gate.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { SSEEventType, SSEEventPayloads } from '../../shared/schemas/sse-events.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { DownloadRow } from './types.js';
import type { QualityDecisionReason } from './quality-gate.types.js';
import { NULL_REASON } from './quality-gate.types.js';
import { books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { resolveSavePath } from '../utils/download-path.js';
import { revertBookStatus } from '../utils/book-status.js';
import type { RetrySearchDeps } from './retry-search.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import type { SettingsService } from './settings.service.js';
import { rm, stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';
import type { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportService } from './import.service.js';
type BookRow = typeof books.$inferSelect;

export class QualityGateOrchestrator {
  constructor(
    private qualityGateService: QualityGateService,
    private db: Db,
    private log: FastifyBaseLogger,
    private downloadClientService: DownloadClientService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
    private blacklistService?: BlacklistService,
    private remotePathMappingService?: RemotePathMappingService,
    private retrySearchDeps?: RetrySearchDeps,
    private settingsService?: SettingsService,
    private importOrchestrator?: ImportOrchestrator,
    private importService?: ImportService,
  ) {}

  /**
   * Process all completed downloads through the quality gate.
   * Owns the batch loop: query → iterate → claim → scan → decide → side effects.
   */
  async processCompletedDownloads(): Promise<void> {
    const [completedDownloads, ffprobePath] = await Promise.all([this.qualityGateService.getCompletedDownloads(), this.resolveFfprobePath()]);
    for (const row of completedDownloads) {
      if (!row.download.externalId || !row.download.bookId) {
        this.log.debug({ id: row.download.id }, 'Quality gate: skipping download without externalId or bookId');
        continue;
      }

      try {
        // Atomic claim: completed → checking
        const claimed = await this.qualityGateService.atomicClaim(row.download.id);
        if (!claimed) {
          this.log.debug({ id: row.download.id }, 'Quality gate: already claimed by another cycle');
          continue;
        }

        // SSE: download_status_change (completed → checking)
        if (row.book) {
          this.emitSSE('download_status_change', { download_id: row.download.id, book_id: row.book.id, old_status: 'completed', new_status: 'checking' });
        }

        // Resolve save path
        let savePath: string;
        try {
          ({ resolvedPath: savePath } = await resolveSavePath(row.download, this.downloadClientService, this.remotePathMappingService));
        } catch (error: unknown) {
          this.log.error({ error, downloadId: row.download.id }, 'Quality gate: failed to resolve save path');
          await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
          continue;
        }

        // Probe audio files
        let scanResult;
        try {
          scanResult = await scanAudioDirectory(savePath, { skipCover: true, ffprobePath, log: this.log });
        } catch (error: unknown) {
          this.log.error({ error, downloadId: row.download.id }, 'Quality gate: scan failed');
          await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
          continue;
        }

        if (!scanResult) {
          this.log.warn({ downloadId: row.download.id }, 'Quality gate: no audio files found');
          await this.holdForProbeFailure(row.download, row.book, 'probe_failed', 'No audio files found');
          continue;
        }

        // Get decision from service
        const decision = await this.qualityGateService.processDownload(row.download, row.book, scanResult);

        // Dispatch side effects based on decision
        await this.dispatchSideEffects(decision.action, row.download, row.book, decision.reason, decision.statusTransition);
      } catch (error: unknown) {
        this.log.error({ error, downloadId: row.download.id }, 'Quality gate error');
        // Set pending_review with probeFailure on unhandled error
        await this.qualityGateService.setStatus(row.download.id, 'pending_review');
        const probeError = error instanceof Error ? error.message : String(error);
        this.recordDecision(row.download, row.book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: ['unhandled_error'] });
      }
    }
  }

  /** Process a single completed download through the quality gate, with inline import on approval. */
  async processOneDownload(downloadId: number): Promise<void> {
    const [ffprobePath2, row] = await Promise.all([this.resolveFfprobePath(), this.qualityGateService.getCompletedDownloadById(downloadId)]);
    if (!row) { this.log.warn({ downloadId }, 'Quality gate: processOneDownload — download not found or not completed'); return; }
    if (!row.download.externalId || !row.download.bookId) { this.log.debug({ id: row.download.id }, 'Quality gate: skipping download without externalId or bookId'); return; }
    const claimed = await this.qualityGateService.atomicClaim(row.download.id);
    if (!claimed) { this.log.debug({ id: row.download.id }, 'Quality gate: already claimed by another cycle'); return; }

    // Promote book status to 'importing' (taking over from removed handleBookStatusOnCompletion)
    if (row.book) {
      await this.db.update(books).set({ status: 'importing' }).where(eq(books.id, row.book.id));
      this.emitSSE('book_status_change', { book_id: row.book.id, old_status: row.book.status as BookStatus, new_status: 'importing' as BookStatus });
      (row.book as { status: string }).status = 'importing'; // Update in-memory so revert guards work
    }
    if (row.book) {
      this.emitSSE('download_status_change', { download_id: row.download.id, book_id: row.book.id, old_status: 'completed', new_status: 'checking' });
    }

    try {
      let savePath: string;
      try {
        ({ resolvedPath: savePath } = await resolveSavePath(row.download, this.downloadClientService, this.remotePathMappingService));
      } catch (error: unknown) {
        this.log.error({ error, downloadId: row.download.id }, 'Quality gate: failed to resolve save path');
        await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
        return;
      }
      let scanResult;
      try {
        scanResult = await scanAudioDirectory(savePath, { skipCover: true, ffprobePath: ffprobePath2, log: this.log });
      } catch (error: unknown) {
        this.log.error({ error, downloadId: row.download.id }, 'Quality gate: scan failed');
        await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
        return;
      }
      if (!scanResult) { this.log.warn({ downloadId: row.download.id }, 'Quality gate: no audio files found'); await this.holdForProbeFailure(row.download, row.book, 'probe_failed', 'No audio files found'); return; }

      const decision = await this.qualityGateService.processDownload(row.download, row.book, scanResult);
      await this.dispatchSideEffects(decision.action, row.download, row.book, decision.reason, decision.statusTransition);
      if (decision.action === 'imported') { await this.triggerImportWithSlotAdmission(downloadId); }
    } catch (error: unknown) {
      this.log.error({ error, downloadId: row.download.id }, 'Quality gate error');
      await this.qualityGateService.setStatus(row.download.id, 'pending_review');
      // Revert book from importing → downloading if it was promoted before the error
      if (row.book && row.book.status === 'importing') {
        await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, row.book.id));
        this.emitSSE('book_status_change', { book_id: row.book.id, old_status: 'importing' as BookStatus, new_status: 'downloading' as BookStatus });
      }
      const probeError = error instanceof Error ? error.message : String(error);
      this.recordDecision(row.download, row.book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: ['unhandled_error'] });
    }
  }

  /** Slot admission for inline import: acquire slot → fire-and-forget import, or queue for next sweep. */
  private async triggerImportWithSlotAdmission(downloadId: number): Promise<void> {
    if (!this.importService || !this.importOrchestrator) return;

    if (this.importService.tryAcquireSlot()) {
      this.importOrchestrator.importDownload(downloadId)
        .catch((err: unknown) => {
          this.log.error({ downloadId, error: err }, 'Quality gate: inline import failed');
        })
        .finally(() => {
          this.importService!.releaseSlot();
        });
    } else {
      await this.importService.setProcessingQueued(downloadId);
      this.log.info({ downloadId }, 'Quality gate: concurrency limit reached, queued for next maintenance sweep');
    }
  }

  /**
   * Process deferred rejection cleanups — downloads where seed time was not yet elapsed
   * at rejection time. Re-checks seed time and performs file deletion + client deregistration
   * for candidates where the threshold has now passed.
   */
  async cleanupDeferredRejections(): Promise<void> {
    let importSettings = { minSeedTime: 0, minSeedRatio: 0 };
    try {
      if (this.settingsService) {
        const settings = await this.settingsService.get('import');
        importSettings = { minSeedTime: settings.minSeedTime, minSeedRatio: settings.minSeedRatio };
      }
    } catch (error: unknown) {
      this.log.warn({ error }, 'Quality gate: failed to read import settings for deferred cleanup — skipping cycle');
      return;
    }

    const candidates = await this.qualityGateService.getDeferredCleanupCandidates();
    if (candidates.length === 0) return;

    for (const download of candidates) {
      try {
        await this.processDeferredCandidate(download, importSettings);
      } catch (error: unknown) {
        this.log.warn({ downloadId: download.id, error }, 'Quality gate: deferred cleanup error — will retry next cycle');
      }
    }
  }

  /** Process a single deferred-cleanup candidate: check seed time + ratio, delete files, deregister, update markers. */
  private async processDeferredCandidate(download: DownloadRow, importSettings: { minSeedTime: number; minSeedRatio: number }): Promise<void> {
    // Fetch current ratio for ratio-gated torrents
    let currentRatio = 0;
    if (importSettings.minSeedRatio > 0 && download.downloadClientId && download.externalId) {
      const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
      const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
      currentRatio = liveState?.ratio ?? 0;
    }

    if (isTorrentRemovalDeferred(download, importSettings, currentRatio)) {
      this.log.debug({ downloadId: download.id }, 'Quality gate: deferred cleanup skipped — seed conditions not met');
      return;
    }

    // Seed time elapsed (or no completedAt / minSeedTime=0) — perform cleanup
    const adapterSuccess = await this.deferredRemoveFromClient(download);
    const filesDeleted = await this.deferredDeleteFiles(download);

    if (adapterSuccess && filesDeleted) {
      // Full success — clear both markers
      await this.db.update(downloads).set({ pendingCleanup: null, outputPath: null }).where(eq(downloads.id, download.id));
    } else if (filesDeleted && !adapterSuccess) {
      // Files gone but adapter failed — clear outputPath only, keep pendingCleanup for retry
      await this.db.update(downloads).set({ outputPath: null }).where(eq(downloads.id, download.id));
    }
    // If files not deleted (regardless of adapter), leave everything for retry
  }

  /** Attempt to deregister download from client. Returns true on success, false on error. */
  private async deferredRemoveFromClient(download: DownloadRow): Promise<boolean> {
    try {
      if (download.downloadClientId && download.externalId) {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        if (adapter) {
          await adapter.removeDownload(download.externalId, true);
          this.log.info({ downloadId: download.id }, 'Quality gate: deferred cleanup — removed download from client');
        }
      }
      return true;
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, error }, 'Quality gate: deferred cleanup — failed to remove from client');
      return false;
    }
  }

  /** Attempt filesystem deletion for deferred cleanup. Returns true if files are gone, false if deletion failed. */
  private async deferredDeleteFiles(download: DownloadRow): Promise<boolean> {
    if (!download.outputPath) return true; // No outputPath means files were already cleaned up in a prior cycle

    // Check if path exists — ENOENT means files are already gone
    try {
      await stat(download.outputPath);
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === 'ENOENT') {
        this.log.debug({ downloadId: download.id }, 'Quality gate: deferred cleanup — outputPath does not exist or already removed');
        return true; // Files are gone
      }
      this.log.warn({ downloadId: download.id, outputPath: download.outputPath, error }, 'Quality gate: deferred cleanup — stat failed (non-ENOENT)');
      return false; // Can't verify file state — preserve retry
    }

    // Path exists — attempt deletion
    try {
      await rm(download.outputPath, { recursive: true, force: true });
      this.log.info({ downloadId: download.id, outputPath: download.outputPath }, 'Quality gate: deferred cleanup — deleted files');
      return true;
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, outputPath: download.outputPath, error }, 'Quality gate: deferred cleanup — file deletion failed');
      return false; // Files still on disk — keep pendingCleanup for retry
    }
  }

  /**
   * Approve a pending_review download — delegates DB transition to service,
   * dispatches SSE + event recording side effects.
   */
  async approve(downloadId: number): Promise<{ id: number; status: string }> {
    const result = await this.qualityGateService.approve(downloadId);

    // Side effects — fire-and-forget
    if (result.book) {
      this.emitSSE('download_status_change', {
        download_id: downloadId, book_id: result.book.id,
        old_status: 'pending_review', new_status: 'importing',
      });
    }

    return { id: result.id, status: result.status };
  }

  /**
   * Reject a pending_review download — delegates DB transition to service,
   * dispatches event recording + rejection cleanup.
   */
  async reject(downloadId: number, options?: { retry?: boolean }): Promise<{ id: number; status: string }> {
    const result = await this.qualityGateService.reject(downloadId);

    // Side effects — retry=true includes blacklist + re-search; retry=false (default) is dismiss-only
    await this.performRejectionCleanup(result.download, result.book, 'pending_review', options?.retry ?? false);

    return { id: result.id, status: result.status };
  }

  private async resolveFfprobePath(): Promise<string | undefined> { const s = await this.settingsService?.get('processing'); return resolveFfprobePathFromSettings(s?.ffmpegPath); }
  /** Hold for probe failure: set pending_review + SSE + event recording. */
  private async holdForProbeFailure(
    download: DownloadRow,
    book: BookRow | null,
    holdReason: string,
    error?: unknown,
  ): Promise<void> {
    await this.qualityGateService.setStatus(download.id, 'pending_review');

    // SSE: download_status_change (checking → pending_review) + review_needed
    if (book) {
      this.emitSSE('download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'pending_review' });
      this.emitSSE('review_needed', { download_id: download.id, book_id: book.id, book_title: book.title });
      // Revert book from importing → downloading (monitor pre-promoted on completion)
      if (book.status === 'importing') {
        await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, book.id));
        this.emitSSE('book_status_change', { book_id: book.id, old_status: 'importing' as BookStatus, new_status: 'downloading' as BookStatus });
      }
    }

    const probeError = error === undefined ? null
      : typeof error === 'string' ? error
      : error instanceof Error ? error.message
      : String(error);
    this.recordDecision(download, book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: [holdReason] });
  }

  /** Dispatch side effects based on quality decision. */
  private async dispatchSideEffects(
    action: 'imported' | 'rejected' | 'held',
    download: DownloadRow,
    book: BookRow | null,
    reason: QualityDecisionReason,
    statusTransition: { from: string; to: string },
  ): Promise<void> {
    if (action === 'held') {
      if (book) {
        this.emitSSE('download_status_change', { download_id: download.id, book_id: book.id, old_status: statusTransition.from as DownloadStatus, new_status: statusTransition.to as DownloadStatus });
        this.emitSSE('review_needed', { download_id: download.id, book_id: book.id, book_title: book.title });
        // Revert book from importing → downloading (monitor pre-promoted on completion)
        if (book.status === 'importing') {
          await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, book.id));
          this.emitSSE('book_status_change', { book_id: book.id, old_status: 'importing' as BookStatus, new_status: 'downloading' as BookStatus });
        }
      }
      this.recordDecision(download, book, reason);
    } else if (action === 'imported') {
      if (book) {
        this.emitSSE('download_status_change', { download_id: download.id, book_id: book.id, old_status: statusTransition.from as DownloadStatus, new_status: statusTransition.to as DownloadStatus });
      }
    } else if (action === 'rejected') {
      await this.performRejectionCleanup(download, book, statusTransition.from as DownloadStatus, true);
    }
  }

  /** Shared cleanup for rejection: optionally blacklist + re-search, delete files, revert book status + SSE. */
  private async performRejectionCleanup(download: DownloadRow, book: BookRow | null, oldStatus: DownloadStatus = 'pending_review', retry = false): Promise<void> {
    if (retry) {
      await blacklistAndRetrySearch({
        identifiers: {
          infoHash: download.infoHash ?? undefined,
          guid: download.guid ?? undefined,
          title: download.title,
          bookId: download.bookId ?? undefined,
        },
        reason: 'bad_quality',
        book,
        blacklistService: this.blacklistService,
        retrySearchDeps: this.retrySearchDeps,
        settingsService: this.settingsService,
        log: this.log,
        overrideRetry: true,
      });
    }

    await this.gatedRejectionCleanup(download);

    // Recover book status — errors propagate to caller (manual reject → 500, auto-reject → outer catch → pending_review)
    if (book) {
      const revertStatus = await revertBookStatus(this.db, book);
      this.emitSSE('download_status_change', { download_id: download.id, book_id: book.id, old_status: oldStatus, new_status: 'failed' });
      this.emitSSE('book_status_change', { book_id: book.id, old_status: book.status as BookStatus, new_status: revertStatus as BookStatus });
    }
  }

  /** Read import settings, check seed conditions, and either delete, defer, or skip. */
  private async gatedRejectionCleanup(download: DownloadRow): Promise<void> {
    let shouldDelete = true;
    let importSettings = { minSeedTime: 0, minSeedRatio: 0 };
    try {
      if (this.settingsService) {
        const settings = await this.settingsService.get('import');
        shouldDelete = settings.deleteAfterImport;
        importSettings = { minSeedTime: settings.minSeedTime, minSeedRatio: settings.minSeedRatio };
      }
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, error }, 'Quality gate: failed to read import settings — defaulting to non-destructive cleanup');
      shouldDelete = false;
    }

    if (!shouldDelete) {
      this.log.warn({ downloadId: download.id }, 'Quality gate: deleteAfterImport disabled — skipping file and client cleanup for rejected download');
      return;
    }

    const currentRatio = await this.fetchCurrentRatio(download, importSettings.minSeedRatio);

    if (isTorrentRemovalDeferred(download, importSettings, currentRatio)) {
      this.log.info({ downloadId: download.id }, 'Quality gate: deferring rejection cleanup — seed conditions not met');
      await this.db.update(downloads).set({ pendingCleanup: new Date() }).where(eq(downloads.id, download.id));
    } else {
      await this.removeDownloadFiles(download);
      await this.fallbackFileDelete(download);
    }
  }

  /** Fetch current ratio from download client for ratio-gated torrents. Returns 0 if not applicable. */
  private async fetchCurrentRatio(download: DownloadRow, minSeedRatio: number): Promise<number> {
    if (minSeedRatio <= 0 || !download.downloadClientId || !download.externalId) return 0;
    const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
    const liveState = adapter ? await adapter.getDownload(download.externalId) : null;
    return liveState?.ratio ?? 0;
  }

  /** Delete downloaded files via the download client adapter. */
  private async removeDownloadFiles(download: DownloadRow): Promise<void> {
    try {
      if (download.downloadClientId && download.externalId) {
        const adapter = await this.downloadClientService.getAdapter(download.downloadClientId);
        if (adapter) {
          await adapter.removeDownload(download.externalId, true);
          this.log.info({ downloadId: download.id }, 'Quality gate: deleted rejected download files');
        }
      }
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, error }, 'Quality gate: failed to delete download files');
    }
  }

  /** Attempt direct file deletion from persisted outputPath when adapter removal may have been incomplete. */
  private async fallbackFileDelete(download: DownloadRow): Promise<void> {
    if (!download.outputPath) {
      this.log.debug({ downloadId: download.id }, 'Quality gate: fallback delete skipped — no outputPath');
      return;
    }

    try {
      await stat(download.outputPath);
    } catch {
      this.log.debug({ downloadId: download.id, outputPath: download.outputPath }, 'Quality gate: fallback delete skipped — path does not exist');
      return;
    }

    try {
      await rm(download.outputPath, { recursive: true, force: true });
      this.log.info({ downloadId: download.id, outputPath: download.outputPath }, 'Quality gate: fallback deleted orphaned files');
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, outputPath: download.outputPath, error }, 'Quality gate: fallback file deletion failed');
    }
  }

  /** Fire-and-forget event recording — swallows errors to avoid breaking the caller. */
  private recordDecision(download: DownloadRow, book: BookRow | null, reason: QualityDecisionReason): void {
    if (!book || !this.eventHistory) return;

    this.eventHistory.create({
      bookId: book.id,
      bookTitle: book.title,
      downloadId: download.id,
      eventType: 'held_for_review',
      source: 'auto',
      reason: { ...reason },
    }).catch((err: unknown) => {
      this.log.warn({ downloadId: download.id, err }, 'Quality gate: failed to record decision event');
    });
  }

  /** Fire-and-forget SSE emit — swallows errors to avoid breaking the caller. */
  private emitSSE<T extends SSEEventType>(eventType: T, payload: SSEEventPayloads[T]): void {
    try { this.broadcaster?.emit(eventType, payload); } catch (error: unknown) { this.log.debug(error, 'SSE emit failed'); }
  }
}
