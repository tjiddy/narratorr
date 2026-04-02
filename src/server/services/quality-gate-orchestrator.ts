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
import type { books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { resolveSavePath } from '../utils/download-path.js';
import { revertBookStatus } from '../utils/book-status.js';
import type { RetrySearchDeps } from './retry-search.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import type { SettingsService } from './settings.service.js';
import { rm, stat } from 'node:fs/promises';

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
  ) {}

  /**
   * Process all completed downloads through the quality gate.
   * Owns the batch loop: query → iterate → claim → scan → decide → side effects.
   */
  async processCompletedDownloads(): Promise<void> {
    const completedDownloads = await this.qualityGateService.getCompletedDownloads();

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
          scanResult = await scanAudioDirectory(savePath, { skipCover: true });
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

    await this.removeDownloadFiles(download);
    await this.fallbackFileDelete(download);

    // Recover book status — errors propagate to caller (manual reject → 500, auto-reject → outer catch → pending_review)
    if (book) {
      const revertStatus = await revertBookStatus(this.db, book);
      this.emitSSE('download_status_change', { download_id: download.id, book_id: book.id, old_status: oldStatus, new_status: 'failed' });
      this.emitSSE('book_status_change', { book_id: book.id, old_status: book.status as BookStatus, new_status: revertStatus as BookStatus });
    }
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
