import { EventEmitter } from 'node:events';
import { eq, and, asc } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/index.js';
import { importSubmissions, importSubmissionItems } from '../../db/schema.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import { OwnedRecordingError, type BookService } from './book.service.js';
import { ASIN_UNIQUE_VIOLATION } from './book-dedup.js';
import { isUniqueViolation } from '../../shared/error-message.js';
import type { BookImportService } from './book-import.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { classifyConfirmItem } from './import-confirm-item.helpers.js';
import { buildBookCreatePayload } from './enrichment-orchestration.helpers.js';
import type { ImportConfirmItem } from './library-scan.service.js';
import type { ManualImportJobPayload } from './import-adapters/types.js';
import { aggregateDispositions, stagedImportItemSchema, type ItemDisposition } from '../../core/import-staging/schemas.js';

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
}

export interface ImportSubmissionRunnerDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  bookImportService: BookImportService;
  eventHistory: EventHistoryService;
  nudgeImportWorker: () => void;
}

/**
 * Server-owned processing of finalized staged submissions (#1893). Mirrors
 * `ImportQueueWorker`'s single-guarded-lane drain idiom (nudge coalescing +
 * re-entrancy guard + safety poll + F72 pre-claim stop barrier / awaited launched
 * drain). Each proceeding item resolves enrichment OUTSIDE the tx, then runs
 * placeholder insert + enqueue + a CAS-guarded disposition write in ONE tx; the
 * final item's disposition + header `complete` + terminal aggregates commit
 * together. Held/skipped/failed write only a disposition. Boot auto-resume drains
 * any 'processing' submission from its first 'pending' item.
 */
