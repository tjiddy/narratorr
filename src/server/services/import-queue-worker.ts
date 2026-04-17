import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { importJobs, books } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getImportAdapter } from './import-adapters/registry.js';
import type { ImportAdapterContext } from './import-adapters/types.js';
import type { ImportJobPhase } from '../../shared/schemas/import-job.js';
import { serializeError } from '../utils/serialize-error.js';

const SAFETY_POLL_INTERVAL_MS = 30_000;

export class ImportQueueWorker {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly emitter = new EventEmitter();
  private running = false;
  private stopping = false;
  private currentJobPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Db, log: FastifyBaseLogger) {
    this.db = db;
    this.log = log.child({ component: 'ImportQueueWorker' });
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

    for (const orphan of orphans) {
      await this.db.update(importJobs).set({
        status: 'failed',
        phase: 'failed',
        lastError: errorJson,
        completedAt: now,
        updatedAt: now,
      }).where(eq(importJobs.id, orphan.id));

      if (orphan.bookId != null) {
        await this.db.update(books).set({
          status: 'failed',
          updatedAt: now,
        }).where(eq(books.id, orphan.bookId));
      }

      this.log.info({ jobId: orphan.id, bookId: orphan.bookId }, 'Orphaned import job marked as failed');
    }
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

    const rowsAffected = (result as unknown as { rowsAffected?: number }).rowsAffected;
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
      await this.markJobFailed(job.id, job.bookId, JSON.stringify({ message: `No import adapter registered for type "${job.type}"`, type: 'UnknownAdapterType' }));
      return true;
    }

    // Process the job
    const ctx: ImportAdapterContext = {
      db: this.db,
      log: this.log.child({ jobId: job.id, type: job.type }),
      setPhase: async (phase: ImportJobPhase) => {
        await this.db.update(importJobs).set({ phase, updatedAt: new Date() }).where(eq(importJobs.id, job.id));
      },
    };

    this.currentJobPromise = this.processJob(job.id, job.bookId, adapter, job, ctx);
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
  ): Promise<void> {
    try {
      await adapter.process(job, ctx);

      const now = new Date();
      await this.db.update(importJobs).set({
        status: 'completed',
        phase: 'done',
        completedAt: now,
        updatedAt: now,
      }).where(eq(importJobs.id, jobId));

      this.log.info({ jobId }, 'Import job completed successfully');
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), jobId }, 'Import job failed');
      await this.markJobFailed(jobId, bookId, JSON.stringify(serializeError(error)));
    }
  }

  private async markJobFailed(jobId: number, bookId: number | null, lastError: string): Promise<void> {
    const now = new Date();
    await this.db.update(importJobs).set({
      status: 'failed',
      phase: 'failed',
      lastError,
      completedAt: now,
      updatedAt: now,
    }).where(eq(importJobs.id, jobId));

    if (bookId != null) {
      await this.db.update(books).set({
        status: 'failed',
        updatedAt: now,
      }).where(eq(books.id, bookId));
    }
  }
}
