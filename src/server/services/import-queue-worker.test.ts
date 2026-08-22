import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject, createMockSettingsService } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { ImportQueueWorker } from './import-queue-worker.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter, ImportJob } from './import-adapters/types.js';
import { AutoImportAdapter } from './import-adapters/auto.js';
import { ManualImportAdapter } from './import-adapters/manual.js';
import { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportService, ImportContext, ImportResult, ImportProgressCallbacks } from './import.service.js';
import type { ImportPipelineDeps } from './import-orchestration.helpers.js';
import { importFailedPayload } from '@shared/schemas/sse-events.js';
import type { BookStatus } from '@shared/schemas/book.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function createMockDb() {
  const setMock = vi.fn().mockReturnThis();
  const whereMock = vi.fn().mockReturnThis();
  const limitMock = vi.fn().mockResolvedValue([]);
  const chainMethods = {
    from: vi.fn().mockReturnThis(),
    where: whereMock,
    orderBy: vi.fn().mockReturnThis(),
    limit: limitMock,
    set: setMock,
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  const db = {
    select: vi.fn().mockReturnValue(chainMethods),
    update: vi.fn().mockReturnValue({ ...chainMethods, where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
    insert: vi.fn().mockReturnValue(chainMethods),
    delete: vi.fn().mockReturnValue(chainMethods),
    // Resolve db.update at call time so reassigned spies also capture transactional writes.
    transaction: vi.fn((cb: (tx: { update: (...args: unknown[]) => unknown }) => Promise<unknown>) =>
      cb({ update: (...args: unknown[]) => db.update(...(args as [])) })),
  };
  return {
    db,
    setMock,
    whereMock,
    limitMock,
  };
}

// Models both direct-await writes and guarded writes that call returning().
// rows controls the guard: non-empty matches; [] misses.
function updateWhereTerminus(rows: Array<{ id: number }> = [{ id: 1 }]) {
  return {
    then: (resolve: (v: { rowsAffected: number }) => void) => resolve({ rowsAffected: 1 }),
    returning: vi.fn().mockResolvedValue(rows),
  };
}

// import_jobs writes always land; books writes mutate only while status is importing,
// matching transitionBookStatus's guarded returning() behavior without a live DB.
function makeGuardedTxUpdate(state: { bookStatus: BookStatus | null }) {
  const jobWrites: Record<string, unknown>[] = [];
  const bookWrites: Array<{ payload: Record<string, unknown>; returningCalled: boolean; guardMatched: boolean }> = [];
  const update = vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      if ('phase' in payload) {
        jobWrites.push(payload);
        return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
      }
      const rec = { payload, returningCalled: false, guardMatched: false };
      bookWrites.push(rec);
      return {
        where: vi.fn().mockImplementation(() => ({
          returning: vi.fn().mockImplementation(async () => {
            rec.returningCalled = true;
            if (state.bookStatus === 'importing') {
              rec.guardMatched = true;
              state.bookStatus = payload.status as BookStatus;
              return [{ id: 1 }];
            }
            return [];
          }),
        })),
      };
    }),
  }));
  return { update, jobWrites, bookWrites };
}

