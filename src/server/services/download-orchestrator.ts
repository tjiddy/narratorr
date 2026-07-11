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

/** Per-grab knobs for the unlocked inner grab primitive (#1857). */
export interface GrabInnerOpts {
  /** When set, inherit this snapshot instead of capturing the book's current
   *  status (the replace winner inherits the replaced row's snapshot, F6). */
  bookStatusAtGrabOverride?: BookStatus | null | undefined;
  /** When true (internal replace path only), the post-insert `books.status`
   *  write is best-effort + bounded-retry and the SSE fires only on success
   *  (F16/F22/F29); v1 + auto callers keep today's propagation. */
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

  /**
   * Grab for v1 / RSS / retrySearch / search-pipeline callers (propagating
   * post-insert failures). Serialized by the per-`bookId` admission mutex around
   * the shared check→add→insert (AC17). Since #1861 every caller runs the ONE
   * consolidated blocker classification in `DownloadService.checkDuplicateDownloads`.
   */
  async grab(params: GrabParams): Promise<DownloadWithBook> {
    if (!params.bookId) return this.grabWithinAdmissionLock(params, {});
    return withBookAdmissionLock(params.bookId, () => this.grabWithinAdmissionLock(params, {}));
  }

  /**
   * Grab for the internal `POST /api/search/grab` route (#1857): the same
   * consolidated blocker classification as every other caller and — with
   * `replace: true` — the confirmed cancel-&-replace workflow (single-flight
   * coalescing + per-book mutex + claim-first protocol).
   */
  async grabInternal(params: GrabParams): Promise<DownloadWithBook> {
    if (!params.bookId) {
      // Orphan grab — no book to lock; the blocker classification is a no-op without a bookId.
      return this.grabWithinAdmissionLock(params, {});
    }
    if (params.replace) return this.grabWithReplace(params);
    return withBookAdmissionLock(params.bookId, () => this.grabWithinAdmissionLock(params, {}));
  }

  /**
   * Retry-search grab (#1857 AC17): acquire the book mutex ONCE, recheck for any
   * grab blocker inside it, and either report `'already_active'` (the book is
   * already served — a live download, a QG-eligible completed row, or a pending
   * auto import job) or grab via the UNLOCKED inner primitive (no self-deadlock,
   * since `skipDuplicateCheck` bypasses the guard the mutex protects).
   */
  async grabForRetry(params: GrabParams): Promise<DownloadWithBook | 'already_active'> {
    const bookId = params.bookId;
    if (!bookId) return this.grabWithinAdmissionLock(params, {});
    return withBookAdmissionLock(bookId, async () => {
      if (await this.hasGrabBlocker(bookId)) return 'already_active';
      return this.grabWithinAdmissionLock(params, {});
    });
  }

  /**
   * True when the book has ANY grab blocker (#1861): a client-stage replaceable
   * row, a pipeline-stage row, a QG-eligible completed row, OR a pending/processing
   * auto import job — the exact set the consolidated classifier treats as
   * non-`clear`. The early retry precheck seam AND the retry in-lock recheck.
   */
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

