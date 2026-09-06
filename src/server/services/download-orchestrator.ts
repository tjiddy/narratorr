import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { DownloadService, DownloadWithBook, RetryResult } from './download.service.js';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import type { BookStatus } from '@shared/schemas/book.js';
import type { NotifierService } from './notifier.service.js';
import type { EventHistoryService, CreateEventInput } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { DownloadProtocol } from '@core/index.js';
import { eq } from 'drizzle-orm';
import { books } from '@db/schema.js';
import { revertBookStatus, transitionBookStatus } from '../utils/book-status.js';
import {
  emitGrabStarted, emitBookStatusChangeOnGrab, emitDownloadProgress,
  emitDownloadStatusChange, emitBookStatusChange, notifyGrab,
  recordGrabbedEvent, recordDownloadCompletedEvent, recordDownloadFailedEvent,
} from '../utils/download-side-effects.js';
import { serializeError } from '../utils/serialize-error.js';
import { withBookAdmissionLock, singleFlightReplace, canonicalReleaseIdentity } from './book-admission.js';
import { runReplaceWorkflow, type ReplaceCtx } from './download-replace-workflow.js';
import { gatherBookBlockers, classifyBlockers } from './download-blockers.js';
import { bookNotFoundError } from './download-errors.js';


export interface GrabParams {
  downloadUrl: string;
  title: string;
  protocol?: DownloadProtocol | undefined;
  bookId?: number | undefined;
  indexerId?: number | undefined;
  size?: number | undefined;
  seeders?: number | undefined;
  guid?: string | undefined;
  infoHash?: string | undefined;
  isFreeleech?: boolean | undefined;
  skipDuplicateCheck?: boolean | undefined;
  /** #1857 — confirmed cancel-&-replace (internal `POST /api/search/grab` only). */
  replace?: boolean | undefined;
  source?: CreateEventInput['source'] | undefined;
}