export class ImportSubmissionRunner {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly bookService: BookService;
  private readonly bookImportService: BookImportService;
  private readonly eventHistory: EventHistoryService;
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
    this.nudgeImportWorker = deps.nudgeImportWorker;
  }

  /** Nudge the runner to look for finalized submissions to process. */
  nudge(): void {
    if (!this.stopping) this.emitter.emit('nudge');
  }

  /** Start: enter the drain loop (boot auto-resume drains any 'processing' submission). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.emitter.on('nudge', () => this.requestDrain());
    this.pollTimer = setInterval(() => this.requestDrain(), SAFETY_POLL_INTERVAL_MS);
    this.requestDrain();
  }

  /** Graceful stop: stop accepting nudges, await the launched drain (F72). */
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
      await this.db.transaction((tx) => this.maybeComplete(tx, sub.id));
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

    // The ENTIRE per-item pipeline (payload validation, classification, enrichment
    // resolution, accepted tx) runs under one error boundary (F3): an unexpected
    // classifier/read/preparation throw becomes a terminal `failed` for THIS row and
    // the drain continues — it must never bubble to the drain loop, strand the row
    // `pending`, and re-run forever on the safety poll.
    try {
      // Persisted staged JSON is untrusted at the read boundary — SQLite does not
      // enforce Drizzle's compile-time `$type`, so parse with the canonical schema
      // (F5). A missing or malformed payload is a terminal `failed`, not a crash.
      const parsed = row.itemPayload == null ? null : stagedImportItemSchema.safeParse(row.itemPayload);
      if (parsed == null || !parsed.success) {
        await this.writeTerminal(sub, row, {
          disposition: 'failed',
          reason: parsed == null ? 'Staged item payload missing.' : 'Staged item payload failed validation.',
        });
        return true;
      }
      const item = parsed.data as ImportConfirmItem;

      const classification = await classifyConfirmItem(item, this.bookService, this.log);
      if (classification !== 'proceed' && 'skip' in classification) {
        await this.writeTerminal(sub, row, {
          disposition: 'skipped',
          reason: 'already-in-library',
          ...(classification.existingBookId !== undefined && { existingBookId: classification.existingBookId }),
          ...(classification.existingTitle !== undefined && { existingTitle: classification.existingTitle }),
        });
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

      await this.acceptItem(sub, row, item);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), submissionId: sub.id, ordinal: row.ordinal }, 'Staged import item preparation failed');
      await this.writeTerminal(sub, row, { disposition: 'failed', reason: 'Import failed — see server logs for details.' });
    }
    return true;
  }

  /**
   * Accepted path: resolve enrichment OUTSIDE the tx, then insert placeholder +
   * enqueue + CAS disposition (+ maybe-complete) in ONE tx. Post-commit best-effort
   * side effects (info log, genre telemetry, one `book_added` event, worker nudge)
   * re-homed here. Rolls back to `pending` on any failure — no orphan.
   */
  private async acceptItem(sub: SubmissionRow, row: ItemRow, item: ImportConfirmItem): Promise<void> {
    const resolved = await this.bookService.resolveCreateInput(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));
    let createdBookId: number | undefined;
    try {
      await this.db.transaction(async (tx) => {
        const bookId = await this.bookService.createResolved(resolved, tx);
        const payload: ManualImportJobPayload = { ...item };
        if (sub.mode) payload.mode = sub.mode;
        const enqueued = await this.bookImportService.enqueue({ bookId, type: 'manual', metadata: JSON.stringify(payload) }, tx);
        if ('error' in enqueued) throw new ActiveJobConflict();

        const claim = await tx
          .update(importSubmissionItems)
          .set({ disposition: 'accepted', bookId, reason: null, updatedAt: new Date() })
          .where(and(eq(importSubmissionItems.id, row.id), eq(importSubmissionItems.disposition, 'pending')));
        if (getRowsAffected(claim) !== 1) throw new AlreadyDispositioned();

        createdBookId = bookId;
        await this.maybeComplete(tx, sub.id);
      });
    } catch (error: unknown) {
      // Same-ASIN create-time race (F2). `createResolved(resolved, tx)` runs on our
      // transaction handle and, by contract, PROPAGATES the raw ASIN unique violation
      // (it cannot do the incumbent lookup against an uncommitted caller tx) — so the
      // tx path never yields an `OwnedRecordingError`. After this tx has rolled back,
      // detect the raw violation and resolve the incumbent ourselves via
      // `findAsinCollision` (sentinel -1: no self-row to exclude), then record the
      // specified `already-in-library` skip carrying the incumbent id/title.
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
        // Defensive: the non-tx `createResolved` path maps the race to this typed
        // error. Unreachable via the tx path above but kept so a future contract
        // change fails closed to the same skip outcome.
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
    // The book_added event lookup/record is BEST-EFFORT (F49): a rejected getById must
    // NOT escape and suppress the durable-job nudge below — a committed accepted import
    // would then wait for the queue worker's safety poll. Guard the whole event path and
    // always fire the worker nudge.
    try {
      const book = await this.bookService.getById(createdBookId);
      if (book) {
        this.eventHistory
          .create({ bookId: book.id, ...snapshotBookForEvent(book), eventType: 'book_added', source: 'manual' })
          .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));
      }
    } catch (err: unknown) {
      this.log.warn({ error: serializeError(err), submissionId: sub.id, ordinal: row.ordinal }, 'Failed to record book_added event — book lookup failed');
    }
    this.nudgeImportWorker();
  }

  /** CAS-guarded disposition write for a held/skipped/failed item + maybe-complete, in one tx. */
  private async writeTerminal(sub: SubmissionRow, row: ItemRow, write: TerminalWrite): Promise<void> {
    await this.db.transaction(async (tx) => {
      const claim = await tx
        .update(importSubmissionItems)
        .set({
          disposition: write.disposition,
          reason: write.reason ?? null,
          existingBookId: write.existingBookId ?? null,
          existingTitle: write.existingTitle ?? null,
          updatedAt: new Date(),
        })
        .where(and(eq(importSubmissionItems.id, row.id), eq(importSubmissionItems.disposition, 'pending')));
      if (getRowsAffected(claim) !== 1) return; // already dispositioned by another pass
      await this.maybeComplete(tx, sub.id);
    });
  }

  /**
   * When no 'pending' items remain, freeze the terminal aggregates and CAS-flip the
   * header 'processing' → 'complete' (idempotent). Runs inside the same tx as the
   * final item's disposition write, so the outcome record commits atomically.
   */
  private async maybeComplete(tx: DbOrTx, submissionId: number): Promise<void> {
    const [stillPending] = await tx
      .select({ id: importSubmissionItems.id })
      .from(importSubmissionItems)
      .where(and(eq(importSubmissionItems.submissionId, submissionId), eq(importSubmissionItems.disposition, 'pending')))
      .limit(1);
    if (stillPending) return;

    const rows = await tx
      .select({ disposition: importSubmissionItems.disposition })
      .from(importSubmissionItems)
      .where(eq(importSubmissionItems.submissionId, submissionId));
    // One shared disposition→aggregate mapping with computeProgress (F13).
    const agg = aggregateDispositions(rows.map((r) => r.disposition as ItemDisposition));
    const now = new Date();
    await tx
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
      .where(and(eq(importSubmissions.id, submissionId), eq(importSubmissions.status, 'processing')));
  }
}
