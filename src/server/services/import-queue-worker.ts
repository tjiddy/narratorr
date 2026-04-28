import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { importJobs, books } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getImportAdapter } from './import-adapters/registry.js';
import type { ImportAdapterContext } from './import-adapters/types.js';
import type { ImportJobPhase, PhaseHistoryEntry } from '../../shared/schemas/import-job.js';
import { serializeError } from '../utils/serialize-error.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { safeEmit } from '../utils/safe-emit.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';


const SAFETY_POLL_INTERVAL_MS = 30_000;
const PROGRESS_THROTTLE_MS = 250;

export class ImportQueueWorker {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly broadcaster: EventBroadcasterService | null;
  private readonly emitter = new EventEmitter();
  private running = false;
  private stopping = false;
  private currentJobPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Db, log: FastifyBaseLogger, broadcaster?: EventBroadcasterService) {
    this.db = db;
    this.log = log.child({ component: 'ImportQueueWorker' });
    this.broadcaster = broadcaster ?? null;
  }

  /** Nudge the worker to check for new pending jobs. */
  nudge(): void {
    if (!this.stopping) {
      this.emitter.emit('nudge');
    }
  }

  /** Start the worker: run boot recovery, then enter the drain loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    await this.bootRecovery();
    this.drainLoop();
  }

  /** Graceful stop: stop accepting nudges, wait for current job to finish. */
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
  }

  /**
   * Boot recovery: mark any rows left in 'processing' as failed.
   * These are orphans from a previous crash.
   */
  private async bootRecovery(): Promise<void> {
    const orphans = await this.db
      .select({ id: importJobs.id, bookId: importJobs.bookId })
      .from(importJobs)
      .where(eq(importJobs.status, 'processing'));

    if (orphans.length === 0) return;

    this.log.info({ count: orphans.length }, 'Boot recovery: marking orphaned processing jobs as failed');

    const now = new Date();
    const errorJson = JSON.stringify({ message: 'Interrupted by server restart', type: 'ProcessRestart' });

    let recovered = 0;
    let failed = 0;

    for (const orphan of orphans) {
      try {
        await this.db.transaction(async (tx) => {
          await tx.update(importJobs).set({
            status: 'failed',
            phase: 'failed',
            lastError: errorJson,
            completedAt: now,
            updatedAt: now,
          }).where(eq(importJobs.id, orphan.id));

          if (orphan.bookId != null) {
            await tx.update(books).set({
              status: 'failed',
              updatedAt: now,
            }).where(eq(books.id, orphan.bookId));
          }
        });
        recovered++;
        this.log.info({ jobId: orphan.id, bookId: orphan.bookId }, 'Orphaned import job marked as failed');
      } catch (error: unknown) {
        failed++;
        this.log.error(
          { error: serializeError(error), jobId: orphan.id, bookId: orphan.bookId },
          'Failed to recover orphaned import job',
        );
      }
    }

    this.log.info({ count: orphans.length, recovered, failed }, 'Boot recovery complete');
  }

  /** Main drain loop: wait for nudge or poll, then drain all pending jobs. */
  private drainLoop(): void {
    const drain = async () => {
      if (!this.running) return;

      let processed = true;
      while (processed && this.running && !this.stopping) {
        processed = await this.drainOne();
      }
    };

    // Listen for nudges
    this.emitter.on('nudge', () => {
      void drain();
    });

    // Safety-net poll
    this.pollTimer = setInterval(() => {
      void drain();
    }, SAFETY_POLL_INTERVAL_MS);

    // Initial drain
    void drain();
  }

  /**
   * Try to claim and process one pending job.
   * Returns true if a job was processed (success or failure), false if none available.
   */
  private async drainOne(): Promise<boolean> {
    // Select oldest pending row
    const candidates = await this.db
      .select({ id: importJobs.id })
      .from(importJobs)
      .where(eq(importJobs.status, 'pending'))
      .orderBy(importJobs.createdAt)
      .limit(1);

    if (candidates.length === 0) return false;

    const candidateId = candidates[0].id;

    // Atomically claim via conditional update
    const now = new Date();
    const result = await this.db
      .update(importJobs)
      .set({ status: 'processing', startedAt: now, updatedAt: now })
      .where(and(eq(importJobs.id, candidateId), eq(importJobs.status, 'pending')));

    const rowsAffected = getRowsAffected(result);
    if (rowsAffected !== 1) {
      // Another process claimed it — retry with next row
      return true;
    }

    // Fetch full job row
    const [job] = await this.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, candidateId))
      .limit(1);

    if (!job) return true;

    // Look up adapter
    const adapter = getImportAdapter(job.type);
    if (!adapter) {
      this.log.error({ jobId: job.id, type: job.type }, 'No import adapter registered for job type');
      await this.markJobFailed(job.id, job.bookId, job.phase ?? 'queued', this.extractTitle(job.metadata), JSON.stringify({ message: `No import adapter registered for type "${job.type}"`, type: 'UnknownAdapterType' }));
      return true;
    }

    // Build phase history from persisted state
    const phaseHistory: PhaseHistoryEntry[] = job.phaseHistory ? JSON.parse(job.phaseHistory) : [];
    let currentPhase = job.phase ?? 'queued';

    // Build adapter context with enhanced setPhase
    const ctx: ImportAdapterContext = {
      db: this.db,
      log: this.log.child({ jobId: job.id, type: job.type }),
      setPhase: async (phase: ImportJobPhase) => {
        const nowMs = Date.now();
        const previousPhase = currentPhase;

        // Close previous phase entry
        if (phaseHistory.length > 0) {
          const last = phaseHistory[phaseHistory.length - 1];
          if (last.completedAt === undefined) {
            last.completedAt = nowMs;
          }
        }

        // Append new phase entry
        phaseHistory.push({ phase, startedAt: nowMs });
        currentPhase = phase;

        await this.db.update(importJobs).set({
          phase,
          phaseHistory: JSON.stringify(phaseHistory),
          updatedAt: new Date(),
        }).where(eq(importJobs.id, job.id));

        // Emit SSE event
        safeEmit(this.broadcaster, 'import_phase_change', {
          job_id: job.id,
          book_id: job.bookId,
          book_title: this.extractTitle(job.metadata),
          from: previousPhase,
          to: phase,
        }, this.log);
      },
      emitProgress: this.createThrottledProgressEmitter(job.id, job.bookId, this.extractTitle(job.metadata)),
    };

    const startTime = Date.now();
    this.currentJobPromise = this.processJob(job.id, job.bookId, adapter, job, ctx, phaseHistory, startTime);
    await this.currentJobPromise;
    this.currentJobPromise = null;

    return true;
  }

  private async processJob(
    jobId: number,
    bookId: number | null,
    adapter: { process: (job: typeof importJobs.$inferSelect, ctx: ImportAdapterContext) => Promise<void> },
    job: typeof importJobs.$inferSelect,
    ctx: ImportAdapterContext,
    phaseHistory: PhaseHistoryEntry[],
    startTime: number,
  ): Promise<void> {
    const bookTitle = this.extractTitle(job.metadata);
    try {
      await adapter.process(job, ctx);

      // Close current phase entry
      if (phaseHistory.length > 0) {
        const last = phaseHistory[phaseHistory.length - 1];
        if (last.completedAt === undefined) {
          last.completedAt = Date.now();
        }
      }

      const now = new Date();
      await this.db.update(importJobs).set({
        status: 'completed',
        phase: 'done',
        phaseHistory: JSON.stringify(phaseHistory),
        completedAt: now,
        updatedAt: now,
      }).where(eq(importJobs.id, jobId));

      const elapsedMs = Date.now() - startTime;
      safeEmit(this.broadcaster, 'import_complete', {
        download_id: null,
        book_id: bookId,
        book_title: bookTitle,
        job_id: jobId,
        elapsed_ms: elapsedMs,
      }, this.log);

      this.log.info({ jobId, elapsedMs }, 'Import job completed successfully');
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), jobId }, 'Import job failed');
      // Close the active phase entry before persisting
      if (phaseHistory.length > 0) {
        const last = phaseHistory[phaseHistory.length - 1];
        if (last.completedAt === undefined) {
          last.completedAt = Date.now();
        }
      }
      const currentPhase = phaseHistory.length > 0 ? phaseHistory[phaseHistory.length - 1].phase : 'queued';
      await this.markJobFailed(jobId, bookId, currentPhase, bookTitle, JSON.stringify(serializeError(error)), phaseHistory);
    }
  }

  private async markJobFailed(jobId: number, bookId: number | null, currentPhase: string, bookTitle: string, lastError: string, phaseHistory?: PhaseHistoryEntry[]): Promise<void> {
    const now = new Date();
    await this.db.update(importJobs).set({
      status: 'failed',
      phase: 'failed',
      lastError,
      ...(phaseHistory ? { phaseHistory: JSON.stringify(phaseHistory) } : {}),
      completedAt: now,
      updatedAt: now,
    }).where(eq(importJobs.id, jobId));

    if (bookId != null) {
      await this.db.update(books).set({
        status: 'failed',
        updatedAt: now,
      }).where(eq(books.id, bookId));
    }

    // Parse error message for SSE
    let errorMessage: string;
    try {
      const parsed = JSON.parse(lastError);
      errorMessage = parsed.message ?? lastError;
    } catch {
      errorMessage = lastError;
    }

    safeEmit(this.broadcaster, 'import_failed', {
      job_id: jobId,
      book_id: bookId,
      book_title: bookTitle,
      phase: currentPhase,
      error_message: errorMessage,
    }, this.log);
  }

  /** Extract book title from job metadata JSON. */
  private extractTitle(metadata: string): string {
    try {
      const parsed = JSON.parse(metadata);
      return parsed.title ?? 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  /** Create a throttled progress emitter for a specific job. */
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