describe('ImportQueueWorker', () => {
  let worker: ImportQueueWorker;
  let mockDb: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;

  beforeEach(() => {
    clearImportAdapters();
    mockDb = createMockDb();
    log = createMockLogger();
    worker = new ImportQueueWorker(inject<Db>(mockDb.db), log);
  });

  afterEach(async () => {
    await worker.stop();
  });

  describe('boot recovery (#1663 requeue-eligibility)', () => {
    // Orphan N uses transaction N; each transaction reads its book and records job-only writes.
    function setupBootRecovery(orphans: Array<{ id: number; bookId: number | null; bookStatus?: BookStatus | null }>) {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(orphans.map(o => ({ id: o.id, bookId: o.bookId }))),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      const txWrites: Array<{ orphanIdx: number; payload: Record<string, unknown> }> = [];
      const bookReads: number[] = [];
      let txIdx = 0;

      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const idx = txIdx++;
        const orphan = orphans[idx]!;
        const tx = {
          select: vi.fn().mockImplementation(() => {
            bookReads.push(idx);
            return {
              from: vi.fn().mockReturnThis(),
              where: vi.fn().mockReturnThis(),
              limit: vi.fn().mockResolvedValue(
                orphan.bookId != null ? [{ status: orphan.bookStatus ?? null }] : [],
              ),
            };
          }),
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
              txWrites.push({ orphanIdx: idx, payload });
              return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
            }),
          })),
        };
        return cb(tx);
      });

      return { txWrites, bookReads };
    }

    it('book still importing → job re-queued (pending/queued, lastError cleared); book read but not written', async () => {
      const { txWrites, bookReads } = setupBootRecovery([{ id: 99, bookId: 42, bookStatus: 'importing' }]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(txWrites).toHaveLength(1);
      expect(txWrites[0]!.payload).toMatchObject({ status: 'pending', phase: 'queued', lastError: null });
      expect(txWrites[0]!.payload.status).not.toBe('failed');
      expect(bookReads).toEqual([0]);

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 1 && ctx.requeued === 1 && ctx.settled === 0 && ctx.failed === 0;
      });
      expect(summaryCall).toBeDefined();
    });

    it('requeue-eligibility matrix: only the still-importing orphan is requeued; every other case settles failed; no book writes', async () => {
      const { txWrites, bookReads } = setupBootRecovery([
        { id: 1, bookId: 10, bookStatus: 'importing' }, // genuine interrupt → requeue
        { id: 2, bookId: 20, bookStatus: 'imported' },  // success-but-crashed-before-completed → fail
        { id: 3, bookId: 30, bookStatus: 'wanted' },    // failure-path revert → fail
        { id: 4, bookId: 40, bookStatus: 'failed' },    // failure-path revert → fail
        { id: 5, bookId: null },                         // null bookId → fail
      ]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(txWrites).toHaveLength(5);
      expect(txWrites.find(x => x.orphanIdx === 0)!.payload).toMatchObject({ status: 'pending', phase: 'queued', lastError: null });
      for (const idx of [1, 2, 3, 4]) {
        const w = txWrites.find(x => x.orphanIdx === idx)!;
        expect(w.payload).toMatchObject({ status: 'failed', phase: 'failed' });
        const err = JSON.parse(w.payload.lastError as string);
        expect(err).toMatchObject({ message: 'Interrupted by server restart', type: 'ProcessRestart' });
      }
      expect(txWrites.every(w => w.payload.status === 'pending' || w.payload.status === 'failed')).toBe(true);
      expect([...bookReads].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 5 && ctx.requeued === 1 && ctx.settled === 4 && ctx.failed === 0;
      });
      expect(summaryCall).toBeDefined();
    });

    it('continue-on-error: an orphan whose transaction throws is logged failed; the others still resolve', async () => {
      setupBootRecovery([
        { id: 1, bookId: 10, bookStatus: 'imported' },
        { id: 2, bookId: 20, bookStatus: 'importing' },
        { id: 3, bookId: 30, bookStatus: 'imported' },
      ]);

      const committed: Array<{ orphanIdx: number; payload: Record<string, unknown> }> = [];
      let txIdx = 0;
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const idx = txIdx++;
        if (idx === 1) throw new Error('orphan B blew up');
        const tx = {
          select: vi.fn().mockImplementation(() => ({
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ status: 'imported' }]),
          })),
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
              committed.push({ orphanIdx: idx, payload });
              return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
            }),
          })),
        };
        return cb(tx);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(committed.map(c => c.orphanIdx).sort((a, b) => a - b)).toEqual([0, 2]);
      for (const c of committed) expect(c.payload).toMatchObject({ status: 'failed', phase: 'failed' });

      const logErrMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const bErr = logErrMock.error.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.jobId === 2 && ctx.bookId === 20 && 'error' in ctx;
      });
      expect(bErr).toBeDefined();
      const errCtx = bErr![0] as { error: Record<string, unknown> };
      expect(errCtx.error.message).toBe('orphan B blew up');
      expect(errCtx.error).not.toBeInstanceOf(Error);

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 3 && ctx.requeued === 0 && ctx.settled === 2 && ctx.failed === 1;
      });
      expect(summaryCall).toBeDefined();
    });

    it('empty orphan set: no transaction, no summary log, early return', async () => {
      setupBootRecovery([]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(mockDb.db.transaction).not.toHaveBeenCalled();

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && 'requeued' in ctx && 'settled' in ctx;
      });
      expect(summaryCall).toBeUndefined();
    });

    it('catastrophic load failure: the initial SELECT throwing propagates out of start()', async () => {
      mockDb.db.select = vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockRejectedValue(new Error('db is gone')),
      }));

      await expect(worker.start()).rejects.toThrow('db is gone');
    });
  });

  describe('drainOne CAS claim', () => {
    // start() fire-and-forgets drainLoop, so direct invocation is the only rejection seam.
    type DrainSeam = { drainOne(): Promise<boolean> };

    function setupSingleCandidate(claimResult: unknown) {
      // Direct calls must pass the production pre-claim running check.
      (worker as unknown as { running: boolean }).running = true;
      mockDb.db.select = vi.fn().mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: 42 }]),
      });
      mockDb.db.update = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(claimResult),
        }),
      });
    }

    it('returns true on lost race (rowsAffected === 0) so the outer loop continues', async () => {
      setupSingleCandidate({ rowsAffected: 0 });

      const result = await (worker as unknown as DrainSeam).drainOne();

      expect(result).toBe(true);
    });

    it('throws an error mentioning rowsAffected when the claim result is missing the field', async () => {
      setupSingleCandidate({});

      await expect(
        (worker as unknown as DrainSeam).drainOne(),
      ).rejects.toThrow(/rowsAffected/);
    });

    it('throws an error mentioning rowsAffected when the claim result explicitly sets undefined', async () => {
      setupSingleCandidate({ rowsAffected: undefined });

      await expect(
        (worker as unknown as DrainSeam).drainOne(),
      ).rejects.toThrow(/rowsAffected/);
    });

    it('F72 pre-claim barrier: aborts before the claim UPDATE when stopping is set (row stays pending)', async () => {
      (worker as unknown as { running: boolean; stopping: boolean }).running = true;
      (worker as unknown as { running: boolean; stopping: boolean }).stopping = true;
      mockDb.db.select = vi.fn().mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: 42 }]),
      });
      const updateSpy = vi.fn();
      mockDb.db.update = updateSpy;

      const result = await (worker as unknown as DrainSeam).drainOne();

      expect(result).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('F72 lifecycle: stop() awaits a drain parked in the candidate SELECT and the barrier prevents any claim; a fresh worker then claims the row', async () => {
      let releaseSelect!: () => void;
      const selectGate = new Promise<void>((res) => { releaseSelect = res; });
      let selectCall = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCall++;
        if (selectCall === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        // Park the candidate select until stop() is waiting.
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation(async () => { await selectGate; return [{ id: 42 }]; }),
        };
      });
      const claimSpy = vi.fn(() => updateWhereTerminus());
      mockDb.db.update = claimSpy;

      await worker.start();

      let stopResolved = false;
      const stopP = worker.stop().then(() => { stopResolved = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(stopResolved).toBe(false);

      releaseSelect();
      await stopP;
      expect(stopResolved).toBe(true);

      expect(claimSpy).not.toHaveBeenCalled();

      const processedIds: number[] = [];
      registerImportAdapter({ type: 'manual', async process(job) { processedIds.push(job.id); } });

      let freshSelect = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        freshSelect++;
        if (freshSelect === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (freshSelect === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 42 }]) };
        if (freshSelect === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 42, bookId: 10, type: 'manual', status: 'processing', metadata: '{}' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      const setPayloads: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((p: Record<string, unknown>) => { setPayloads.push(p); return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) }; }),
      }));

      const fresh = new ImportQueueWorker(inject<Db>(mockDb.db), log);
      await fresh.start();
      await new Promise((r) => setTimeout(r, 100));
      await fresh.stop();

      expect(processedIds).toContain(42);
      expect(setPayloads.some((p) => p.status === 'completed')).toBe(true);
    });
  });

  // requestDrain serializes in-process work; CAS still owns rows across workers (#1122).
  describe('drain loop', () => {
    it('failure of one job does NOT stop drain of subsequent jobs', async () => {
      const processedIds: number[] = [];
      const failAdapter: ImportAdapter = {
        type: 'manual',
        async process(job: ImportJob) {
          processedIds.push(job.id);
          if (job.id === 1) throw new Error('simulated failure');
        },
      };
      registerImportAdapter(failAdapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
          };
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 1 }]),
          };
        }
        if (selectCallCount === 3) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{}' }]),
          };
        }
        if (selectCallCount === 4) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([]),
          };
        }
        if (selectCallCount === 5) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 2 }]),
          };
        }
        if (selectCallCount === 6) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 2, bookId: 20, type: 'manual', status: 'processing', metadata: '{}' }]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => updateWhereTerminus()),
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(processedIds).toContain(1);
      expect(processedIds).toContain(2);
    });

    it('unknown adapter type marks row failed with books.status=failed', async () => {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        if (selectCallCount === 2) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 5 }]),
          };
        }
        if (selectCallCount === 3) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 5, bookId: 50, type: 'manual', status: 'processing', metadata: '{}' }]),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const failedJob = updateSets.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(failedJob).toBeDefined();
      expect(failedJob!.lastError).toBeDefined();
      const errorJson = JSON.parse(failedJob!.lastError as string);
      expect(errorJson.message).toContain('No import adapter registered');

      const failedBook = updateSets.filter(s => s.status === 'failed' && !('phase' in s));
      expect(failedBook.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('#1122 drain re-entrancy guard', () => {
    function setupTwoPendingJobs() {
      let gateResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
      let activeCount = 0;
      let maxActive = 0;
      const processedIds: number[] = [];
      let entered1Resolve: () => void = () => {};
      const entered1 = new Promise<void>((resolve) => { entered1Resolve = resolve; });

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(job: ImportJob) {
          activeCount++;
          if (activeCount > maxActive) maxActive = activeCount;
          try {
            if (job.id === 1) {
              entered1Resolve();
              await gate;
            }
            processedIds.push(job.id);
          } finally {
            activeCount--;
          }
        },
      };
      registerImportAdapter(adapter);

      // Select order: recovery, candidate/fetch/title for job 1, candidate/fetch/title for job 2, idle.
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        if (selectCallCount === 2) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1 }]) };
        }
        if (selectCallCount === 3) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{}' }]) };
        }
        if (selectCallCount === 4) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
        }
        if (selectCallCount === 5) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 2 }]) };
        }
        if (selectCallCount === 6) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 2, bookId: 20, type: 'manual', status: 'processing', metadata: '{}' }]) };
        }
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => updateWhereTerminus()),
        }),
      }));

      return {
        getMaxActive: () => maxActive,
        getActiveCount: () => activeCount,
        getProcessedIds: () => processedIds,
        releaseGate: () => gateResolve(),
        awaitEntered1: () => entered1,
      };
    }

    it('repeated nudges during an in-flight job do not start a second concurrent runner — maxActive stays at 1', async () => {
      const harness = setupTwoPendingJobs();

      await worker.start();
      await harness.awaitEntered1();

      worker.nudge();
      worker.nudge();
      worker.nudge();
      worker.nudge();

      await new Promise(r => setTimeout(r, 20));

      expect(harness.getActiveCount()).toBe(1);
      expect(harness.getMaxActive()).toBe(1);
      expect(harness.getProcessedIds()).toEqual([]);

      harness.releaseGate();
      await new Promise(r => setTimeout(r, 50));

      expect(harness.getProcessedIds()).toEqual([1, 2]);
      expect(harness.getMaxActive()).toBe(1);
    });

    it('nudge fired between drainOne() calls coalesces into the active runner instead of spawning a second', async () => {
      const harness = setupTwoPendingJobs();

      await worker.start();
      await harness.awaitEntered1();

      worker.nudge();

      harness.releaseGate();
      await new Promise(r => setTimeout(r, 50));

      expect(harness.getProcessedIds()).toEqual([1, 2]);
      expect(harness.getMaxActive()).toBe(1);
    });

    it('nudge after the runner has cleared starts a fresh drain — no missed wake-up', async () => {
      const processedIds: number[] = [];
      const adapter: ImportAdapter = {
        type: 'manual',
        async process(job: ImportJob) {
          processedIds.push(job.id);
        },
      };
      registerImportAdapter(adapter);

      let pendingJobReady = false;
      let candidateDelivered = false;
      let fullRowDelivered = false;

      mockDb.db.select = vi.fn().mockImplementation(() => {
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // Awaitable for boot recovery and chainable for candidate/full-row reads.
            return Object.assign(Promise.resolve([]), {
              orderBy: vi.fn().mockReturnThis(),
              limit: vi.fn().mockImplementation(() => {
                if (!pendingJobReady) return Promise.resolve([]);
                if (!candidateDelivered) {
                  candidateDelivered = true;
                  return Promise.resolve([{ id: 9 }]);
                }
                if (!fullRowDelivered) {
                  fullRowDelivered = true;
                  return Promise.resolve([{ id: 9, bookId: 90, type: 'manual', status: 'processing', metadata: '{}' }]);
                }
                return Promise.resolve([]);
              }),
            });
          }),
        };
        return chain;
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => updateWhereTerminus()),
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 30));
      expect(processedIds).toEqual([]);

      pendingJobReady = true;
      worker.nudge();
      await new Promise(r => setTimeout(r, 30));

      expect(processedIds).toEqual([9]);
    });

    it('stop() while a drain is in progress: in-flight job completes, no new drain starts, test does not hang', async () => {
      const harness = setupTwoPendingJobs();

      await worker.start();
      await harness.awaitEntered1();

      // Release the gated job before awaiting stop; stop intentionally waits for it.
      const stopPromise = worker.stop();

      worker.nudge();
      harness.releaseGate();

      await stopPromise;

      expect(harness.getProcessedIds()).toEqual([1]);
      expect(harness.getMaxActive()).toBe(1);
    });

    it('safety-poll interval routes through the guard — leaked poll runners would claim job 2; the guard must prevent it', async () => {
      // Shape-based mocks let a leaked runner really claim job 2; a call-count mock
      // could throw first and make the concurrency assertion pass accidentally.
      const candidateQueue: number[] = [1, 2];
      type JobRow = { id: number; bookId: number; type: string; status: string; metadata: string };
      const rowsById: Record<number, JobRow> = {
        1: { id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{}' },
        2: { id: 2, bookId: 20, type: 'manual', status: 'processing', metadata: '{}' },
      };
      let pendingFullRow: JobRow | null = null;
      let bootRecoveryDone = false;

      let gateResolve: () => void = () => {};
      const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
      let activeCount = 0;
      let maxActive = 0;
      const processedIds: number[] = [];
      let entered1Resolve: () => void = () => {};
      const entered1 = new Promise<void>((resolve) => { entered1Resolve = resolve; });

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(job: ImportJob) {
          activeCount++;
          if (activeCount > maxActive) maxActive = activeCount;
          try {
            if (job.id === 1) {
              entered1Resolve();
              await gate;
            }
            processedIds.push(job.id);
          } finally {
            activeCount--;
          }
        },
      };
      registerImportAdapter(adapter);

      mockDb.db.select = vi.fn().mockImplementation(() => {
        let didOrderBy = false;
        const inner = Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockImplementation(() => { didOrderBy = true; return inner; }),
          limit: vi.fn().mockImplementation(() => {
            if (didOrderBy) {
              const id = candidateQueue.shift();
              if (id === undefined) return Promise.resolve([]);
              pendingFullRow = rowsById[id] ?? null;
              return Promise.resolve([{ id }]);
            }
            if (pendingFullRow) {
              const row = pendingFullRow;
              pendingFullRow = null;
              return Promise.resolve([row]);
            }
            return Promise.resolve([]);
          }),
        });
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            // The first where() is boot recovery; later calls return drain chains.
            if (!bootRecoveryDone) {
              bootRecoveryDone = true;
              return Promise.resolve([]);
            }
            return inner;
          }),
        };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => updateWhereTerminus()),
        }),
      }));

      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        await worker.start();
        await entered1;

        vi.advanceTimersByTime(120_000); // 4 × SAFETY_POLL_INTERVAL_MS

        vi.useRealTimers();
        await new Promise(r => setTimeout(r, 20));

        expect(activeCount).toBe(1);
        expect(maxActive).toBe(1);
        expect(processedIds).toEqual([]);
        expect(candidateQueue).toEqual([2]);

        gateResolve();
        await new Promise(r => setTimeout(r, 50));

        expect(processedIds).toEqual([1, 2]);
        expect(maxActive).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('unexpected drain-runner error is caught and logged via serializeError() with the canonical "Drain runner failed unexpectedly" message', async () => {
      mockDb.db.select = vi.fn().mockImplementation(() => {
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockImplementation(() => {
            return Object.assign(Promise.resolve([]), {
              orderBy: vi.fn().mockReturnThis(),
              limit: vi.fn().mockRejectedValue(new Error('candidate select blew up')),
            });
          }),
        };
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 30));

      const logErrMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const runnerErrCalls = logErrMock.error.mock.calls.filter((call: unknown[]) => {
        return call[1] === 'Drain runner failed unexpectedly';
      });
      expect(runnerErrCalls).toHaveLength(1);

      // Pino renders a raw Error as {}; require serializeError's plain object.
      const errCtx = runnerErrCalls[0]![0] as { error: Record<string, unknown> };
      expect(errCtx.error).toBeTypeOf('object');
      expect(errCtx.error).not.toBeInstanceOf(Error);
      expect(errCtx.error.message).toBe('candidate select blew up');
      expect(errCtx.error.type).toBe('Error');
    });
  });

  describe('#637 phase history persistence', () => {
    it('setPhase appends new phaseHistory entry with startedAt', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{"title":"Test"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const phaseUpdate = updateSets.find(s => s.phase === 'analyzing' && s.phaseHistory);
      expect(phaseUpdate).toBeDefined();
      const history = JSON.parse(phaseUpdate!.phaseHistory as string);
      expect(history).toHaveLength(1);
      expect(history[0].phase).toBe('analyzing');
      expect(history[0].startedAt).toBeTypeOf('number');
      expect(history[0].completedAt).toBeUndefined();
    });

    it('#745 worker hydration: malformed persisted phaseHistory does not strand the job — falls back to [], warns, and completion proceeds', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 42 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 42, bookId: 100, type: 'manual', status: 'processing', metadata: '{"title":"Corrupt History"}', phaseHistory: 'not-json' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // Never log the parse error: V8 may quote persisted content in its message.
      expect(log.warn).toHaveBeenCalledWith(
        { jobId: 42 },
        expect.stringContaining('Unparseable phaseHistory'),
      );

      const completionUpdate = updateSets.find(s => s.status === 'completed' && s.phaseHistory);
      expect(completionUpdate).toBeDefined();

      const history = JSON.parse(completionUpdate!.phaseHistory as string) as Array<{ phase: string; startedAt: number; completedAt?: number }>;
      expect(history).toHaveLength(1);
      expect(history[0]!.phase).toBe('analyzing');
    });

    it('#745 worker hydration: wrong-shape persisted phaseHistory falls back to [] with warn', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 43 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 43, bookId: 101, type: 'manual', status: 'processing', metadata: '{"title":"Wrong Shape"}', phaseHistory: '[{"foo":"bar"}]' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // Log issue paths, not ZodError messages that can render persisted values.
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 43, issuePaths: expect.any(Array) }),
        expect.stringContaining('Malformed phaseHistory'),
      );

      const completionUpdate = updateSets.find(s => s.status === 'completed' && s.phaseHistory);
      expect(completionUpdate).toBeDefined();
      const history = JSON.parse(completionUpdate!.phaseHistory as string) as Array<{ phase: string; startedAt: number; completedAt?: number }>;
      expect(history).toHaveLength(1);
      expect(history[0]!.phase).toBe('analyzing');
    });

    it('job completion closes the current phaseHistory entry', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{"title":"Test"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const completionUpdate = updateSets.find(s => s.status === 'completed' && s.phaseHistory);
      expect(completionUpdate).toBeDefined();
      const history = JSON.parse(completionUpdate!.phaseHistory as string);
      const lastEntry = history[history.length - 1];
      expect(lastEntry.completedAt).toBeTypeOf('number');
    });
  });

  describe('#637 event wiring', () => {
    it('setPhase emits import_phase_change SSE with from and to fields', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
          await ctx.setPhase('copying');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 1, bookId: 10, type: 'manual', status: 'processing', metadata: '{"title":"Test Book"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const phaseChangeCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_phase_change'
      );
      expect(phaseChangeCalls.length).toBeGreaterThanOrEqual(1);
      expect(phaseChangeCalls[0]![1]).toMatchObject({
        job_id: 1,
        book_id: 10,
        from: 'queued',
        to: 'analyzing',
      });
    });

    it('worker emits import_complete on job success with job_id and elapsed_ms (book_title sourced from DB row, not manual metadata)', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process() { /* success */ },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 5 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 5, bookId: 50, type: 'manual', status: 'processing', metadata: '{"path":"/lib/MyBook","title":"User Manual Title"}', phaseHistory: null }]) };
        if (selectCallCount === 4) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ title: 'My Book' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const completeCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_complete'
      );
      expect(completeCalls).toHaveLength(1);
      expect(completeCalls[0]![1]).toMatchObject({
        job_id: 5,
        book_id: 50,
        book_title: 'My Book',
      });
      expect(completeCalls[0]![1].book_title).not.toBe('User Manual Title');
      expect(completeCalls[0]![1].elapsed_ms).toBeTypeOf('number');
    });

    it('worker emits import_failed on job failure with phase and error_message', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process() { throw new Error('Copy verification failed'); },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 7 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 7, bookId: 70, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"path":"/lib/Failed","title":"Failed Book"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_failed'
      );
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0]![1]).toMatchObject({
        job_id: 7,
        book_id: 70,
        book_title: 'Failed Book',
        error_message: 'Copy verification failed',
      });
    });

    it('failed job persists closed phaseHistory with completedAt', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('copying');
          throw new Error('disk full');
        },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 3 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 3, bookId: 30, type: 'manual', status: 'processing', metadata: '{"title":"Disk Full"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedUpdate = updateSets.find(s => s.status === 'failed' && s.phaseHistory);
      expect(failedUpdate).toBeDefined();
      const history = JSON.parse(failedUpdate!.phaseHistory as string);
      expect(history.length).toBeGreaterThanOrEqual(1);
      const lastEntry = history[history.length - 1];
      expect(lastEntry.phase).toBe('copying');
      expect(lastEntry.completedAt).toBeTypeOf('number');
    });

    it('EventBroadcasterService is injected via constructor', () => {
      const mockBroadcaster = { emit: vi.fn() };
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);
      expect(w).toBeDefined();
    });
  });

  // Job and book failure states commit together; SSE stays outside the transaction
  // so broadcaster failure cannot roll back durable state (#1448).

  describe('#1448 failure-window atomicity', () => {
    function setupFailingJob(jobRow: Record<string, unknown>) {
      const adapter: ImportAdapter = {
        type: 'manual',
        async process() { throw new Error('copy verification failed'); },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: jobRow.id }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([jobRow]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
    }

    it('a normal job failure commits BOTH the import_jobs (status+phase) and books (status) writes via the tx handle', async () => {
      setupFailingJob({ id: 8, bookId: 80, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(mockDb.db.transaction).toHaveBeenCalled();

      const failedJob = updateSets.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(failedJob).toBeDefined();
      expect(failedJob!.lastError).toBeDefined();

      const failedBook = updateSets.find(s => s.status === 'failed' && !('phase' in s) && !('lastError' in s));
      expect(failedBook).toBeDefined();
    });

    it('atomicity: when the books write throws inside the failure transaction, the import_jobs failed-state write is rolled back', async () => {
      setupFailingJob({ id: 9, bookId: 90, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null });

      const bareUpdateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          bareUpdateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      const committed: Record<string, unknown>[] = [];
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const staged: Record<string, unknown>[] = [];
        let writeCount = 0;
        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
              where: vi.fn().mockImplementation(() => {
                // Source writes import_jobs first, then guarded books returning().
                const isBooks = writeCount > 0;
                writeCount++;
                if (isBooks) return { returning: vi.fn().mockImplementation(async () => { throw new Error('books write failed'); }) };
                staged.push(payload);
                return Promise.resolve({ rowsAffected: 1 });
              }),
            })),
          })),
        };
        // Commit only after the callback resolves to model rollback.
        await cb(tx);
        committed.push(...staged);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(mockDb.db.transaction).toHaveBeenCalled();
      expect(committed).toEqual([]);
      expect(bareUpdateSets.find(s => s.status === 'failed')).toBeUndefined();
    });

    it('#1462: a job whose markJobFailed transaction aborts leaves currentJobPromise null', async () => {
      setupFailingJob({ id: 10, bookId: 100, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        let writeCount = 0;
        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => {
                const isBooks = writeCount > 0;
                writeCount++;
                if (isBooks) return { returning: vi.fn().mockImplementation(async () => { throw new Error('books write failed'); }) };
                return Promise.resolve({ rowsAffected: 1 });
              }),
            })),
          })),
        };
        await cb(tx);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const seam = worker as unknown as { currentJobPromise: Promise<void> | null };
      expect(seam.currentJobPromise).toBeNull();
    });

    it('#1462: stop() after a job whose markJobFailed transaction aborts resolves without rejecting', async () => {
      setupFailingJob({ id: 11, bookId: 110, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        let writeCount = 0;
        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => {
                const isBooks = writeCount > 0;
                writeCount++;
                if (isBooks) return { returning: vi.fn().mockImplementation(async () => { throw new Error('books write failed'); }) };
                return Promise.resolve({ rowsAffected: 1 });
              }),
            })),
          })),
        };
        await cb(tx);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      await expect(worker.stop()).resolves.toBeUndefined();
    });

    it('#1462: a rejected processJob still reaches runDrain — the canonical failure log is emitted', async () => {
      setupFailingJob({ id: 12, bookId: 120, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        let writeCount = 0;
        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(() => {
                const isBooks = writeCount > 0;
                writeCount++;
                if (isBooks) return { returning: vi.fn().mockImplementation(async () => { throw new Error('books write failed'); }) };
                return Promise.resolve({ rowsAffected: 1 });
              }),
            })),
          })),
        };
        await cb(tx);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const logErrMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const runnerErrCalls = logErrMock.error.mock.calls.filter((call: unknown[]) => call[1] === 'Drain runner failed unexpectedly');
      expect(runnerErrCalls).toHaveLength(1);
    });

    it('#1462: a successful import also leaves currentJobPromise null (finally guards the resolve path)', async () => {
      const okAdapter: ImportAdapter = { type: 'manual', async process() { /* resolves */ } };
      registerImportAdapter(okAdapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 13 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 13, bookId: 130, type: 'manual', status: 'processing', metadata: '{"title":"Good Book"}', phaseHistory: null }]) };
        if (selectCallCount === 4) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ title: 'Good Book' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const seam = worker as unknown as { currentJobPromise: Promise<void> | null };
      expect(seam.currentJobPromise).toBeNull();
    });
  });

  // A failure write may change books.status only while it is still importing (#1470).

  describe('#1470 guarded failure write preserves the bookStatusAtGrab revert', () => {
    function setupGuardedFailingJob(jobRow: Record<string, unknown>, state: { bookStatus: BookStatus | null }) {
      const adapter: ImportAdapter = {
        type: 'manual',
        async process() { throw new Error('copy verification failed'); },
      };
      registerImportAdapter(adapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: jobRow.id }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([jobRow]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));

      const guarded = makeGuardedTxUpdate(state);
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ update: guarded.update }));
      return guarded;
    }

    it('re-import failure: a book already reverted to imported is NOT clobbered to failed (guard miss)', async () => {
      const state = { bookStatus: 'imported' as BookStatus | null };
      const guarded = setupGuardedFailingJob(
        { id: 8, bookId: 80, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Reimported Book"}', phaseHistory: null },
        state,
      );

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(guarded.jobWrites.find(s => s.status === 'failed' && s.phase === 'failed')).toBeDefined();
      expect(guarded.bookWrites).toHaveLength(1);
      expect(guarded.bookWrites[0]!.payload).toMatchObject({ status: 'failed' });
      expect(guarded.bookWrites[0]!.returningCalled).toBe(true);
      expect(guarded.bookWrites[0]!.guardMatched).toBe(false);
      expect(state.bookStatus).toBe('imported');
    });

    // AC2 (#2307): the incident's error named only an internal download id. The worker already holds
    // job.bookId, so the failure log carries it at no query cost.
    it('the Import job failed log names the book id alongside the job id', async () => {
      setupGuardedFailingJob(
        { id: 8, bookId: 80, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Reimported Book"}', phaseHistory: null },
        { bookStatus: 'importing' as BookStatus | null },
      );

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const failure = vi.mocked(log.error).mock.calls.find(([, msg]) => msg === 'Import job failed');
      expect(failure).toBeDefined();
      expect(failure![0]).toMatchObject({ jobId: 8, bookId: 80 });
      // A raw Error would satisfy objectContaining({ message }); `type` is what serializeError adds.
      expect((failure![0] as { error: Record<string, unknown> }).error.type).toBe('Error');
    });

    it('fresh-grab failure: a book already reverted to wanted is NOT clobbered to failed (guard miss)', async () => {
      const state = { bookStatus: 'wanted' as BookStatus | null };
      const guarded = setupGuardedFailingJob(
        { id: 9, bookId: 90, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Wanted Book"}', phaseHistory: null },
        state,
      );

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(guarded.jobWrites.find(s => s.status === 'failed' && s.phase === 'failed')).toBeDefined();
      expect(guarded.bookWrites[0]!.guardMatched).toBe(false);
      expect(state.bookStatus).toBe('wanted');
    });

    it('no revert ran: a still-importing book settles to failed (guard match)', async () => {
      const state = { bookStatus: 'importing' as BookStatus | null };
      const guarded = setupGuardedFailingJob(
        { id: 10, bookId: 100, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Importing Book"}', phaseHistory: null },
        state,
      );

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(guarded.jobWrites.find(s => s.status === 'failed' && s.phase === 'failed')).toBeDefined();
      expect(guarded.bookWrites[0]!.returningCalled).toBe(true);
      expect(guarded.bookWrites[0]!.guardMatched).toBe(true);
      expect(state.bookStatus).toBe('failed');
    });

    // Boot recovery never writes books; this guard covers only drain-time markJobFailed.

    it('unknown adapter: a still-importing book settles to failed via the guarded markJobFailed write', async () => {
      const state = { bookStatus: 'importing' as BookStatus | null };
      const guarded = makeGuardedTxUpdate(state);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 5 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 5, bookId: 50, type: 'manual', status: 'processing', metadata: '{}' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation(() => ({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) })),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ update: guarded.update }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      const failedJob = guarded.jobWrites.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(failedJob).toBeDefined();
      expect(JSON.parse(failedJob!.lastError as string).message).toContain('No import adapter registered');
      expect(guarded.bookWrites[0]!.returningCalled).toBe(true);
      expect(guarded.bookWrites[0]!.guardMatched).toBe(true);
      expect(state.bookStatus).toBe('failed');
    });
  });

  describe('#681 auto-import phase history', () => {
    function setupAutoJob(jobRow: Record<string, unknown>) {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: jobRow.id }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([jobRow]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
    }

    it('successful auto-import persists analyzing → copying → renaming → fetching_metadata with startedAt/completedAt on each entry', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      let receivedCallbacks: ImportProgressCallbacks | undefined;
      const orchestratorStub = inject<ImportOrchestrator>({
        importDownload: vi.fn().mockImplementation(async (_id: number, callbacks?: ImportProgressCallbacks) => {
          receivedCallbacks = callbacks;
          await callbacks?.setPhase?.('copying');
          await callbacks?.setPhase?.('renaming');
          await callbacks?.setPhase?.('fetching_metadata');
          return { downloadId: 99, bookId: 202, targetPath: '/lib/book', fileCount: 1, totalSize: 1000 };
        }),
      });
      registerImportAdapter(new AutoImportAdapter(orchestratorStub));

      setupAutoJob({ id: 101, bookId: 202, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      expect(orchestratorStub.importDownload).toHaveBeenCalledWith(99, expect.objectContaining({
        setPhase: expect.any(Function),
        emitProgress: expect.any(Function),
      }), { bookId: 202 });
      expect(receivedCallbacks?.setPhase).toBeDefined();
      expect(receivedCallbacks?.emitProgress).toBeDefined();

      const completionUpdate = updateSets.find(s => s.status === 'completed' && s.phaseHistory);
      expect(completionUpdate).toBeDefined();
      const history = JSON.parse(completionUpdate!.phaseHistory as string) as Array<{ phase: string; startedAt: number; completedAt?: number }>;
      const phases = history.map(h => h.phase);
      expect(phases).toEqual(['analyzing', 'copying', 'renaming', 'fetching_metadata']);
      for (const entry of history) {
        expect(entry.startedAt).toBeTypeOf('number');
        expect(entry.completedAt).toBeTypeOf('number');
      }
    });

    it('auto-import failure during copy persists copying as the most recent closed phase', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const orchestratorStub = inject<ImportOrchestrator>({
        importDownload: vi.fn().mockImplementation(async (_id: number, callbacks?: ImportProgressCallbacks) => {
          await callbacks?.setPhase?.('copying');
          throw new Error('ENOSPC: disk full');
        }),
      });
      registerImportAdapter(new AutoImportAdapter(orchestratorStub));

      setupAutoJob({ id: 202, bookId: 303, type: 'auto', status: 'processing', metadata: '{"downloadId":77}', phaseHistory: null });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedUpdate = updateSets.find(s => s.status === 'failed' && s.phase === 'failed' && s.phaseHistory);
      expect(failedUpdate).toBeDefined();
      const history = JSON.parse(failedUpdate!.phaseHistory as string) as Array<{ phase: string; startedAt: number; completedAt?: number }>;
      const lastEntry = history[history.length - 1];
      expect(lastEntry!.phase).toBe('copying');
      expect(lastEntry!.completedAt).toBeTypeOf('number');
    });
  });

  describe('#707 nullable book_id propagation in SSE payloads', () => {
    function setupNullBookIdJob(adapter: ImportAdapter) {
      registerImportAdapter(adapter);
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 11 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 11, bookId: null, type: 'manual', status: 'processing', metadata: '{"title":"Orphan"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));
    }

    it('emits null (not 0) for book_id on phase_change, progress, and complete when job.bookId is null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      setupNullBookIdJob({
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
          ctx.emitProgress('analyzing', 0.25);
        },
      });

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const phaseChangeCall = emitSpy.mock.calls.find(c => c[0] === 'import_phase_change');
      expect(phaseChangeCall).toBeDefined();
      expect(phaseChangeCall![1].book_id).toBeNull();
      expect(phaseChangeCall![1].book_id).not.toBe(0);

      const progressCall = emitSpy.mock.calls.find(c => c[0] === 'import_progress');
      expect(progressCall).toBeDefined();
      expect(progressCall![1].book_id).toBeNull();
      expect(progressCall![1].book_id).not.toBe(0);

      const completeCall = emitSpy.mock.calls.find(c => c[0] === 'import_complete');
      expect(completeCall).toBeDefined();
      expect(completeCall![1].book_id).toBeNull();
      expect(completeCall![1].download_id).toBeNull();
      expect(completeCall![1].book_id).not.toBe(0);
      expect(completeCall![1].download_id).not.toBe(0);
    });

    it('emits null (not 0) for book_id on import_failed when job.bookId is null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      setupNullBookIdJob({
        type: 'manual',
        async process() { throw new Error('boom'); },
      });

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedCall = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failedCall).toBeDefined();
      expect(failedCall![1].book_id).toBeNull();
      expect(failedCall![1].book_id).not.toBe(0);
    });

    it('boot recovery: an orphan with null bookId skips the book-status read and writes only the job row', async () => {
      const orphanRows = [{ id: 77, bookId: null }];

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(orphanRows) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const txUpdate = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ update: txUpdate }));

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(txUpdate).toHaveBeenCalledTimes(1);
    });

    it('markJobFailed still uses null comparison (not sentinel) — failed job with null bookId skips books update', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      setupNullBookIdJob({
        type: 'manual',
        async process() { throw new Error('boom'); },
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockImplementation(() => updateWhereTerminus()) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const booksFailedUpdate = updateSets.find(s => s.status === 'failed' && !('phase' in s) && !('lastError' in s));
      expect(booksFailedUpdate).toBeUndefined();

      const jobFailedUpdate = updateSets.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(jobFailedUpdate).toBeDefined();
    });
  });

  // Real adapters must receive null unchanged; coercing to 0 bypasses their guards
  // and corrupts the SSE book_id (#717).

  describe('#717 real adapters reject null bookId end-to-end', () => {
    function setupNullBookIdRealAdapter(adapter: ImportAdapter, jobType: 'manual' | 'auto', metadataJson: string) {
      registerImportAdapter(adapter);
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 11 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 11, bookId: null, type: jobType, status: 'processing', metadata: metadataJson, phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));
    }

    it('ManualImportAdapter throws "requires a bookId" and worker emits import_failed with book_id:null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const bookServiceGetById = vi.fn();
      const settingsServiceGet = vi.fn();
      const eventHistoryCreate = vi.fn();
      const deps = inject<ImportPipelineDeps>({
        db: mockDb.db, log,
        bookService: { getById: bookServiceGetById },
        settingsService: { get: settingsServiceGet },
        eventHistory: { create: eventHistoryCreate },
        enrichmentDeps: {},
        broadcaster: mockBroadcaster as never,
      });
      const realAdapter = new ManualImportAdapter(deps);

      setupNullBookIdRealAdapter(realAdapter, 'manual', '{"path":"/audiobooks/Orphan","title":"Orphan Manual"}');

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedCall = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failedCall).toBeDefined();
      const payload = failedCall![1];
      expect(payload.error_message).toContain('requires a bookId');

      const parsed = importFailedPayload.safeParse(payload);
      expect(parsed.success).toBe(true);
      expect(payload.book_id).toBeNull();
      expect(payload.book_id).not.toBe(0);
      expect(payload.job_id).toBe(11);
      expect(payload.book_title).toBe('Orphan Manual');
      expect(payload.phase).toBeTypeOf('string');
      expect(payload.phase.length).toBeGreaterThan(0);
      expect(payload.error_message).toBeTypeOf('string');
      expect(payload.error_message.length).toBeGreaterThan(0);

      expect(bookServiceGetById).not.toHaveBeenCalled();
      expect(settingsServiceGet).not.toHaveBeenCalled();
      // A fifth select would mean the adapter reached its own books lookup.
      expect(mockDb.db.select.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('AutoImportAdapter throws "requires a bookId" and worker emits import_failed with book_id:null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const orchestratorStub = inject<ImportOrchestrator>({
        importDownload: vi.fn(),
      });
      const realAdapter = new AutoImportAdapter(orchestratorStub);

      setupNullBookIdRealAdapter(realAdapter, 'auto', '{"title":"Orphan Auto","downloadId":42}');

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      expect(orchestratorStub.importDownload).not.toHaveBeenCalled();

      const failedCall = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failedCall).toBeDefined();
      const payload = failedCall![1];
      expect(payload.error_message).toContain('requires a bookId');

      const parsed = importFailedPayload.safeParse(payload);
      expect(parsed.success).toBe(true);
      expect(payload.book_id).toBeNull();
      expect(payload.book_id).not.toBe(0);
      expect(payload.job_id).toBe(11);
      expect(payload.book_title).toBe('Unknown');
      expect(payload.phase).toBeTypeOf('string');
      expect(payload.phase.length).toBeGreaterThan(0);
      expect(payload.error_message).toBeTypeOf('string');
      expect(payload.error_message.length).toBeGreaterThan(0);
    });
  });

  // The schema discriminator blocks malformed manual titles from SSE; auto titles
  // are always Unknown, and extractTitle must never throw (#836).
  describe('#836 extractTitle', () => {
    type WithExtractTitle = {
      extractTitle(metadata: string, type: 'manual' | 'auto'): string;
    };
    function getExtractTitle(): (metadata: string, type: 'manual' | 'auto') => string {
      const w = worker as unknown as WithExtractTitle;
      return w.extractTitle.bind(w);
    }

    describe('manual jobs', () => {
      it('returns the validated title from a valid manual payload', () => {
        const fn = getExtractTitle();
        expect(fn('{"path":"/lib/Book","title":"My Book"}', 'manual')).toBe('My Book');
      });

      it("returns 'Unknown' when title is a number", () => {
        const fn = getExtractTitle();
        expect(fn('{"path":"/lib/Book","title":42}', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' when title is an object", () => {
        const fn = getExtractTitle();
        expect(fn('{"path":"/lib/Book","title":{}}', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' when title is an array", () => {
        const fn = getExtractTitle();
        expect(fn('{"path":"/lib/Book","title":[1,2,3]}', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' when title is null", () => {
        const fn = getExtractTitle();
        expect(fn('{"path":"/lib/Book","title":null}', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' when title is missing", () => {
        const fn = getExtractTitle();
        expect(fn('{}', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' for malformed JSON (does not throw)", () => {
        const fn = getExtractTitle();
        expect(() => fn('not json', 'manual')).not.toThrow();
        expect(fn('not json', 'manual')).toBe('Unknown');
      });

      it("returns 'Unknown' for the literal string 'null' (does not throw TypeError)", () => {
        const fn = getExtractTitle();
        expect(() => fn('null', 'manual')).not.toThrow();
        expect(fn('null', 'manual')).toBe('Unknown');
      });
    });

    describe('auto jobs', () => {
      it("returns 'Unknown' for a canonical auto payload (no title field)", () => {
        const fn = getExtractTitle();
        expect(fn('{"downloadId":123}', 'auto')).toBe('Unknown');
      });

      it("returns 'Unknown' even when legacy auto metadata carries a stray title", () => {
        const fn = getExtractTitle();
        expect(fn('{"title":"X","downloadId":42}', 'auto')).toBe('Unknown');
      });
    });

    // Helper tests cannot catch a call site hard-coding manual or dropping job.type;
    // a valid-manual-shaped auto payload exposes that regression by leaking its title.
    describe('call-site book_title coverage on auto stray-title metadata', () => {
      const STRAY_TITLE_METADATA = '{"path":"/lib/Stray","title":"Stray Auto","downloadId":42}';

      function setupAutoJobRow(metadata: string, opts: { id: number; bookId: number | null }) {
        let selectCallCount = 0;
        mockDb.db.select = vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
          if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: opts.id }]) };
          if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: opts.id, bookId: opts.bookId, type: 'auto', status: 'processing', metadata, phaseHistory: null }]) };
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
        });
        mockDb.db.update = vi.fn().mockImplementation(() => ({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
        }));
      }

      it('import_phase_change emits book_title:"Unknown" (call site at import-queue-worker.ts:226)', async () => {
        const emitSpy = vi.fn();
        const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
        registerImportAdapter({
          type: 'auto',
          async process(_job: ImportJob, ctx) { await ctx.setPhase('analyzing'); },
        });
        setupAutoJobRow(STRAY_TITLE_METADATA, { id: 200, bookId: 300 });

        await w.start();
        await new Promise(r => setTimeout(r, 100));
        await w.stop();

        const phaseChange = emitSpy.mock.calls.find(c => c[0] === 'import_phase_change');
        expect(phaseChange).toBeDefined();
        expect(phaseChange![1].book_title).toBe('Unknown');
        expect(phaseChange![1].book_title).not.toBe('Stray Auto');
      });

      it('import_progress emits book_title:"Unknown" (call site at import-queue-worker.ts:231)', async () => {
        const emitSpy = vi.fn();
        const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
        registerImportAdapter({
          type: 'auto',
          async process(_job: ImportJob, ctx) { ctx.emitProgress('analyzing', 0.5); },
        });
        setupAutoJobRow(STRAY_TITLE_METADATA, { id: 201, bookId: 301 });

        await w.start();
        await new Promise(r => setTimeout(r, 100));
        await w.stop();

        const progress = emitSpy.mock.calls.find(c => c[0] === 'import_progress');
        expect(progress).toBeDefined();
        expect(progress![1].book_title).toBe('Unknown');
        expect(progress![1].book_title).not.toBe('Stray Auto');
      });

      it('import_failed on unknown-adapter path with orphan bookId=null emits book_title:"Unknown" (call site at import-queue-worker.ts:188)', async () => {
        const emitSpy = vi.fn();
        const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
        setupAutoJobRow(STRAY_TITLE_METADATA, { id: 202, bookId: null });

        await w.start();
        await new Promise(r => setTimeout(r, 100));
        await w.stop();

        const failed = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
        expect(failed).toBeDefined();
        expect(failed![1].book_title).toBe('Unknown');
        expect(failed![1].book_title).not.toBe('Stray Auto');
        expect(failed![1].error_message).toContain('No import adapter registered for type "auto"');
      });

      it('#1094 import_failed on unknown-adapter path with bookId set resolves book_title from the DB row', async () => {
        const emitSpy = vi.fn();
        const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
        let selectCallCount = 0;
        mockDb.db.select = vi.fn().mockImplementation(() => {
          selectCallCount++;
          if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
          if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 203 }]) };
          if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 203, bookId: 303, type: 'auto', status: 'processing', metadata: STRAY_TITLE_METADATA, phaseHistory: null }]) };
          if (selectCallCount === 4) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ title: 'Real Title' }]) };
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
        });
        mockDb.db.update = vi.fn().mockImplementation(() => ({
          set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
        }));

        await w.start();
        await new Promise(r => setTimeout(r, 100));
        await w.stop();

        const failed = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
        expect(failed).toBeDefined();
        expect(failed![1].book_title).toBe('Real Title');
        expect(failed![1].book_title).not.toBe('Unknown');
        expect(failed![1].book_title).not.toBe('Stray Auto');
        expect(failed![1].error_message).toContain('No import adapter registered for type "auto"');
      });
    });
  });

  // A DB title wins when present; null, missing, or failed lookups silently fall
  // back to the schema-derived title (#1094).
  describe('#1094 import_complete/import_failed book_title resolved from books row', () => {
    function setupJobWithBooksRow(opts: {
      jobRow: Record<string, unknown>;
      booksRow: Array<Record<string, unknown>> | (() => Promise<never>);
    }) {
      // Select 4 is title lookup when bookId exists; otherwise it is the next candidate probe.
      const expectsBooksLookup = opts.jobRow.bookId !== null;
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: opts.jobRow.id }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([opts.jobRow]) };
        if (selectCallCount === 4 && expectsBooksLookup) {
          const limit = typeof opts.booksRow === 'function'
            ? vi.fn().mockImplementation(opts.booksRow)
            : vi.fn().mockResolvedValue(opts.booksRow);
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit };
        }
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));
    }

    it('auto-import success with bookId + books row → import_complete book_title is the enriched DB title (regression guard for the bug)', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'auto',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 401, bookId: 501, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null },
        booksRow: [{ title: 'Enriched Auto Title' }],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const completes = emitSpy.mock.calls.filter(c => c[0] === 'import_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]![1].book_title).toBe('Enriched Auto Title');
      expect(completes[0]![1].book_title).not.toBe('Unknown');
    });

    it('auto-import success with bookId=null → falls back to extractTitle (which returns "Unknown" for auto)', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'auto',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 402, bookId: null, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null },
        booksRow: [{ title: 'Should Not Surface' }],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const complete = emitSpy.mock.calls.find(c => c[0] === 'import_complete');
      expect(complete).toBeDefined();
      expect(complete![1].book_title).toBe('Unknown');
    });

    it('auto-import success with bookId set but no books row found → falls back to extractTitle "Unknown" (lookup-miss path)', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'auto',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 403, bookId: 503, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null },
        booksRow: [],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const complete = emitSpy.mock.calls.find(c => c[0] === 'import_complete');
      expect(complete).toBeDefined();
      expect(complete![1].book_title).toBe('Unknown');
    });

    it('auto-import success: books lookup throws → silently swallowed, falls back to extractTitle "Unknown"', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'auto',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 404, bookId: 504, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null },
        booksRow: async () => { throw new Error('db unreachable'); },
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const completeCall = emitSpy.mock.calls.find(c => c[0] === 'import_complete');
      expect(completeCall).toBeDefined();
      expect(completeCall![1].book_title).toBe('Unknown');

      const logMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const swallowedErrorLog = logMock.error.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown> | undefined;
        const err = ctx && typeof ctx === 'object' ? (ctx.error as { message?: unknown } | undefined) : undefined;
        return err?.message === 'db unreachable';
      });
      expect(swallowedErrorLog).toBeUndefined();
    });

    it('manual-import success with metadata title + books row title → DB title wins over manual-supplied title', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'manual',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 405, bookId: 505, type: 'manual', status: 'processing', metadata: '{"path":"/lib/Book","title":"User Title"}', phaseHistory: null },
        booksRow: [{ title: 'Enriched Title' }],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const completes = emitSpy.mock.calls.filter(c => c[0] === 'import_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]![1].book_title).toBe('Enriched Title');
      expect(completes[0]![1].book_title).not.toBe('User Title');
    });

    it('manual-import success with bookId set but no books row → falls back to the Zod-validated manual title (not "Unknown")', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'manual',
        async process() { /* success */ },
      });
      setupJobWithBooksRow({
        jobRow: { id: 406, bookId: 506, type: 'manual', status: 'processing', metadata: '{"path":"/lib/Book","title":"User Title"}', phaseHistory: null },
        booksRow: [],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const complete = emitSpy.mock.calls.find(c => c[0] === 'import_complete');
      expect(complete).toBeDefined();
      expect(complete![1].book_title).toBe('User Title');
    });

    it('auto-import failure with bookId + books row → import_failed book_title is the enriched DB title', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({
        type: 'auto',
        async process() { throw new Error('mid-import failure'); },
      });
      setupJobWithBooksRow({
        jobRow: { id: 407, bookId: 507, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null },
        booksRow: [{ title: 'Real Title' }],
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      const failed = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failed).toBeDefined();
      expect(failed![1].book_title).toBe('Real Title');
      expect(failed![1].book_title).not.toBe('Unknown');
      expect(failed![1].error_message).toContain('mid-import failure');
    });
  });

  // Wire the real orchestrator and adapter so any second import_complete emitter
  // is observable; the worker owns job completion, not the orchestrator (#1108).
  describe('#1108 single import_complete emit on auto-import success', () => {
    const mockContext: ImportContext = {
      downloadId: 99,
      downloadTitle: 'Some Release [2026]',
      downloadStatus: 'completed',
      bookId: 601,
      bookTitle: 'Test Book',
      bookStatus: 'wanted',
      bookStatusAtGrab: 'wanted',
      bookPath: null,
      authorName: 'Test Author',
      book: inject<ImportContext['book']>({
        id: 601, title: 'Test Book', status: 'wanted', path: null,
        narrators: [], seriesName: null, seriesPosition: null, coverUrl: null,
      }),
      infoHash: 'abc',
      guid: null,
    };

    const mockResult: ImportResult = {
      downloadId: 99,
      bookId: 601,
      targetPath: '/lib/Test Author/Test Book',
      fileCount: 3,
      totalSize: 1000,
    };

    it('real AutoImportAdapter + real ImportOrchestrator produce exactly ONE import_complete emit', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      const importService = inject<ImportService>({
        getImportContext: vi.fn().mockResolvedValue(mockContext),
        importDownload: vi.fn().mockImplementation(async (_id: number, callbacks?: ImportProgressCallbacks) => {
          await callbacks?.setPhase?.('copying');
          return mockResult;
        }),
      });
      const settingsService = createMockSettingsService();
      const orchestrator = new ImportOrchestrator(
        importService, settingsService, log,
        undefined /* notifier */, undefined /* tagging */, undefined /* eventHistory */,
        mockBroadcaster as never,
      );
      registerImportAdapter(new AutoImportAdapter(orchestrator));

      // Select order: recovery, candidate, job, DB title.
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 701 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 701, bookId: 601, type: 'auto', status: 'processing', metadata: '{"downloadId":99}', phaseHistory: null }]) };
        if (selectCallCount === 4) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ title: 'Test Book' }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockImplementation(() => updateWhereTerminus()) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const completes = emitSpy.mock.calls.filter(c => c[0] === 'import_complete');
      expect(completes).toHaveLength(1);
      expect(completes[0]![1]).toMatchObject({
        job_id: 701,
        book_id: 601,
        book_title: 'Test Book',
      });
      expect(completes[0]![1].elapsed_ms).toBeTypeOf('number');

      const downloadStatusEmits = emitSpy.mock.calls.filter(c => c[0] === 'download_status_change');
      const bookStatusEmits = emitSpy.mock.calls.filter(c => c[0] === 'book_status_change');
      expect(downloadStatusEmits.some(c => (c[1] as { new_status: string }).new_status === 'imported')).toBe(true);
      expect(bookStatusEmits.some(c => (c[1] as { new_status: string }).new_status === 'imported')).toBe(true);
    });
  });

  describe('nudge', () => {
    it('nudge wakes idle worker', async () => {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 20));
      const countBefore = selectCallCount;

      worker.nudge();
      await new Promise(r => setTimeout(r, 20));

      expect(selectCallCount).toBeGreaterThan(countBefore);
    });
  });

  describe('shutdown', () => {
    it('stops accepting nudges on stop()', async () => {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 20));
      await worker.stop();
      const countAfterStop = selectCallCount;

      worker.nudge();
      await new Promise(r => setTimeout(r, 20));

      expect(selectCallCount).toBe(countAfterStop);
    });
  });

  describe('startup marker sweep (#1338)', () => {
    function trackingSelect(): () => number {
      let selectCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCount++;
        if (selectCount === 1) {
          return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });
      return () => selectCount;
    }

    it('awaits the marker sweep before the drain loop issues its first job select (single recovery actor)', async () => {
      const selectCount = trackingSelect();
      const root = mkdtempSync(join(tmpdir(), 'narratorr-1338-order-'));
      // Gate root resolution to keep the sweep in flight.
      let releaseRoot!: (value: string) => void;
      const rootReady = new Promise<string>((res) => { releaseRoot = res; });
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, undefined, () => rootReady);

      const startPromise = w.start();
      // Let boot recovery finish while the sweep remains gated.
      await new Promise((r) => setImmediate(r));
      expect(selectCount()).toBe(1);

      releaseRoot(root);
      await startPromise;

      expect(selectCount()).toBeGreaterThan(1);

      await w.stop();
      await rm(root, { recursive: true, force: true });
    });

    it('converges a real stranded marker during start(), before draining (exactly one recovery actor)', async () => {
      trackingSelect();
      const root = mkdtempSync(join(tmpdir(), 'narratorr-1338-converge-'));
      const target = join(root, 'Author', 'Title');
      const backup = `${target}.import-bak`;
      const marker = `${target}.import-commit-pending`;
      await mkdir(backup, { recursive: true });
      await writeFile(join(backup, 'old.m4b'), Buffer.alloc(64, 7));
      await writeFile(marker, '');

      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, undefined, async () => root);
      await w.start();

      const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
      expect(await exists(marker)).toBe(false);
      expect(await exists(backup)).toBe(false);
      expect(await exists(join(target, 'old.m4b'))).toBe(true);

      await w.stop();
      await rm(root, { recursive: true, force: true });
    });

    it('is a no-op when no library-root resolver is injected', async () => {
      trackingSelect();
      await expect(worker.start()).resolves.toBeUndefined();
    });

    it('F2: a rejecting library-root resolver warns and still lets the worker start + drain', async () => {
      const selectCount = trackingSelect();
      const resolverError = new Error('settings read failed');
      const w = new ImportQueueWorker(
        inject<Db>(mockDb.db), log, undefined,
        () => Promise.reject(resolverError),
      );

      await expect(w.start()).resolves.toBeUndefined();

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.anything() }),
        expect.stringContaining('failed to resolve library root'),
      );
      expect(selectCount()).toBeGreaterThan(1);

      await w.stop();
    });
  });

  describe('#1960 companion-ebook reconcile on import completion', () => {
    async function runOneJob(opts: {
      jobRow: Record<string, unknown>;
      reconcileBook: (bookId: number) => Promise<void>;
      adapterProcess?: () => Promise<void>;
    }) {
      const trace: string[] = [];
      const emitSpy = vi.fn();
      const reconcileBook = vi.fn().mockImplementation((bookId: number) => {
        trace.push('reconcile');
        return opts.reconcileBook(bookId);
      });
      const w = new ImportQueueWorker(
        inject<Db>(mockDb.db), log, { emit: emitSpy } as never,
        undefined, undefined,
        { reconcileBook },
      );

      registerImportAdapter({
        type: opts.jobRow.type as 'auto' | 'manual',
        process: opts.adapterProcess ?? (() => Promise.resolve()),
      } as ImportAdapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: opts.jobRow.id }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([opts.jobRow]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const jobWrites: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          jobWrites.push(payload);
          return {
            where: vi.fn().mockImplementation(() => {
              if (payload.status === 'completed') trace.push('completion-update');
              if (payload.status === 'failed') trace.push('failure-update');
              return updateWhereTerminus();
            }),
          };
        }),
      }));

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      return { reconcileBook, trace, jobWrites, emitSpy };
    }

    const completedJob = (overrides: Record<string, unknown> = {}) => ({
      id: 900, bookId: 42, type: 'manual', status: 'processing',
      metadata: '{"title":"Test"}', phaseHistory: null, ...overrides,
    });

    it.each([
      ['auto', { type: 'auto', metadata: '{"downloadId":7}' }],
      ['manual copy', { type: 'manual', metadata: '{"title":"Test","mode":"copy"}' }],
      ['manual move', { type: 'manual', metadata: '{"title":"Test","mode":"move"}' }],
      ['pointer/adopt (mode undefined)', { type: 'manual', metadata: '{"title":"Test"}' }],
    ])('fires exactly one reconcileBook for the %s adapter', async (_label, overrides) => {
      const { reconcileBook } = await runOneJob({
        jobRow: completedJob(overrides),
        reconcileBook: () => Promise.resolve(),
      });

      expect(reconcileBook).toHaveBeenCalledTimes(1);
      expect(reconcileBook).toHaveBeenCalledWith(42);
    });

    it('AC4: the importJobs completion UPDATE is ISSUED before the trigger (weak ordering — see the gated test for persistence)', async () => {
      const { trace, jobWrites } = await runOneJob({
        jobRow: completedJob(),
        reconcileBook: () => Promise.resolve(),
      });

      expect(trace).toEqual(['completion-update', 'reconcile']);
      expect(jobWrites.some(w => w.status === 'completed' && w.phase === 'done')).toBe(true);
    });

    // where() records issuance synchronously, so an issuance trace cannot prove the
    // completion write was awaited. Gate its terminus to observe real persistence order.
    it('AC4: reconciliation does not start until the completion UPDATE has RESOLVED, not merely been issued', async () => {
      const events: string[] = [];
      let releasePersistence!: () => void;
      const persisted = new Promise<void>((r) => { releasePersistence = r; });
      let markIssued!: () => void;
      const issued = new Promise<void>((r) => { markIssued = r; });

      const reconcileBook = vi.fn().mockImplementation(() => {
        events.push('reconcile');
        return Promise.resolve();
      });
      const w = new ImportQueueWorker(
        inject<Db>(mockDb.db), log, { emit: vi.fn() } as never,
        undefined, undefined,
        { reconcileBook },
      );

      registerImportAdapter({ type: 'manual', process: () => Promise.resolve() } as ImportAdapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 900 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([completedJob()]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
          where: vi.fn().mockImplementation(() => {
            if (payload.status !== 'completed') return updateWhereTerminus();
            events.push('completion-issued');
            markIssued();
            // Awaitable and returning()-capable; neither settles until the test releases it.
            const settle = () => persisted.then(() => { events.push('completion-persisted'); });
            return {
              then: (resolve: (v: { rowsAffected: number }) => void, reject: (e: unknown) => void) =>
                settle().then(() => ({ rowsAffected: 1 })).then(resolve, reject),
              returning: vi.fn().mockImplementation(() => settle().then(() => [{ id: 1 }])),
            };
          }),
        })),
      }));

      await w.start();
      await issued;
      // Include a macrotask turn so a missing await cannot hide in queued work.
      await new Promise(r => setTimeout(r, 50));

      expect(events).toEqual(['completion-issued']);
      expect(reconcileBook).not.toHaveBeenCalled();

      releasePersistence();
      await new Promise(r => setTimeout(r, 50));

      expect(reconcileBook).toHaveBeenCalledTimes(1);
      expect(reconcileBook).toHaveBeenCalledWith(42);
      expect(events).toEqual(['completion-issued', 'completion-persisted', 'reconcile']);

      await w.stop();
    });

    it('AC6: no trigger when the job carries a null bookId', async () => {
      const { reconcileBook, jobWrites } = await runOneJob({
        jobRow: completedJob({ bookId: null }),
        reconcileBook: () => Promise.resolve(),
      });

      expect(reconcileBook).not.toHaveBeenCalled();
      expect(jobWrites.some(w => w.status === 'completed')).toBe(true);
    });

    it('AC5: no trigger on the failure path — the job goes to markJobFailed instead', async () => {
      const { reconcileBook, jobWrites } = await runOneJob({
        jobRow: completedJob(),
        reconcileBook: () => Promise.resolve(),
        adapterProcess: () => Promise.reject(new Error('adapter blew up')),
      });

      expect(reconcileBook).not.toHaveBeenCalled();
      expect(jobWrites.some(w => w.status === 'failed')).toBe(true);
      expect(jobWrites.some(w => w.status === 'completed')).toBe(false);
    });

    it('AC7: a REJECTING reconcileBook leaves the job completed, still emits import_complete, and never reaches markJobFailed', async () => {
      const { reconcileBook, trace, jobWrites, emitSpy } = await runOneJob({
        jobRow: completedJob(),
        reconcileBook: () => Promise.reject(new Error('reconcile rejected')),
      });

      expect(reconcileBook).toHaveBeenCalledTimes(1);
      expect(jobWrites.some(w => w.status === 'completed' && w.phase === 'done')).toBe(true);
      expect(jobWrites.some(w => w.status === 'failed')).toBe(false);
      expect(trace).not.toContain('failure-update');
      expect(emitSpy.mock.calls.filter(c => c[0] === 'import_complete')).toHaveLength(1);
      expect(emitSpy.mock.calls.filter(c => c[0] === 'import_failed')).toHaveLength(0);
    });

    it('AC7: a SYNCHRONOUSLY THROWING reconcileBook is equally isolated — the case fireAndForget alone does not cover', async () => {
      const { reconcileBook, trace, jobWrites, emitSpy } = await runOneJob({
        jobRow: completedJob(),
        // fireAndForget evaluates its promise argument before it can catch a synchronous throw.
        reconcileBook: () => { throw new Error('reconcile threw synchronously'); },
      });

      expect(reconcileBook).toHaveBeenCalledTimes(1);
      expect(jobWrites.some(w => w.status === 'completed' && w.phase === 'done')).toBe(true);
      expect(jobWrites.some(w => w.status === 'failed')).toBe(false);
      expect(trace).not.toContain('failure-update');
      expect(emitSpy.mock.calls.filter(c => c[0] === 'import_complete')).toHaveLength(1);
      expect(emitSpy.mock.calls.filter(c => c[0] === 'import_failed')).toHaveLength(0);
    });

    it('AC8: a worker constructed without a reconciler still completes jobs', async () => {
      const emitSpy = vi.fn();
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, { emit: emitSpy } as never);
      registerImportAdapter({ type: 'manual', process: () => Promise.resolve() } as ImportAdapter);

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) };
        if (selectCallCount === 2) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 901 }]) };
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([completedJob({ id: 901 })]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      await w.start();
      await new Promise(r => setTimeout(r, 100));
      await w.stop();

      expect(emitSpy.mock.calls.filter(c => c[0] === 'import_complete')).toHaveLength(1);
    });
  });
});
