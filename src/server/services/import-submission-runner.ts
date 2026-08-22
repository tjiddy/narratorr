import { EventEmitter } from 'node:events';
import { eq, and, asc } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/index.js';
import { importSubmissions, importSubmissionItems } from '@db/schema.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { announceBookAdded, bookAddedSnapshotEvent } from '../utils/event-helpers.js';
import { OwnedRecordingError, type BookService } from './book.service.js';
import { ASIN_UNIQUE_VIOLATION } from './book-dedup.js';
import { isUniqueViolation } from '@shared/error-message.js';
import type { BookImportService } from './book-import.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { NotifierService } from './notifier.service.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { classifyConfirmItem, type AttachClassification } from './import-confirm-item.helpers.js';
import { attachTransitionAndEnqueue, AttachGuardMissed, isAttachActiveJobConflict } from './attach-enqueue.js';
import { buildBookCreatePayload } from './enrichment-orchestration.helpers.js';
import { readOpfMetadata } from '../utils/opf-reader.js';
import { applyOpfOverlay } from './import-opf-overlay.js';
import type { ImportConfirmItem } from './library-scan.service.js';
import type { ManualImportJobPayload, NarratorSource } from './import-adapters/types.js';
import { aggregateDispositions, stagedImportItemSchema, type ItemDisposition, type SubmissionAggregates, type SubmissionSource } from '@core/import-staging/schemas.js';

const SAFETY_POLL_INTERVAL_MS = 30_000;

type SubmissionRow = typeof importSubmissions.$inferSelect;
type ItemRow = typeof importSubmissionItems.$inferSelect;

/** Signals a rollback of the accepted-item tx because an active job already exists. */
class ActiveJobConflict extends Error {}
/** Signals a rollback because another pass already dispositioned the ordinal (CAS lost). */
class AlreadyDispositioned extends Error {}

interface TerminalWrite {
  disposition: Exclude<ItemDisposition, 'pending' | 'accepted'>;
  reason?: string;
  existingBookId?: number;
  existingTitle?: string;
  /** #2091 snapshot of the incumbent's folder, taken at confirm time and never re-resolved. */
  existingPath?: string;
}

/** Returned only to the winning completion CAS so notification dispatch happens post-commit. */
export interface CompletionNotice {
  source: SubmissionSource;
  counts: SubmissionAggregates;
}

export interface ImportSubmissionRunnerDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  bookImportService: BookImportService;
  eventHistory: EventHistoryService;
  notifier: NotifierService;
  nudgeImportWorker: () => void;
}

