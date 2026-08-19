import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { importJobs, books } from '@db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getImportAdapter } from './import-adapters/registry.js';
import type { ImportAdapterContext } from './import-adapters/types.js';
import { manualImportJobPayloadSchema } from './import-adapters/types.js';
import type { ImportJobRow } from './types.js';
import type { ImportJobPhase, ImportJobType, PhaseHistoryEntry } from '@shared/schemas/import-job.js';
import { serializeError } from '../utils/serialize-error.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { parsePhaseHistory } from '../utils/parse-phase-history.js';
import { safeEmit } from '../utils/safe-emit.js';
import { sweepCommitPendingMarkers } from '../utils/import-marker-sweep.js';
import { transitionBookStatus } from '../utils/book-status.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { OwnedRecordingError } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { finalizeForcedImportRefusal } from './import-refused.js';
import { finalizeCompletedImport, resolveBookTitle } from './import-completed.js';
import { triggerCompanionReconcile, type CompanionBookReconcileTrigger } from './companion-ebook-trigger.js';


const SAFETY_POLL_INTERVAL_MS = 30_000;
const PROGRESS_THROTTLE_MS = 250;

export class ImportQueueWorker {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly broadcaster: EventBroadcasterService | null;
  private readonly getLibraryRoot: (() => Promise<string | null | undefined>) | null;
  private readonly eventHistory: EventHistoryService | null;
  private readonly companionEbook: CompanionBookReconcileTrigger | null;
  private readonly emitter = new EventEmitter();
  private running = false;
  private stopping = false;
  private currentJobPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private drainInProgress = false;
  private drainRequested = false;
  private runDrainPromise: Promise<void> | null = null;

  /** Optional seams make marker recovery, refusal history, and companion reconciliation no-ops when absent. */
  constructor(
    db: Db,
    log: FastifyBaseLogger,
    broadcaster?: EventBroadcasterService,
    getLibraryRoot?: () => Promise<string | null | undefined>,
    eventHistory?: EventHistoryService,
    companionEbook?: CompanionBookReconcileTrigger,
  ) {
    this.db = db;
    this.log = log.child({ component: 'ImportQueueWorker' });
    this.broadcaster = broadcaster ?? null;
    this.getLibraryRoot = getLibraryRoot ?? null;
    this.eventHistory = eventHistory ?? null;
    this.companionEbook = companionEbook ?? null;
  }

  nudge(): void {
    if (!this.stopping) {
      this.emitter.emit('nudge');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    await this.bootRecovery();
    // Finish marker recovery before draining so no import races the same `.import-bak`.
    await this.sweepStrandedMarkers();
    this.drainLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.emitter.removeAllListeners('nudge');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.currentJobPromise) {
      this.log.info('Waiting for current import job to complete before shutdown…');
      await this.currentJobPromise;
    }
    // Await pre-claim drains too; an aborted claim leaves its row pending for the next boot.
    await this.runDrainPromise;
  }

  /** Requeue an orphan only when its book is still importing; otherwise fail only the job row. */
  private async bootRecovery(): Promise<void> {
    const orphans = await this.db
      .select({ id: importJobs.id, bookId: importJobs.bookId })
      .from(importJobs)
      .where(eq(importJobs.status, 'processing'));

    if (orphans.length === 0) return;

    this.log.info({ count: orphans.length }, 'Boot recovery: resolving orphaned processing jobs');

    const now = new Date();
    let requeued = 0;
    let settled = 0;
    let failed = 0;

    for (const orphan of orphans) {
      try {
        const didRequeue = await this.recoverOrphanedJob(orphan, now);
        if (didRequeue) {
          requeued++;
          this.log.info({ jobId: orphan.id, bookId: orphan.bookId }, 'Orphaned import job re-queued for retry');
        } else {
          settled++;
          this.log.info({ jobId: orphan.id, bookId: orphan.bookId }, 'Orphaned import job marked as failed');
        }
      } catch (error: unknown) {
        failed++;
        this.log.error(
          { error: serializeError(error), jobId: orphan.id, bookId: orphan.bookId },
          'Failed to recover orphaned import job',
        );
      }
    }

    this.log.info({ count: orphans.length, requeued, settled, failed }, 'Boot recovery complete');
  }