  /**
   * UNLOCKED grab primitive — the shared check→add→insert body plus side-effect
   * orchestration, with the mutex STRIPPED (F31). Callers must already hold (or be
   * establishing) the per-book admission mutex. Wraps DownloadService.grab() with:
   * book status update → grab_started SSE → book_status_change SSE (on write success)
   * → notification → event recording.
   */
  private async grabWithinAdmissionLock(params: GrabParams, opts: GrabInnerOpts): Promise<DownloadWithBook> {
    // Capture pre-grab book.status BEFORE downloadService.grab (unless inheriting an
    // explicit snapshot) — the quality gate needs the user's pre-grab intent (#1144).
    let bookStatusAtGrab: BookStatus | null = opts.bookStatusAtGrabOverride ?? null;
    if (params.bookId && opts.bookStatusAtGrabOverride === undefined) {
      const row = await this.db
        .select({ status: books.status })
        .from(books)
        .where(eq(books.id, params.bookId))
        .limit(1);
      bookStatusAtGrab = (row[0]?.status ?? null) as BookStatus | null;
    }

    // Core grab — let errors (including duplicate detection) propagate
    const download = await this.downloadService.grab({ ...params, bookStatusAtGrab });

    // Side effects — each independently guarded, errors don't affect grab result
    const isHandoff = !download.externalId;
    const protocol = params.protocol ?? 'torrent';

    if (params.bookId) {
      const bookStatus = isHandoff ? 'missing' as const : 'downloading' as const;
      const written = await this.writeBookStatusOnGrab(params.bookId, bookStatus, opts.bestEffortBookStatus ?? false);

      this.safe(() => emitGrabStarted({ broadcaster: this.broadcaster, downloadId: download.id, bookId: params.bookId!, bookTitle: params.title, releaseTitle: params.title, log: this.log }));
      // book_status_change SSE fires ONLY when the status write landed (F29) — a
      // failed write must not broadcast a transition the DB never committed. Old_status
      // uses the captured pre-grab lifecycle so a re-grab reports the true transition.
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
   * Write `books.status` after a grab. Default (v1/auto/normal): await the write,
   * a throw propagates (unchanged, F16) → always returns `true`. Best-effort
   * (internal replace path): bounded-retry, return whether it landed so the SSE can
   * be suppressed on persistent failure (F22/F29). `books.status` is a display
   * projection — the download row is the source of truth (AC14).
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

  /**
   * Cancel a download with side-effect orchestration.
   * Prefetches download+book context, delegates to DownloadService.cancel(),
   * then dispatches book status revert + SSE events.
   */
  async cancel(id: number): Promise<boolean> {
    // Prefetch context for side effects
    const download = await this.downloadService.getById(id);
    if (!download) return false;

    const oldStatus = download.status;
    const oldBookStatus: BookStatus = download.book?.status ?? 'downloading';

    // Core cancel
    const cancelled = await this.downloadService.cancel(id);
    if (!cancelled) return false;

    // Blacklist the release (best-effort — failure must not block cancel)
    await this.blacklistCancelledRelease(download);

    // Side effects — each independently guarded
    if (download.bookId) {
      try {
        // Restore the explicit pre-grab lifecycle (the captured snapshot), never a
        // path-inferred guess — a book that was failed/missing before the grab is
        // restored to that exact state.
        const revertStatus = await revertBookStatus(this.db, { id: download.bookId }, download.bookStatusAtGrab ?? null);
        this.safe(() => emitBookStatusChange({ broadcaster: this.broadcaster, bookId: download.bookId!, oldStatus: oldBookStatus, newStatus: revertStatus, log: this.log }));
      } catch (revertError: unknown) {
        this.log.warn({ error: serializeError(revertError) }, 'Failed to revert book status during cancel');
      }
      this.safe(() => emitDownloadStatusChange({ broadcaster: this.broadcaster, downloadId: id, bookId: download.bookId!, oldStatus, newStatus: 'failed', log: this.log }));
      this.safe(() => recordDownloadFailedEvent({ eventHistory: this.eventHistory, downloadId: id, bookId: download.bookId!, bookTitle: download.title, errorMessage: 'Cancelled by user', log: this.log }));
    }
    // Orphaned downloads (no bookId) skip SSE and event recording — no book to invalidate

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

  /** Run a side-effect function, catching and logging any error. */
  private safe(fn: () => void): void {
    try { fn(); } catch (error: unknown) { this.log.warn({ error: serializeError(error) }, 'Side-effect dispatch failed'); }
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
      this.log.warn({ error: serializeError(error) }, 'Failed to blacklist release during cancel');
    }
  }

  /** Set download error with SSE dispatch and event recording. */
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
