import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { importJobs, books } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { getImportAdapter } from './import-adapters/registry.js';
import type { ImportAdapterContext } from './import-adapters/types.js';
import { manualImportJobPayloadSchema } from './import-adapters/types.js';
import type { ImportJobRow } from './types.js';
import type { ImportJobPhase, ImportJobType, PhaseHistoryEntry } from '../../shared/schemas/import-job.js';
import { serializeError } from '../utils/serialize-error.js';
import { getRowsAffected } from '../utils/db-helpers.js';
import { parsePhaseHistory } from '../utils/parse-phase-history.js';
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
  private drainInProgress = false;
  private drainRequested = false;

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

  /**
   * Wire nudges and the safety poll. Drain is gated through `requestDrain()`
   * so overlapping triggers coalesce into one active drain runner — the worker
   * processes one import at a time per process.
   */
  private drainLoop(): void {
    this.emitter.on('nudge', () => this.requestDrain());

    this.pollTimer = setInterval(() => this.requestDrain(), SAFETY_POLL_INTERVAL_MS);

    this.requestDrain();
  }

  /**
   * Re-entrancy guard. If a drain is already running, set the "needs another
   * pass" flag so the active runner repeats after reaching idle. Otherwise,
   * spin up a single drain runner.
   */
  private requestDrain(): void {
    if (!this.running || this.stopping) return;
    if (this.drainInProgress) {
      this.drainRequested = true;
      return;
    }
    this.drainInProgress = true;
    void this.runDrain();
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

    const candidateId = candidates[0]!.id;

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
      await this.markJobFailed(job.id, job.bookId, job.phase ?? 'queued', this.extractTitle(job.metadata, job.type), JSON.stringify({ message: `No import adapter registered for type "${job.type}"`, type: 'UnknownAdapterType' }));
      return true;
    }

    // Build phase history from persisted state
    const phaseHistory: PhaseHistoryEntry[] = parsePhaseHistory(job.phaseHistory, this.log, job.id);
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
          const last = phaseHistory[phaseHistory.length - 1]!;
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
          book_title: this.extractTitle(job.metadata, job.type),
          from: previousPhase,
          to: phase,
        }, this.log);
      },
      emitProgress: this.createThrottledProgressEmitter(job.id, job.bookId, this.extractTitle(job.metadata, job.type)),
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
    adapter: { process: (job: ImportJobRow, ctx: ImportAdapterContext) => Promise<void> },
    job: ImportJobRow,
    ctx: ImportAdapterContext,
    phaseHistory: PhaseHistoryEntry[],
    startTime: number,
  ): Promise<void> {
    const bookTitle = this.extractTitle(job.metadata, job.type);
    try {
      await adapter.process(job, ctx);

      // Close current phase entry
      if (phaseHistory.length > 0) {
        const last = phaseHistory[phaseHistory.length - 1]!;
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
      const resolvedTitle = await this.resolveBookTitle(bookId, bookTitle);
      safeEmit(this.broadcaster, 'import_complete', {
        download_id: null,
        book_id: bookId,
        book_title: resolvedTitle,
        job_id: jobId,
        elapsed_ms: elapsedMs,
      }, this.log);

      this.log.info({ jobId, elapsedMs }, 'Import job completed successfully');
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error), jobId }, 'Import job failed');
      // Close the active phase entry before persisting
      if (phaseHistory.length > 0) {
        const last = phaseHistory[phaseHistory.length - 1]!;
        if (last.completedAt === undefined) {
          last.completedAt = Date.now();
        }
      }
      const currentPhase = phaseHistory.length > 0 ? phaseHistory[phaseHistory.length - 1]!.phase : 'queued';
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

    const resolvedTitle = await this.resolveBookTitle(bookId, bookTitle);
    safeEmit(this.broadcaster, 'import_failed', {
      job_id: jobId,
      book_id: bookId,
      book_title: resolvedTitle,
      phase: currentPhase,
      error_message: errorMessage,
    }, this.log);
  }

  /**
   * Resolve the canonical book title from the `books` row for SSE emit.
   * Falls back to `fallback` when bookId is null, the row is missing, or the
   * lookup throws — preserves the quiet-path semantics for this high-volume
   * code (no error logs on failure).
   */
  private async resolveBookTitle(bookId: number | null, fallback: string): Promise<string> {
    if (bookId === null) return fallback;
    try {
      const rows = await this.db
        .select({ title: books.title })
        .from(books)
        .where(eq(books.id, bookId))
        .limit(1);
      return rows[0]?.title ?? fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Extract book title from job metadata JSON.
   * Auto jobs have no title field — always returns 'Unknown'. Manual jobs are
   * validated against `manualImportJobPayloadSchema` so a non-string `title`
   * cannot leak into SSE payloads. Never throws.
   */
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