  /** Runs before draining, so the book read and job-only write are race-free in one transaction. */
  private async recoverOrphanedJob(orphan: { id: number; bookId: number | null }, now: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      let bookStatus: string | null = null;
      if (orphan.bookId != null) {
        const [bookRow] = await tx
          .select({ status: books.status })
          .from(books)
          .where(eq(books.id, orphan.bookId))
          .limit(1);
        bookStatus = bookRow?.status ?? null;
      }

      if (bookStatus === 'importing') {
        await tx.update(importJobs).set({
          status: 'pending',
          phase: 'queued',
          lastError: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        }).where(eq(importJobs.id, orphan.id));
        return true;
      }

      await tx.update(importJobs).set({
        status: 'failed',
        phase: 'failed',
        lastError: JSON.stringify({ message: 'Interrupted by server restart', type: 'ProcessRestart' }),
        completedAt: now,
        updatedAt: now,
      }).where(eq(importJobs.id, orphan.id));
      return false;
    });
  }

  /** Marker recovery is best-effort; missing configuration or traversal failures cannot block draining. */
  private async sweepStrandedMarkers(): Promise<void> {
    if (!this.getLibraryRoot) return;
    let libraryRoot: string | null | undefined;
    try {
      libraryRoot = await this.getLibraryRoot();
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Marker sweep: failed to resolve library root — skipping');
      return;
    }
    if (!libraryRoot) {
      this.log.debug('Marker sweep: no library root configured — skipping');
      return;
    }
    try {
      await sweepCommitPendingMarkers(libraryRoot, this.log);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), libraryRoot }, 'Marker sweep failed unexpectedly — continuing startup');
    }
  }

  /** Nudges and polling coalesce into one single-process drain. */
  private drainLoop(): void {
    this.emitter.on('nudge', () => this.requestDrain());

    this.pollTimer = setInterval(() => this.requestDrain(), SAFETY_POLL_INTERVAL_MS);

    this.requestDrain();
  }

  private requestDrain(): void {
    if (!this.running || this.stopping) return;
    if (this.drainInProgress) {
      this.drainRequested = true;
      return;
    }
    this.drainInProgress = true;
    this.runDrainPromise = this.runDrain(); // tracked so stop() can await it
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
      this.log.error({ error: serializeError(error) }, 'Drain runner failed unexpectedly');
    } finally {
      this.drainInProgress = false;
    }
  }

  private async drainOne(): Promise<boolean> {
    const candidates = await this.db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(eq(importJobs.status, 'pending'))
      .orderBy(importJobs.createdAt)
      .limit(1);

    if (candidates.length === 0) return false;

    const candidateId = candidates[0]!.id;

    // Recheck after SELECT so stop cannot claim a durable row.
    if (this.stopping || !this.running) return false;

    const now = new Date();
    const result = await this.db
      .update(importJobs)
      .set({ status: 'processing', startedAt: now, updatedAt: now })
      .where(and(eq(importJobs.id, candidateId), eq(importJobs.status, 'pending')));

    const rowsAffected = getRowsAffected(result);
    if (rowsAffected !== 1) {
      // Another process won the claim; retry.
      return true;
    }

    const [job] = await this.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, candidateId))
      .limit(1);

    if (!job) return true;

    const adapter = getImportAdapter(job.type);
    if (!adapter) {
      this.log.error({ jobId: job.id, type: job.type }, 'No import adapter registered for job type');
      await this.markJobFailed(job.id, job.bookId, job.phase ?? 'queued', this.extractTitle(job.metadata, job.type), JSON.stringify({ message: `No import adapter registered for type "${job.type}"`, type: 'UnknownAdapterType' }));
      return true;
    }

    const phaseHistory: PhaseHistoryEntry[] = parsePhaseHistory(job.phaseHistory, this.log, job.id);
    let currentPhase = job.phase ?? 'queued';

    const ctx: ImportAdapterContext = {
      db: this.db,
      log: this.log.child({ jobId: job.id, type: job.type }),
      setPhase: async (phase: ImportJobPhase) => {
        const nowMs = Date.now();
        const previousPhase = currentPhase;

        if (phaseHistory.length > 0) {
          const last = phaseHistory[phaseHistory.length - 1]!;
          if (last.completedAt === undefined) {
            last.completedAt = nowMs;
          }
        }

        phaseHistory.push({ phase, startedAt: nowMs });
        currentPhase = phase;

        await this.db.update(importJobs).set({
          phase,
          phaseHistory: JSON.stringify(phaseHistory),
          updatedAt: new Date(),
        }).where(eq(importJobs.id, job.id));

        safeEmit(this.broadcaster, 'import_phase_change', {
          job_id: job.id,
          book_id: job.bookId,
          book_title: this.extractTitle(job.metadata, job.type),
          from: previousPhase,
          to: phase,
        }, this.log);
      },
      emitProgress: this.createThrottledProgressEmitter(job.id, job.bookId, this.extractTitle(job.metadata, job.type)),
    };

    const startTime = Date.now();
    this.currentJobPromise = this.processJob(job.id, job.bookId, adapter, job, ctx, phaseHistory, startTime);
    try {
      await this.currentJobPromise;
    } finally {
      // Clear on rejection too, or stop() can re-await a parked rejected promise.
      this.currentJobPromise = null;
    }

    return true;
  }

  private async processJob(
    jobId: number,
    bookId: number | null,
    adapter: { process: (job: ImportJobRow, ctx: ImportAdapterContext) => Promise<void> },
    job: ImportJobRow,
    ctx: ImportAdapterContext,
    phaseHistory: PhaseHistoryEntry[],
    startTime: number,
  ): Promise<void> {
    const bookTitle = this.extractTitle(job.metadata, job.type);
    try {
      await adapter.process(job, ctx);

      await finalizeCompletedImport(
        { db: this.db, broadcaster: this.broadcaster, log: this.log },
        { jobId, bookId, bookTitle, phaseHistory, startTime },
      );

      // Completion is already durable; companion reconciliation is fire-and-forget.
      this.triggerCompanionReconcile(bookId);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), jobId, bookId }, 'Import job failed');
      if (phaseHistory.length > 0) {
        const last = phaseHistory[phaseHistory.length - 1]!;
        if (last.completedAt === undefined) {
          last.completedAt = Date.now();
        }
      }
      const currentPhase = phaseHistory.length > 0 ? phaseHistory[phaseHistory.length - 1]!.phase : 'queued';
      // Only forced jobs get the distinct refusal terminal; non-forced collisions remain generic failures.
      if (error instanceof OwnedRecordingError && this.isForcedImport(job)) {
        await finalizeForcedImportRefusal(
          { db: this.db, broadcaster: this.broadcaster, eventHistory: this.eventHistory, log: this.log },
          { jobId, bookId, currentPhase, bookTitle, error, phaseHistory },
        );
        return;
      }
      await this.markJobFailed(jobId, bookId, currentPhase, bookTitle, JSON.stringify(serializeError(error)), phaseHistory);
    }
  }

  private async markJobFailed(jobId: number, bookId: number | null, currentPhase: string, bookTitle: string, lastError: string, phaseHistory?: PhaseHistoryEntry[]): Promise<void> {
    const now = new Date();
    // Commit job failure and the guarded book transition together; emit SSE only afterward.
    await this.db.transaction(async (tx) => {
      await tx.update(importJobs).set({
        status: 'failed',
        phase: 'failed',
        lastError,
        ...(phaseHistory ? { phaseHistory: JSON.stringify(phaseHistory) } : {}),
        completedAt: now,
        updatedAt: now,
      }).where(eq(importJobs.id, jobId));

      if (bookId != null) {
        // The expected status preserves any earlier failure-path revert: a book already moved off
        // `importing` is left exactly as that path left it, so this write never overwrites it.
        await transitionBookStatus(tx, bookId, { status: 'failed', expected: { status: 'importing' } });
      }
    });

    let errorMessage: string;
    try {
      const parsed = JSON.parse(lastError);
      errorMessage = parsed.message ?? lastError;
    } catch {
      errorMessage = lastError;
    }

    const resolvedTitle = await resolveBookTitle(this.db, bookId, bookTitle);
    safeEmit(this.broadcaster, 'import_failed', {
      job_id: jobId,
      book_id: bookId,
      book_title: resolvedTitle,
      phase: currentPhase,
      error_message: errorMessage,
    }, this.log);
  }

  private triggerCompanionReconcile(bookId: number | null): void {
    if (bookId === null) return;
    triggerCompanionReconcile(this.companionEbook, bookId, this.log, 'Companion ebook reconcile failed after import');
  }

  /** Validate manual metadata before surfacing a title in SSE; auto or malformed jobs use `Unknown`. */
  private extractTitle(metadata: string, type: ImportJobType): string {
    if (type !== 'manual') return 'Unknown';

    let parsed: unknown;
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return 'Unknown';
    }

    const result = manualImportJobPayloadSchema.safeParse(parsed);
    return result.success ? result.data.title : 'Unknown';
  }

  /** The copy fence is force-independent; only a validated manual force flag qualifies as forced-refused. */
  private isForcedImport(job: ImportJobRow): boolean {
    if (job.type !== 'manual') return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(job.metadata);
    } catch {
      return false;
    }
    const result = manualImportJobPayloadSchema.safeParse(parsed);
    return result.success && result.data.forceImport === true;
  }

  private createThrottledProgressEmitter(
    jobId: number,
    bookId: number | null,
    bookTitle: string,
  ): ImportAdapterContext['emitProgress'] {
    let lastEmitTime = 0;
    return (phase, progress, byteCounter) => {
      const now = Date.now();
      if (now - lastEmitTime < PROGRESS_THROTTLE_MS) return;
      lastEmitTime = now;
      safeEmit(this.broadcaster, 'import_progress', {
        job_id: jobId,
        book_id: bookId,
        book_title: bookTitle,
        phase,
        progress,
        ...(byteCounter ? { byte_counter: byteCounter } : {}),
      }, this.log);
    };
  }
}