// Single-lane, nudge-coalesced drain with a safety poll and pre-claim stop barrier.
// Enrichment runs outside the accepted-item transaction; creation, enqueue, disposition, and final completion commit atomically.
// Boot resumes any processing submission from its first pending item.
export class ImportSubmissionRunner {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly bookService: BookService;
  private readonly bookImportService: BookImportService;
  private readonly eventHistory: EventHistoryService;
  private readonly notifier: NotifierService;
  private readonly nudgeImportWorker: () => void;
  private readonly emitter = new EventEmitter();
  private running = false;
  private stopping = false;
  private drainInProgress = false;
  private drainRequested = false;
  private runDrainPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ImportSubmissionRunnerDeps) {
    this.db = deps.db;
    this.log = deps.log.child({ component: 'ImportSubmissionRunner' });
    this.bookService = deps.bookService;
    this.bookImportService = deps.bookImportService;
    this.eventHistory = deps.eventHistory;
    this.notifier = deps.notifier;
    this.nudgeImportWorker = deps.nudgeImportWorker;
  }

  // Dispatch one post-commit best-effort notification without letting an initial notify query rejection abort the drain.
  private dispatchCompletion(notice: CompletionNotice): void {
    fireAndForget(
      this.notifier.notify('import_run_finished', {
        event: 'import_run_finished',
        submission: { source: notice.source, status: 'complete', counts: notice.counts },
      }),
      this.log,
      'Failed to dispatch import_run_finished notification',
    );
  }

  nudge(): void {
    if (!this.stopping) this.emitter.emit('nudge');
  }

  /** Start polling and resume submissions left processing by a prior boot. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.emitter.on('nudge', () => this.requestDrain());
    this.pollTimer = setInterval(() => this.requestDrain(), SAFETY_POLL_INTERVAL_MS);
    this.requestDrain();
  }

  /** Stop accepting work and await the launched drain. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.emitter.removeAllListeners('nudge');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.runDrainPromise;
  }

  private requestDrain(): void {
    if (!this.running || this.stopping) return;
    if (this.drainInProgress) {
      this.drainRequested = true;
      return;
    }
    this.drainInProgress = true;
    this.runDrainPromise = this.runDrain();
  }

  private async runDrain(): Promise<void> {
    try {
      do {
        this.drainRequested = false;
        let processed = true;
        while (processed && this.running && !this.stopping) {
          processed = await this.drainOne();
        }
      } while (this.drainRequested && this.running && !this.stopping);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error) }, 'Submission drain runner failed unexpectedly');
    } finally {
      this.drainInProgress = false;
    }
  }

  /** Process one pending item of the oldest 'processing' submission; false when none remain. */
  private async drainOne(): Promise<boolean> {
    const [sub] = await this.db
      .select()
      .from(importSubmissions)
      .where(eq(importSubmissions.status, 'processing'))
      .orderBy(asc(importSubmissions.createdAt))
      .limit(1);
    if (!sub) return false;

    // Pre-claim stop barrier (F72 mirror): abort before touching the item.
    if (this.stopping || !this.running) return false;

    const processed = await this.processOnePending(sub);
    if (!processed) {
      // A 'processing' submission with no pending items → complete it (boot-resume safety).
      const notice = await this.db.transaction((tx) => this.maybeComplete(tx, sub));
      if (notice) this.dispatchCompletion(notice);
      return true;
    }
    return true;
  }

  private async processOnePending(sub: SubmissionRow): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(importSubmissionItems)
      .where(and(eq(importSubmissionItems.submissionId, sub.id), eq(importSubmissionItems.disposition, 'pending')))
      .orderBy(asc(importSubmissionItems.ordinal))
      .limit(1);
    if (!row) return false;

    // One item-level boundary converts preparation failures to terminal rows so the safety poll cannot retry forever.
    try {
      // SQLite does not enforce Drizzle's payload type; validate persisted JSON before classification.
      const parsed = row.itemPayload == null ? null : stagedImportItemSchema.safeParse(row.itemPayload);
      if (parsed == null || !parsed.success) {
        await this.writeTerminal(sub, row, {
          disposition: 'failed',
          reason: parsed == null ? 'Staged item payload missing.' : 'Staged item payload failed validation.',
        });
        return true;
      }
      const staged = parsed.data as ImportConfirmItem;

      // Overlay OPF once before classification so matching, creation, collision checks, and the job payload share it.
      // Read the source folder: copy/move staging carries audio only, never metadata.opf, into the target.
      const { item, narratorSource } = applyOpfOverlay(staged, await readOpfMetadata(staged.path, this.log));

      const classification = await classifyConfirmItem(item, this.bookService, this.log);
      if (classification !== 'proceed' && 'skip' in classification) {
        await this.writeTerminal(sub, row, {
          disposition: 'skipped',
          reason: classification.reason,
          ...(classification.existingBookId !== undefined && { existingBookId: classification.existingBookId }),
          ...(classification.existingTitle !== undefined && { existingTitle: classification.existingTitle }),
          ...(classification.existingPath !== undefined && { existingPath: classification.existingPath }),
        });
        return true;
      }
      if (classification !== 'proceed' && 'attach' in classification) {
        // narratorSource is deliberately dropped: it describes the OFFERED item's narrators, and
        // AC28's attach rule keys on the incumbent's own list, so it decides nothing here.
        await this.acceptAttachItem(sub, row, item, classification);
        return true;
      }
      if (classification !== 'proceed') {
        await this.writeTerminal(sub, row, {
          disposition: 'held',
          reason: 'recording-review-required',
          ...(classification.existingBookId !== undefined && { existingBookId: classification.existingBookId }),
        });
        return true;
      }

      await this.acceptItem(sub, row, item, narratorSource);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), submissionId: sub.id, ordinal: row.ordinal }, 'Staged import item preparation failed');
      await this.writeTerminal(sub, row, { disposition: 'failed', reason: 'Import failed — see server logs for details.' });
    }
    return true;
  }

  /**
   * #2435 AC5 — the incumbent already exists, so nothing is created: no `resolveCreateInput`, no
   * `createResolved`, no `book_added`. The guarded transition, the enqueue and the claim share one
   * transaction (AC26), and the nudge fires only after it commits.
   *
   * The payload carries the source path, the submission's mode and the attach marker, and nothing
   * else: under AC23/AC27 the adapter renders naming and enrichment from the incumbent row, so an
   * item passed through unchanged would file a user-edited book under the provider's title.
   */
  private async acceptAttachItem(
    sub: SubmissionRow, row: ItemRow, item: ImportConfirmItem, classification: AttachClassification,
  ): Promise<void> {
    const payload: ManualImportJobPayload = {
      path: item.path,
      title: classification.title,
      attach: true,
      ...(sub.mode ? { mode: sub.mode } : {}),
    };
    let notice: CompletionNotice | null;
    try {
      notice = await this.db.transaction(async (tx) => {
        await attachTransitionAndEnqueue(tx, this.bookImportService, {
          bookId: classification.bookId,
          expectedStatus: classification.status,
          metadata: JSON.stringify(payload),
        });

        const claim = await tx
          .update(importSubmissionItems)
          .set({ disposition: 'accepted', bookId: classification.bookId, reason: null, updatedAt: new Date() })
          .where(and(eq(importSubmissionItems.id, row.id), eq(importSubmissionItems.disposition, 'pending')));
        if (getRowsAffected(claim) !== 1) throw new AlreadyDispositioned();

        return this.maybeComplete(tx, sub);
      });
    } catch (error: unknown) {
      if (error instanceof AlreadyDispositioned) return; // another pass already handled it
      // A missed guard means a competing writer took the book; both it and the active-job race
      // report the same thing to the operator — someone else is already importing this book.
      if (error instanceof AttachGuardMissed || isAttachActiveJobConflict(error)) {
        await this.writeTerminal(sub, row, { disposition: 'skipped', reason: 'already-importing' });
        return;
      }
      this.log.error({ error: serializeError(error), submissionId: sub.id, ordinal: row.ordinal, bookId: classification.bookId }, 'Staged import item attach failed');
      await this.writeTerminal(sub, row, { disposition: 'failed', reason: 'Import failed — see server logs for details.' });
      return;
    }

    this.log.info({ submissionId: sub.id, ordinal: row.ordinal, bookId: classification.bookId, title: classification.title }, 'Staged import item attached to existing book');
    this.nudgeImportWorker();
    if (notice) this.dispatchCompletion(notice);
  }

  // Resolve enrichment outside the transaction; create, enqueue, claim, and maybe-complete inside it or roll back to pending.
  // Logging, telemetry, book_added, worker nudge, and completion notification are post-commit.
  private async acceptItem(sub: SubmissionRow, row: ItemRow, item: ImportConfirmItem, narratorSource: NarratorSource): Promise<void> {
    const resolved = await this.bookService.resolveCreateInput(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));
    let createdBookId: number | undefined;
    let notice: CompletionNotice | null;
    try {
      notice = await this.db.transaction(async (tx) => {
        const bookId = await this.bookService.createResolved(resolved, tx);
        // The manual job schema declares runner-computed narratorSource and mode so re-parsing cannot strip them.
        const payload: ManualImportJobPayload = { ...item, narratorSource };
        if (sub.mode) payload.mode = sub.mode;
        const enqueued = await this.bookImportService.enqueue({ bookId, type: 'manual', metadata: JSON.stringify(payload) }, tx);
        if ('error' in enqueued) throw new ActiveJobConflict();

        const claim = await tx
          .update(importSubmissionItems)
          .set({ disposition: 'accepted', bookId, reason: null, updatedAt: new Date() })
          .where(and(eq(importSubmissionItems.id, row.id), eq(importSubmissionItems.disposition, 'pending')));
        if (getRowsAffected(claim) !== 1) throw new AlreadyDispositioned();

        createdBookId = bookId;
        return this.maybeComplete(tx, sub);
      });
    } catch (error: unknown) {
      // Caller-tx creation propagates raw ASIN conflicts because it cannot inspect an uncommitted incumbent.
      // After rollback, resolve the incumbent with sentinel -1 and record an already-in-library skip.
      if (isUniqueViolation(error, ASIN_UNIQUE_VIOLATION)) {
        const collision = await this.bookService.findAsinCollision(-1, resolved.asin ?? '');
        await this.writeTerminal(sub, row, {
          disposition: 'skipped',
          reason: 'already-in-library',
          ...(collision ? { existingBookId: collision.conflictBookId, existingTitle: collision.conflictTitle } : {}),
        });
        return;
      }
      if (error instanceof OwnedRecordingError) {
        // Defensive against a future createResolved contract that maps caller-tx conflicts to the typed error.
        await this.writeTerminal(sub, row, {
          disposition: 'skipped',
          reason: 'already-in-library',
          existingBookId: error.existingBookId,
          existingTitle: error.bookTitle,
        });
        return;
      }
      if (error instanceof ActiveJobConflict) {
        await this.writeTerminal(sub, row, { disposition: 'skipped', reason: 'already-importing' });
        return;
      }
      if (error instanceof AlreadyDispositioned) return; // another pass already handled it
      this.log.error({ error: serializeError(error), submissionId: sub.id, ordinal: row.ordinal, title: item.title }, 'Staged import item failed');
      await this.writeTerminal(sub, row, { disposition: 'failed', reason: 'Import failed — see server logs for details.' });
      return;
    }

    if (createdBookId === undefined) return;
    this.log.info({ submissionId: sub.id, ordinal: row.ordinal, bookId: createdBookId, title: item.title }, 'Staged import item accepted');
    this.bookService.trackUnmatchedGenres(resolved.genres).catch((err) => this.log.debug({ error: serializeError(err) }, 'Failed to track unmatched genres'));
    // Best-effort event lookup must not suppress the worker nudge for an already committed job.
    try {
      const book = await this.bookService.getById(createdBookId);
      if (book) {
        announceBookAdded(() => this.eventHistory.create(bookAddedSnapshotEvent(book, 'manual')), book.id, this.log);
      }
    } catch (err: unknown) {
      this.log.warn({ error: serializeError(err), submissionId: sub.id, ordinal: row.ordinal }, 'Failed to record book_added event — book lookup failed');
    }
    this.nudgeImportWorker();
    // Post-commit: dispatch once if this accepted item completed the submission.
    if (notice) this.dispatchCompletion(notice);
  }

  /** CAS-guarded disposition write for a held/skipped/failed item + maybe-complete, in one tx. */
  private async writeTerminal(sub: SubmissionRow, row: ItemRow, write: TerminalWrite): Promise<void> {
    const notice = await this.db.transaction(async (tx) => {
      const claim = await tx
        .update(importSubmissionItems)
        .set({
          disposition: write.disposition,
          reason: write.reason ?? null,
          existingBookId: write.existingBookId ?? null,
          existingTitle: write.existingTitle ?? null,
          existingPath: write.existingPath ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(importSubmissionItems.id, row.id), eq(importSubmissionItems.disposition, 'pending')));
      if (getRowsAffected(claim) !== 1) return null; // already dispositioned by another pass
      return this.maybeComplete(tx, sub);
    });
    // Post-commit: dispatch once if this terminal write completed the submission.
    if (notice) this.dispatchCompletion(notice);
  }

  // Freeze aggregates and CAS processing→complete in the final disposition transaction.
  // Only the winning CAS returns a notice, preventing post-commit notification replay.
  private async maybeComplete(tx: DbOrTx, sub: SubmissionRow): Promise<CompletionNotice | null> {
    const [stillPending] = await tx
      .select({ id: importSubmissionItems.id })
      .from(importSubmissionItems)
      .where(and(eq(importSubmissionItems.submissionId, sub.id), eq(importSubmissionItems.disposition, 'pending')))
      .limit(1);
    if (stillPending) return null;

    const rows = await tx
      .select({ disposition: importSubmissionItems.disposition })
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, sub.id));
    // One shared disposition→aggregate mapping with computeProgress (F13).
    const agg = aggregateDispositions(rows.map((r) => r.disposition as ItemDisposition));
    const now = new Date();
    const result = await tx
      .update(importSubmissions)
      .set({
        status: 'complete',
        acceptedCount: agg.accepted,
        heldCount: agg.held,
        skippedCount: agg.skipped,
        failedCount: agg.failed,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(importSubmissions.id, sub.id), eq(importSubmissions.status, 'processing')));
    if (getRowsAffected(result) !== 1) return null;
    return { source: sub.source, counts: agg };
  }
}
