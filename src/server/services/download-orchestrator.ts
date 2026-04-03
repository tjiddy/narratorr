import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { DownloadService, DownloadWithBook, RetryResult } from './download.service.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { NotifierService } from './notifier.service.js';
import type { EventHistoryService, CreateEventInput } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadProtocol } from '../../core/index.js';
import { eq } from 'drizzle-orm';
import { books } from '../../db/schema.js';
import { revertBookStatus } from '../utils/book-status.js';
import {
  emitGrabStarted, emitBookStatusChangeOnGrab, emitDownloadProgress,
  emitDownloadStatusChange, emitBookStatusChange, notifyGrab,
  recordGrabbedEvent, recordDownloadCompletedEvent,
} from '../utils/download-side-effects.js';

export class DownloadOrchestrator {
  constructor(
    private downloadService: DownloadService,
    private db: Db,
    private log: FastifyBaseLogger,
    private notifierService?: NotifierService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
    private blacklistService?: BlacklistService,
  ) {}

  /**
   * Grab a download with full side-effect orchestration.
   * Wraps DownloadService.grab() with: book status update → grab_started SSE →
   * book_status_change SSE → notification → event recording.
   */
  async grab(params: {
    downloadUrl: string;
    title: string;
    protocol?: DownloadProtocol;
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
    guid?: string;
    skipDuplicateCheck?: boolean;
    replaceExisting?: boolean;
    source?: CreateEventInput['source'];
  }): Promise<DownloadWithBook> {
    // Core grab — let errors (including duplicate detection) propagate
    const download = await this.downloadService.grab(params);

    // Side effects — each independently guarded, errors don't affect grab result
    const isHandoff = !download.externalId;
    const protocol = params.protocol ?? 'torrent';

    if (params.bookId) {
      // Update book status in DB (downloading, or missing for handoff)
      const bookStatus = isHandoff ? 'missing' as const : 'downloading' as const;
      await this.db.update(books).set({ status: bookStatus, updatedAt: new Date() }).where(eq(books.id, params.bookId));

      this.safe(() => emitGrabStarted({ broadcaster: this.broadcaster, downloadId: download.id, bookId: params.bookId!, bookTitle: params.title, releaseTitle: params.title, log: this.log }));
      this.safe(() => emitBookStatusChangeOnGrab({ broadcaster: this.broadcaster, bookId: params.bookId!, isHandoff, log: this.log }));
    }

    this.safe(() => notifyGrab({ notifierService: this.notifierService, title: params.title, size: params.size, log: this.log }));

    this.safe(() => recordGrabbedEvent({
      eventHistory: this.eventHistory, bookId: params.bookId, bookTitle: params.title, downloadId: download.id,
      source: params.source ?? 'auto', reason: { indexerId: params.indexerId, size: params.size, protocol },
      log: this.log,
    }));

    return download;
  }

  /**
   * Cancel a download with side-effect orchestration.
   * Prefetches download+book context, delegates to DownloadService.cancel(),
   * then dispatches book status revert + SSE events.
   */
  async cancel(id: number): Promise<boolean> {
    // Prefetch context for side effects
    const download = await this.downloadService.getById(id);
    if (!download) return false;

    const oldStatus = download.status as DownloadStatus;
    const oldBookStatus = (download.book?.status ?? 'downloading') as BookStatus;

    // Core cancel
    const cancelled = await this.downloadService.cancel(id);
    if (!cancelled) return false;

    // Blacklist the release (best-effort — failure must not block cancel)
    await this.blacklistCancelledRelease(download);

    // Side effects — each independently guarded
    if (download.bookId) {
      try {
        const revertStatus = await revertBookStatus(this.db, { id: download.bookId, path: download.book?.path ?? null });
        this.safe(() => emitBookStatusChange({ broadcaster: this.broadcaster, bookId: download.bookId!, oldStatus: oldBookStatus as string, newStatus: revertStatus, log: this.log }));
      } catch (revertError: unknown) {
        this.log.warn(revertError, 'Failed to revert book status during cancel');
      }
      this.safe(() => emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: download.bookId!, oldStatus, newStatus: 'failed', log: this.log }));
    }
    // Orphaned downloads (no bookId) skip SSE — no book to invalidate

    return true;
  }

  /** Delegate retry to DownloadService (retry internally calls grab which will go through orchestrator via retrySearchDeps). */
  async retry(id: number): Promise<RetryResult> {
    return this.downloadService.retry(id);
  }

  /**
   * Update download progress with SSE dispatch.
   * Delegates to DownloadService.updateProgress(), then emits SSE events.
   */
  async updateProgress(id: number, progress: number, bookId?: number): Promise<void> {
    await this.downloadService.updateProgress(id, progress, bookId);

    if (bookId) {
      emitDownloadProgress({ broadcaster: this.broadcaster, downloadId: id, bookId, progress, log: this.log });

      if (progress >= 1) {
        emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId, oldStatus: 'downloading', newStatus: 'completed', log: this.log });
        // Look up download for title context
        const dl = await this.downloadService.getById(id);
        recordDownloadCompletedEvent({ eventHistory: this.eventHistory, downloadId: id, bookId, bookTitle: dl?.title ?? '', log: this.log });
      }
    }
  }

  /** Update download status with SSE dispatch. */
  async updateStatus(id: number, status: string, meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.downloadService.updateStatus(id, status, meta);
    if (meta?.bookId && meta?.oldStatus) {
      emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: meta.bookId, oldStatus: meta.oldStatus, newStatus: status, log: this.log });
    }
  }

  /** Run a side-effect function, catching and logging any error. */
  private safe(fn: () => void): void {
    try { fn(); } catch (error: unknown) { this.log.warn(error, 'Side-effect dispatch failed'); }
  }

  /** Best-effort blacklist of a cancelled release. Skips when no identifiers are present. */
  private async blacklistCancelledRelease(download: DownloadWithBook): Promise<void> {
    if (!this.blacklistService) return;
    if (!download.infoHash && !download.guid) {
      this.log.info({ id: download.id }, 'Blacklist skipped — no infoHash or guid');
      return;
    }
    try {
      await this.blacklistService.create({
        infoHash: download.infoHash,
        guid: download.guid,
        title: download.title,
        bookId: download.bookId ?? undefined,
        reason: 'user_cancelled',
        blacklistType: 'permanent',
      });
    } catch (error: unknown) {
      this.log.warn(error, 'Failed to blacklist release during cancel');
    }
  }

  /** Set download error with SSE dispatch. */
  async setError(id: number, errorMessage: string, meta?: { bookId?: number; oldStatus?: DownloadStatus }): Promise<void> {
    await this.downloadService.setError(id, errorMessage, meta);
    if (meta?.bookId && meta?.oldStatus) {
      emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: meta.bookId, oldStatus: meta.oldStatus, newStatus: 'failed', log: this.log });
    }
  }
}
