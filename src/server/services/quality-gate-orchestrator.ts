import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { QualityGateService, QualityDecision } from './quality-gate.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { RemotePathMappingService } from './remote-path-mapping.service.js';
import { safeEmit } from '../utils/safe-emit.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookRow, DownloadRow } from './types.js';
import type { QualityDecisionReason } from './quality-gate.types.js';
import { NULL_REASON } from './quality-gate.types.js';
import { books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { resolveSavePath } from '../utils/download-path.js';
import { revertBookStatus } from '../utils/book-status.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { RetrySearchDeps } from './retry-search.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import type { SettingsService } from './settings.service.js';
import { rm, stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';
import { isTorrentRemovalDeferred } from '../utils/seed-helpers.js';
import { cleanupDeferredRejections as cleanupDeferred } from './quality-gate-deferred-cleanup.helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';
import type { BookImportService } from './book-import.service.js';
import { WireOnce, ServiceWireError } from './wire-helpers.js';

export interface QualityGateOrchestratorWireDeps {
  nudgeImportWorker: () => void;
  bookImportService: BookImportService;
}

export interface QualityGateOrchestratorOptionalDeps {
  eventHistory?: EventHistoryService;
  broadcaster?: EventBroadcasterService;
  blacklistService?: BlacklistService;
  remotePathMappingService?: RemotePathMappingService;
  retrySearchDeps?: RetrySearchDeps;
  settingsService?: SettingsService;
}

export class QualityGateOrchestrator {
  private wired = new WireOnce<QualityGateOrchestratorWireDeps>('QualityGateOrchestrator');

  constructor(
    private qualityGateService: QualityGateService,
    private db: Db,
    private log: FastifyBaseLogger,
    private downloadClientService: DownloadClientService,
    private optional: QualityGateOrchestratorOptionalDeps = {},
  ) {}

  /** Wire cyclic / late-bound deps after construction. Call once during composition. */
  wire(deps: QualityGateOrchestratorWireDeps): void {
    this.wired.set(deps);
  }

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
          safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: row.download.id, book_id: row.book.id, old_status: 'completed', new_status: 'checking' }, this.log);
        }

        await this.processClaimedRow(row, ffprobePath);
      } catch (error: unknown) {
        this.log.error({ error: serializeError(error), downloadId: row.download.id }, 'Quality gate error');
        // Set pending_review with probeFailure on unhandled error
        await this.qualityGateService.setStatus(row.download.id, 'pending_review');
        const probeError = getErrorMessage(error);
        this.recordDecision(row.download, row.book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: ['unhandled_error'] });
      }
    }
  }

  /** Process a single completed download through the quality gate, with inline import on approval. */
  async processOneDownload(downloadId: number): Promise<void> {
    const [ffprobePath2, row] = await Promise.all([this.resolveFfprobePath(), this.qualityGateService.getCompletedDownloadById(downloadId)]);
    if (!row) { this.log.warn({ downloadId }, 'Quality gate: processOneDownload — download not found or not completed'); return; }
    if (!row.download.externalId || !row.download.bookId) { this.log.debug({ id: row.download.id }, 'Quality gate: skipping download without externalId or bookId'); return; }

    // Required-wiring fail-fast (#739): the imported-decision branch needs
    // nudgeImportWorker. Verify wire() was called BEFORE any mutating state
    // transition (atomicClaim, book-status promotion, SSE) so an unwired
    // orchestrator never leaves partial state behind.
    const { nudgeImportWorker, bookImportService } = this.wired.require();

    const claimed = await this.qualityGateService.atomicClaim(row.download.id);
    if (!claimed) { this.log.debug({ id: row.download.id }, 'Quality gate: already claimed by another cycle'); return; }

    // Promote book status to 'importing' (taking over from removed handleBookStatusOnCompletion)
    if (row.book) {
      await this.db.update(books).set({ status: 'importing' }).where(eq(books.id, row.book.id));
      safeEmit(this.optional.broadcaster, 'book_status_change', { book_id: row.book.id, old_status: row.book.status, new_status: 'importing' }, this.log);
      safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: row.download.id, book_id: row.book.id, old_status: 'completed', new_status: 'checking' }, this.log);
      row.book.status = 'importing'; // Update in-memory so revert guards work
    }

    try {
      const decision = await this.processClaimedRow(row, ffprobePath2);
      if (decision?.action === 'imported' && row.book) {
        // Best-effort fire-and-forget: enqueueAutoImport returns false on conflict
        // (already logged inside the helper). Do not throw, do not transition the
        // gate decision back to pending_review — another path already enqueued.
        await enqueueAutoImport(bookImportService, downloadId, row.book.id, nudgeImportWorker, this.log);
      }
    } catch (error: unknown) {
      // Defense-in-depth for the required-wiring contract (#739): in case any
      // future code inside the try block also reads wired deps, surface
      // ServiceWireError instead of converting to pending_review.
      if (error instanceof ServiceWireError) throw error;
      this.log.error({ error: serializeError(error), downloadId: row.download.id }, 'Quality gate error');
      await this.qualityGateService.setStatus(row.download.id, 'pending_review');
      // Revert book from importing → downloading if it was promoted before the error
      if (row.book && row.book.status === 'importing') {
        await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, row.book.id));
        safeEmit(this.optional.broadcaster, 'book_status_change', { book_id: row.book.id, old_status: 'importing', new_status: 'downloading' }, this.log);
      }
      const probeError = getErrorMessage(error);
      this.recordDecision(row.download, row.book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: ['unhandled_error'] });
    }
  }

  async cleanupDeferredRejections(): Promise<void> {
    return cleanupDeferred({
      qualityGateService: this.qualityGateService,
      downloadClientService: this.downloadClientService,
      settingsService: this.optional.settingsService,
      db: this.db,
      log: this.log,
    });
  }

  /**
   * Approve a pending_review download — delegates DB transition to service,
   * dispatches SSE + event recording side effects.
   */
  async approve(downloadId: number): Promise<{ id: number; status: string; bookId: number | null }> {
    const result = await this.qualityGateService.approve(downloadId);

    // Side effects — fire-and-forget
    if (result.book) {
      safeEmit(this.optional.broadcaster, 'download_status_change', {
        download_id: downloadId, book_id: result.book.id,
        old_status: 'pending_review', new_status: 'importing',
      }, this.log);
    }

    return { id: result.id, status: result.status, bookId: result.book?.id ?? null };
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

  private async resolveFfprobePath(): Promise<string | undefined> { const s = await this.optional.settingsService?.get('processing'); return resolveFfprobePathFromSettings(s?.ffmpegPath); }

  /**
   * Run the savePath → scan → decide → dispatch chain for a row that the caller
   * has already claimed. Returns the decision, or `null` if a hold-for-probe-failure
   * already fired (caller should treat that as "no decision").
   *
   * Caller-specific pre-flight (atomicClaim, SSE timing, book-status promotion,
   * wired-deps fail-fast) and post-flight (outer catch, enqueueAutoImport,
   * ServiceWireError handling) live in the callers.
   */
  private async processClaimedRow(
    row: { download: DownloadRow; book: BookRow | null },
    ffprobePath: string | undefined,
  ): Promise<QualityDecision | null> {
    let savePath: string;
    let originalPath: string;
    try {
      ({ resolvedPath: savePath, originalPath } = await resolveSavePath(row.download, this.downloadClientService, this.optional.remotePathMappingService));
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), downloadId: row.download.id }, 'Quality gate: failed to resolve save path');
      await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
      return null;
    }

    const scanOpts = {
      skipCover: true,
      ...(ffprobePath !== undefined && { ffprobePath }),
      onWarn: (msg: string, payload?: Record<string, unknown>) => this.log.warn(payload, msg),
      onDebug: (msg: string, payload?: Record<string, unknown>) => this.log.debug(payload, msg),
    };

    let scanResult;
    try {
      scanResult = await scanAudioDirectory(savePath, scanOpts);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), downloadId: row.download.id }, 'Quality gate: scan failed');
      await this.holdForProbeFailure(row.download, row.book, 'probe_failed', error);
      return null;
    }

    // Fallback: when the freshly resolved client path scans empty, try the persisted
    // outputPath that monitor.ts already captured for this download. Guards against
    // download clients returning a stale/parent-ish path just after completion (#1120).
    const outputPath = row.download.outputPath;
    let fallbackAttempted = false;
    if (!scanResult && outputPath && outputPath !== savePath) {
      fallbackAttempted = true;
      try {
        scanResult = await scanAudioDirectory(outputPath, scanOpts);
        if (scanResult) {
          this.log.info({ downloadId: row.download.id, resolvedPath: savePath, outputPath }, 'Quality gate: used persisted outputPath as scan fallback');
        }
      } catch (error: unknown) {
        this.log.debug({ downloadId: row.download.id, outputPath, error: serializeError(error) }, 'Quality gate: outputPath fallback scan failed');
        scanResult = null;
      }
    }

    if (!scanResult) {
      this.log.warn({
        downloadId: row.download.id,
        externalId: row.download.externalId,
        resolvedPath: savePath,
        originalPath,
        outputPath,
        fallbackAttempted,
      }, 'Quality gate: no audio files found');
      await this.holdForProbeFailure(row.download, row.book, 'probe_failed', 'No audio files found');
      return null;
    }

    const decision = await this.qualityGateService.processDownload(row.download, row.book, scanResult);
    await this.dispatchSideEffects(decision.action, row.download, row.book, decision.reason, decision.statusTransition);
    return decision;
  }

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
      safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: download.id, book_id: book.id, old_status: 'checking', new_status: 'pending_review' }, this.log);
      safeEmit(this.optional.broadcaster, 'review_needed', { download_id: download.id, book_id: book.id, book_title: book.title }, this.log);
      // Revert book from importing → downloading (monitor pre-promoted on completion)
      if (book.status === 'importing') {
        await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, book.id));
        safeEmit(this.optional.broadcaster, 'book_status_change', { book_id: book.id, old_status: 'importing', new_status: 'downloading' }, this.log);
      }
    }

    const probeError = error === undefined ? null
      : typeof error === 'string' ? error
      : getErrorMessage(error);
    this.recordDecision(download, book, { ...NULL_REASON, probeFailure: true, probeError, holdReasons: [holdReason] });
  }

  /** Dispatch side effects based on quality decision. */
  private async dispatchSideEffects(
    action: 'imported' | 'rejected' | 'held',
    download: DownloadRow,
    book: BookRow | null,
    reason: QualityDecisionReason,
    statusTransition: QualityDecision['statusTransition'],
  ): Promise<void> {
    if (action === 'held') {
      if (book) {
        safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: download.id, book_id: book.id, old_status: statusTransition.from, new_status: statusTransition.to }, this.log);
        safeEmit(this.optional.broadcaster, 'review_needed', { download_id: download.id, book_id: book.id, book_title: book.title }, this.log);
        // Revert book from importing → downloading (monitor pre-promoted on completion)
        if (book.status === 'importing') {
          await this.db.update(books).set({ status: 'downloading' }).where(eq(books.id, book.id));
          safeEmit(this.optional.broadcaster, 'book_status_change', { book_id: book.id, old_status: 'importing', new_status: 'downloading' }, this.log);
        }
      }
      this.recordDecision(download, book, reason);
    } else if (action === 'imported') {
      if (book) {
        safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: download.id, book_id: book.id, old_status: statusTransition.from, new_status: statusTransition.to }, this.log);
      }
    } else if (action === 'rejected') {
      await this.performRejectionCleanup(download, book, statusTransition.from, true);
    }
  }

  /** Shared cleanup for rejection: optionally blacklist + re-search, delete files, revert book status + SSE. */
  private async performRejectionCleanup(download: DownloadRow, book: BookRow | null, oldStatus: DownloadStatus = 'pending_review', retry = false): Promise<void> {
    if (retry) {
      await blacklistAndRetrySearch({
        identifiers: {
          ...(download.infoHash != null && { infoHash: download.infoHash }),
          ...(download.guid != null && { guid: download.guid }),
          title: download.title,
          ...(download.bookId != null && { bookId: download.bookId }),
        },
        reason: 'bad_quality',
        book,
        blacklistService: this.optional.blacklistService,
        retrySearchDeps: this.optional.retrySearchDeps,
        settingsService: this.optional.settingsService,
        log: this.log,
        overrideRetry: true,
      });
    }

    await this.gatedRejectionCleanup(download);

    // Recover book status — errors propagate to caller (manual reject → 500, auto-reject → outer catch → pending_review)
    if (book) {
      const revertStatus = await revertBookStatus(this.db, book);
      safeEmit(this.optional.broadcaster, 'download_status_change', { download_id: download.id, book_id: book.id, old_status: oldStatus, new_status: 'failed' }, this.log);
      safeEmit(this.optional.broadcaster, 'book_status_change', { book_id: book.id, old_status: book.status, new_status: revertStatus }, this.log);
    }
  }

  /** Read import settings, check seed conditions, and either delete, defer, or skip. */
  private async gatedRejectionCleanup(download: DownloadRow): Promise<void> {
    let shouldDelete = true;
    let importSettings = { minSeedTime: 0, minSeedRatio: 0 };
    try {
      if (this.optional.settingsService) {
        const settings = await this.optional.settingsService.get('import');
        shouldDelete = settings.deleteAfterImport;
        importSettings = { minSeedTime: settings.minSeedTime, minSeedRatio: settings.minSeedRatio };
      }
    } catch (error: unknown) {
      this.log.warn({ downloadId: download.id, error: serializeError(error) }, 'Quality gate: failed to read import settings — defaulting to non-destructive cleanup');
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
      this.log.warn({ downloadId: download.id, error: serializeError(error) }, 'Quality gate: failed to delete download files');
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
      this.log.warn({ downloadId: download.id, outputPath: download.outputPath, error: serializeError(error) }, 'Quality gate: fallback file deletion failed');
    }
  }

  /** Fire-and-forget event recording — swallows errors to avoid breaking the caller. */
  private recordDecision(download: DownloadRow, book: BookRow | null, reason: QualityDecisionReason): void {
    if (!book || !this.optional.eventHistory) return;

    this.optional.eventHistory.create({
      bookId: book.id,
      bookTitle: book.title,
      downloadId: download.id,
      eventType: 'held_for_review',
      source: 'auto',
      reason: { ...reason },
    }).catch((err: unknown) => {
      this.log.warn({ downloadId: download.id, error: serializeError(err) }, 'Quality gate: failed to record decision event');
    });
  }

}
