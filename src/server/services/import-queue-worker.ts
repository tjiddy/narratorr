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
import { sweepCommitPendingMarkers } from '../utils/import-staging.js';
import { transitionBookStatus } from '../utils/book-status.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';


const SAFETY_POLL_INTERVAL_MS = 30_000;
const PROGRESS_THROTTLE_MS = 250;

export class ImportQueueWorker {
  private readonly db: Db;
  private readonly log: FastifyBaseLogger;
  private readonly broadcaster: EventBroadcasterService | null;
  private readonly getLibraryRoot: (() => Promise<string | null | undefined>) | null;
  private readonly emitter = new EventEmitter();
  private running = false;
  private stopping = false;
  private currentJobPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private drainInProgress = false;
  private drainRequested = false;

  /**
   * `getLibraryRoot` resolves the configured library root for the boot-time stranded-marker
   * sweep (#1338). Injected (rather than holding a `SettingsService`) to keep the worker's
   * dependency surface minimal; omitted in unit tests that don't exercise the sweep.
   */
  constructor(
    db: Db,
    log: FastifyBaseLogger,
    broadcaster?: EventBroadcasterService,
    getLibraryRoot?: () => Promise<string | null | undefined>,
  ) {
    this.db = db;
    this.log = log.child({ component: 'ImportQueueWorker' });
    this.broadcaster = broadcaster ?? null;
    this.getLibraryRoot = getLibraryRoot ?? null;
  }

  /** Nudge the worker to check for new pending jobs. */
  nudge(): void {
    if (!this.stopping) {
      this.emitter.emit('nudge');
    }
  }

  /** Start the worker: run boot recovery, sweep stranded markers, then enter the drain loop. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    await this.bootRecovery();
    // Converge stranded commit-pending markers BEFORE the drain loop starts (#1338). Both
    // steps are awaited here, so the sweep is the single recovery actor per marker — no
    // draining import can `rename()` from the same `.import-bak` concurrently.
    await this.sweepStrandedMarkers();
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
   * Boot recovery: resolve any import jobs left in `processing` by a previous crash (#1663).
   *
   * The linked book's status — read within the recovery transaction — decides each orphan's
   * outcome. Boot recovery writes ONLY the `import_jobs` row: it never writes the book and never
   * infers completion from book status.
   *   - book still `importing` → the genuine interrupted case (no success/failure transition has
   *     run yet). Re-queue the job (`pending`/`queued`, clear `lastError`) so the next drain
   *     retries it; the book stays `importing`.
   *   - any other status (`imported`, a failure-path revert to `failed`/`missing`/`wanted`, …) or
   *     a null `bookId` → terminal-fail the job (`ProcessRestart`), leaving the book untouched.
   * A requeued job whose real work cannot proceed is terminal-failed later by the NORMAL drain-time
   * failure path with its real error (#1663 AC4) — never pre-emptively here.
   */
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

  /**
   * Resolve a single orphaned `processing` job in one transaction. Reads the linked book's status
   * (race-free: boot recovery is single-threaded and fully completes before `drainLoop()` starts,
   * so no concurrent worker can move the book between the read and the job write), then writes ONLY
   * the `import_jobs` row — never the book. Returns `true` when the job was re-queued (book still
   * `importing`), `false` when it was terminal-failed.
   */
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

  /**
   * Boot-time sweep of stranded `.import-commit-pending` markers (#1338). Walks the library
   * root and converges each marker through the existing `prepareImportSiblings` recovery
   * semantics, decoupling recovery from the same-target retry trigger so failed-download,
   * manual-job, and recomputed-target orphans also converge. Best-effort: a missing library
   * root (unconfigured / not yet set) is a no-op, and any sweep-level throw is caught so a
   * traversal hiccup never prevents the worker from starting and draining.
   */
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
    try {
      await this.currentJobPromise;
    } finally {
      // Null on EVERY outcome — success and rejection. A rejected processJob
      // (e.g. markJobFailed's transaction aborts) must not leave a parked
      // rejected promise that stop() would later re-await and re-reject.
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
    // Wrap the import_jobs + books failed-state writes in a single transaction so an
    // observer joining the two rows never sees the job `status='failed'` while the book
    // is still `status='importing'`. Mirrors the bootRecovery pattern (see above): both
    // writes commit together or neither commits. The SSE emit stays outside — a
    // broadcaster failure must not roll back the durable failure write.
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
        // Guarded book write in the SAME transaction as the job write (#1448):
        // both rows commit together or neither does. The `importing` guard (#1470)
        // prevents this failure write from clobbering an earlier `bookStatusAtGrab`
        // revert: `handleImportFailure`'s revert commits the book off `importing`
        // before this catch-path runs, so the guard misses (no-op) and the reverted
        // status survives. When no revert ran (book still `importing`) it settles to `failed`.
        await transitionBookStatus(tx, bookId, { status: 'failed', expected: { status: 'importing' } });
      }
    });

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