export interface GrabInnerOpts {
  /** Replace winners inherit the replaced row's pre-grab status (#1857 F6). */
  bookStatusAtGrabOverride?: BookStatus | null | undefined;
  /** Internal replace retries status writes and emits SSE only after success (F16/F22/F29). */
  bestEffortBookStatus?: boolean | undefined;
}

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

  /** Standard grab: propagate post-insert failures and serialize per-book check→add→insert (#1857 AC17). */
  async grab(params: GrabParams): Promise<DownloadWithBook> {
    if (!params.bookId) return this.grabWithinAdmissionLock(params, {});
    return withBookAdmissionLock(params.bookId, () => this.grabWithinAdmissionLock(params, {}));
  }

  /** Internal route adds confirmed replace with single-flight, mutex, and claim-first protocol (#1857). */
  async grabInternal(params: GrabParams): Promise<DownloadWithBook> {
    if (!params.bookId) {
      return this.grabWithinAdmissionLock(params, {});
    }
    if (params.replace) return this.grabWithReplace(params);
    return withBookAdmissionLock(params.bookId, () => this.grabWithinAdmissionLock(params, {}));
  }

  /** Retry rechecks blockers under one book mutex, then uses the unlocked primitive to avoid self-deadlock. */
  async grabForRetry(params: GrabParams): Promise<DownloadWithBook | 'already_active'> {
    const bookId = params.bookId;
    if (!bookId) return this.grabWithinAdmissionLock(params, {});
    return withBookAdmissionLock(bookId, async () => {
      if (await this.hasGrabBlocker(bookId)) return 'already_active';
      return this.grabWithinAdmissionLock(params, {});
    });
  }

  /** Consolidated #1861 blocker set used by both retry's early and in-lock checks. */
  async hasGrabBlocker(bookId: number): Promise<boolean> {
    return classifyBlockers(await gatherBookBlockers(this.db, bookId)).kind !== 'clear';
  }

  private async grabWithReplace(params: GrabParams): Promise<DownloadWithBook> {
    const bookId = params.bookId!;
    const key = `${bookId}::${canonicalReleaseIdentity(params)}`;
    const { downloadId } = await singleFlightReplace(key, () =>
      withBookAdmissionLock(bookId, () => runReplaceWorkflow(this.replaceCtx(), params)));
    const download = await this.downloadService.getById(downloadId);
    if (!download) throw new Error(`Replacement download ${downloadId} not found after grab`);
    return download;
  }

  private replaceCtx(): ReplaceCtx {
    return {
      db: this.db,
      log: this.log,
      downloadService: this.downloadService,
      broadcaster: this.broadcaster,
      eventHistory: this.eventHistory,
      blacklistService: this.blacklistService,
      grab: (params, opts) => this.grabWithinAdmissionLock(params, opts),
      safe: (fn) => this.safe(fn),
    };
  }

  /** Unlocked primitive: callers must hold or establish the per-book admission mutex (#1857 F31). */
  private async grabWithinAdmissionLock(params: GrabParams, opts: GrabInnerOpts): Promise<DownloadWithBook> {
    const bookStatusAtGrab = await this.resolveBookStatusAtGrab(params, opts);

    const download = await this.downloadService.grab({ ...params, bookStatusAtGrab });

    const isHandoff = !download.externalId;
    const protocol = params.protocol ?? 'torrent';

    if (params.bookId) {
      const bookStatus = isHandoff ? 'missing' as const : 'downloading' as const;
      const written = await this.writeBookStatusOnGrab(params.bookId, bookStatus, opts.bestEffortBookStatus ?? false);

      this.safe(() => emitGrabStarted({ broadcaster: this.broadcaster, downloadId: download.id, bookId: params.bookId!, bookTitle: params.title, releaseTitle: params.title, log: this.log }));
      // Emit only committed transitions; oldStatus is the captured pre-grab lifecycle (F29).
      if (written) {
        this.safe(() => emitBookStatusChangeOnGrab({ broadcaster: this.broadcaster, bookId: params.bookId!, isHandoff, oldStatus: bookStatusAtGrab, log: this.log }));
      }
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
   * Captures pre-grab intent (#1144) and refuses a stale reference (#2604 AC1).
   *
   * The existence check is unconditional and keyed on `bookId !== undefined`, not truthiness: the
   * replace path supplies `bookStatusAtGrabOverride` and used to skip the read entirely, which is
   * how a deleted book's id reached the `downloads` insert and turned an FK violation into a raw
   * drizzle message carrying every bound param. Refusing here — above `downloadService.grab` —
   * means no torrent reaches the client and no compensation path is entered.
   */
  private async resolveBookStatusAtGrab(params: GrabParams, opts: GrabInnerOpts): Promise<BookStatus | null> {
    const override = opts.bookStatusAtGrabOverride;
    if (params.bookId === undefined) return override ?? null;

    // `books.id` is a DB-assigned autoincrement rowid and no insert site supplies one, so a
    // non-positive id cannot resolve — refuse it without spending a query.
    if (params.bookId <= 0) throw bookNotFoundError();

    const row = await this.db
      .select({ status: books.status })
      .from(books)
      .where(eq(books.id, params.bookId))
      .limit(1);
    if (row.length === 0) throw bookNotFoundError();

    return override !== undefined ? override : ((row[0]?.status ?? null) as BookStatus | null);
  }

  /**
   * Standard status writes propagate; internal replace retries twice and suppresses SSE on failure.
   * The download row remains authoritative over this display projection (F16/F22/F29/AC14).
   */
  private async writeBookStatusOnGrab(bookId: number, status: BookStatus, bestEffort: boolean): Promise<boolean> {
    if (!bestEffort) {
      await transitionBookStatus(this.db, bookId, { status });
      return true;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await transitionBookStatus(this.db, bookId, { status });
        return true;
      } catch (error: unknown) {
        this.log.warn({ error: serializeError(error), bookId, attempt }, 'Replace book-status write failed (retrying)');
      }
    }
    this.log.warn({ bookId, status }, 'Replace book-status write failed after retries — display status stale (operator-visible degraded)');
    return false;
  }

  async cancel(id: number): Promise<boolean> {
    const download = await this.downloadService.getById(id);
    if (!download) return false;

    const oldStatus = download.status;
    const oldBookStatus: BookStatus = download.book?.status ?? 'downloading';

    const cancelled = await this.downloadService.cancel(id);
    if (!cancelled) return false;

    await this.blacklistCancelledRelease(download);

    if (download.bookId) {
      try {
        // Restore captured pre-grab intent, never a path-inferred guess.
        const revertStatus = await revertBookStatus(this.db, { id: download.bookId }, download.bookStatusAtGrab ?? null);
        this.safe(() => emitBookStatusChange({ broadcaster: this.broadcaster, bookId: download.bookId!, oldStatus: oldBookStatus, newStatus: revertStatus, log: this.log }));
      } catch (revertError: unknown) {
        this.log.warn({ error: serializeError(revertError) }, 'Failed to revert book status during cancel');
      }
      this.safe(() => emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: download.bookId!, oldStatus, newStatus: 'failed', log: this.log }));
      this.safe(() => recordDownloadFailedEvent({ eventHistory: this.eventHistory, downloadId: id, bookId: download.bookId!, bookTitle: download.title, errorMessage: 'Cancelled by user', log: this.log }));
    }
    // Orphans have no book state or history to invalidate.

    return true;
  }

  /** DownloadService retry re-enters this orchestrator through retrySearchDeps. */
  async retry(id: number): Promise<RetryResult> {
    return this.downloadService.retry(id);
  }

  async updateProgress(id: number, progress: number, bookId?: number): Promise<void> {
    await this.downloadService.updateProgress(id, progress, bookId);

    if (bookId) {
      emitDownloadProgress({ broadcaster: this.broadcaster, downloadId: id, bookId, progress, log: this.log });

      if (progress >= 1) {
        emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId, oldStatus: 'downloading', newStatus: 'completed', log: this.log });
        const dl = await this.downloadService.getById(id);
        recordDownloadCompletedEvent({ eventHistory: this.eventHistory, downloadId: id, bookId, bookTitle: dl?.title ?? '', log: this.log });
      }
    }
  }

  private safe(fn: () => void): void {
    try { fn(); } catch (error: unknown) { this.log.warn({ error: serializeError(error) }, 'Side-effect dispatch failed'); }
  }

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
      this.log.warn({ error: serializeError(error) }, 'Failed to blacklist release during cancel');
    }
  }

  async setError(id: number, errorMessage: string, meta?: { bookId?: number; bookTitle?: string; oldStatus?: DownloadStatus }): Promise<void> {
    await this.downloadService.setError(id, errorMessage, meta);
    if (meta?.bookId && meta?.oldStatus) {
      emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: meta.bookId, oldStatus: meta.oldStatus, newStatus: 'failed', log: this.log });
    }
    if (meta?.bookId) {
      this.safe(() => recordDownloadFailedEvent({ eventHistory: this.eventHistory, downloadId: id, bookId: meta.bookId!, bookTitle: meta.bookTitle ?? '', errorMessage, log: this.log }));
    }
  }
}
