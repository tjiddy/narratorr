import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { ImportQueueWorker } from './import-queue-worker.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter, ImportJob } from './import-adapters/types.js';
import { AutoImportAdapter } from './import-adapters/auto.js';
import { ManualImportAdapter } from './import-adapters/manual.js';
import type { ImportOrchestrator } from './import-orchestrator.js';
import type { ImportProgressCallbacks } from './import.service.js';
import type { ImportPipelineDeps } from './import-orchestration.helpers.js';
import { importFailedPayload } from '../../shared/schemas/sse-events.js';

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
  return {
    db: {
      select: vi.fn().mockReturnValue(chainMethods),
      update: vi.fn().mockReturnValue({ ...chainMethods, where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      insert: vi.fn().mockReturnValue(chainMethods),
      delete: vi.fn().mockReturnValue(chainMethods),
      transaction: vi.fn(),
    },
    setMock,
    whereMock,
    limitMock,
  };
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

  describe('boot recovery', () => {
    /**
     * Wires a boot-recovery select that returns `orphans`, plus drain-loop
     * selects that always return empty. Returns `updateSets` collected from
     * every transactional update so tests can assert the write payloads.
     */
    function setupBootRecovery(orphans: Array<{ id: number; bookId: number | null }>) {
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue(orphans),
          };
        }
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      const updateSets: Array<{ payload: Record<string, unknown>; viaTx: boolean }> = [];

      const makeUpdate = (viaTx: boolean) => vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push({ payload, viaTx });
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      mockDb.db.update = makeUpdate(false);

      const tx = {
        update: makeUpdate(true),
      };

      // Default: real behavior — tx runs callback and resolves. Tests can override per-orphan.
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (txArg: unknown) => Promise<unknown>) => cb(tx));

      return { updateSets, tx };
    }

    it('marks processing rows as failed with last_error JSON on startup', async () => {
      const { updateSets } = setupBootRecovery([{ id: 99, bookId: 42 }]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      // Both writes should have gone through the transaction handle
      const txWrites = updateSets.filter(u => u.viaTx);
      expect(txWrites).toHaveLength(2);

      const jobWrite = txWrites[0].payload;
      expect(jobWrite).toMatchObject({ status: 'failed', phase: 'failed' });
      const lastError = JSON.parse(jobWrite.lastError as string);
      expect(lastError.message).toBe('Interrupted by server restart');
      expect(lastError.type).toBe('ProcessRestart');

      expect(txWrites[1].payload).toMatchObject({ status: 'failed' });
    });

    it('atomicity: when the books write throws, the jobs write is rolled back — no committed state for that orphan', async () => {
      // F1: Model the transaction rollback contract at the mock layer.
      // Each write is first "staged" inside the tx callback. Only when the callback
      // resolves cleanly do staged writes get "committed". If the callback throws,
      // the staged writes for that transaction are discarded (rolled back).
      // The service MUST observe zero committed writes for the failed orphan.
      setupBootRecovery([{ id: 99, bookId: 42 }]);

      const committed: Array<{ table: 'jobs' | 'books'; payload: Record<string, unknown> }> = [];

      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const staged: Array<{ table: 'jobs' | 'books'; payload: Record<string, unknown> }> = [];
        let writeCount = 0;

        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
              where: vi.fn().mockImplementation(async () => {
                // First update() in each tx = import_jobs, second = books (matches source order)
                const table: 'jobs' | 'books' = writeCount === 0 ? 'jobs' : 'books';
                writeCount++;
                if (table === 'books') {
                  // Throw AFTER the jobs write has been staged. A real libSQL tx
                  // would roll the jobs write back because this throw aborts the tx.
                  throw new Error('books write failed');
                }
                staged.push({ table, payload });
                return { rowsAffected: 1 };
              }),
            })),
          })),
        };

        // Only commit staged writes if the callback resolves cleanly (mirrors
        // the real tx/rollback contract: exceptions discard the staged changes).
        await cb(tx);
        committed.push(...staged);
      });

      const rawUpdateSpy = mockDb.db.update as unknown as ReturnType<typeof vi.fn>;
      rawUpdateSpy.mockClear();

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      // Rollback contract: the jobs write that was staged before the books throw
      // is NOT visible after the sweep. The orphan's pre-recovery state is intact.
      expect(committed).toEqual([]);
      // Exactly one tx was attempted (the one orphan) and no bare update leaked out
      expect(mockDb.db.transaction).toHaveBeenCalledTimes(1);
      expect(rawUpdateSpy).not.toHaveBeenCalled();

      // The per-orphan failure is logged at error level with jobId/bookId context
      const logMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const errorCalls = logMock.error.mock.calls.filter(
        (call: unknown[]) => {
          const ctx = call[0] as Record<string, unknown>;
          return ctx && ctx.jobId === 99 && ctx.bookId === 42 && 'error' in ctx;
        },
      );
      expect(errorCalls.length).toBe(1);

      // Summary reflects the rollback: 0 recovered, 1 failed
      const logInfoMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logInfoMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 1 && ctx.recovered === 0 && ctx.failed === 1;
      });
      expect(summaryCall).toBeDefined();
    });

    it('continue-on-error: A and C are fully failed-state-updated while B (the failing orphan) has NO committed writes', async () => {
      // F2: Assert the concrete end-state of A/B/C writes, not just loop progression.
      // A and C each produce TWO committed writes (import_jobs + books) with the
      // failed-state payload. B's transaction throws, so NEITHER of B's staged
      // writes is committed. The summary log reflects recovered=2, failed=1.
      setupBootRecovery([
        { id: 1, bookId: 10 },
        { id: 2, bookId: 20 },
        { id: 3, bookId: 30 },
      ]);

      const committed: Array<{ orphanIdx: number; table: 'jobs' | 'books'; payload: Record<string, unknown> }> = [];
      let txCallIdx = 0;

      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        const thisOrphanIdx = txCallIdx++;
        const staged: Array<{ orphanIdx: number; table: 'jobs' | 'books'; payload: Record<string, unknown> }> = [];
        let writeCount = 0;

        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation((payload: Record<string, unknown>) => ({
              where: vi.fn().mockImplementation(async () => {
                const table: 'jobs' | 'books' = writeCount === 0 ? 'jobs' : 'books';
                writeCount++;
                // Orphan B (index 1): throw after the jobs write is staged
                if (thisOrphanIdx === 1) {
                  throw new Error('orphan B blew up');
                }
                staged.push({ orphanIdx: thisOrphanIdx, table, payload });
                return { rowsAffected: 1 };
              }),
            })),
          })),
        };

        await cb(tx);
        committed.push(...staged);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      // --- Concrete end-state assertions ---
      const aWrites = committed.filter(w => w.orphanIdx === 0);
      const bWrites = committed.filter(w => w.orphanIdx === 1);
      const cWrites = committed.filter(w => w.orphanIdx === 2);

      // A: both import_jobs and books committed with failed-state payload
      expect(aWrites).toHaveLength(2);
      expect(aWrites[0].table).toBe('jobs');
      expect(aWrites[0].payload).toMatchObject({
        status: 'failed',
        phase: 'failed',
        lastError: expect.stringContaining('ProcessRestart') as unknown as string,
      });
      expect(aWrites[1].table).toBe('books');
      expect(aWrites[1].payload).toMatchObject({ status: 'failed' });

      // B: NOTHING committed — rollback contract held
      expect(bWrites).toEqual([]);

      // C: same failed-state pair as A
      expect(cWrites).toHaveLength(2);
      expect(cWrites[0].payload).toMatchObject({ status: 'failed', phase: 'failed' });
      expect(cWrites[1].payload).toMatchObject({ status: 'failed' });

      // Summary: count=3, recovered=2 (A and C), failed=1 (B)
      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 3 && ctx.recovered === 2 && ctx.failed === 1;
      });
      expect(summaryCall).toBeDefined();

      // Per-orphan error log exists for B specifically (and only for B)
      const logErrMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const bErrorCalls = logErrMock.error.mock.calls.filter((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.jobId === 2 && ctx.bookId === 20;
      });
      expect(bErrorCalls).toHaveLength(1);
      const aErrorCalls = logErrMock.error.mock.calls.filter((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.jobId === 1;
      });
      const cErrorCalls = logErrMock.error.mock.calls.filter((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.jobId === 3;
      });
      expect(aErrorCalls).toHaveLength(0);
      expect(cErrorCalls).toHaveLength(0);
    });

    it('per-orphan error log carries a serialized error (message + type fields from serializeError())', async () => {
      // F3: Verify the log payload is the shape produced by serializeError(),
      // not just "some object". A raw Error would fail these assertions because
      // Pino serializes Error instances to {} and serializeError() extracts
      // message/type/stack into plain properties.
      setupBootRecovery([{ id: 99, bookId: 42 }]);

      const thrown = new TypeError('books write failed');
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
        let writeCount = 0;
        const tx = {
          update: vi.fn().mockImplementation(() => ({
            set: vi.fn().mockImplementation(() => ({
              where: vi.fn().mockImplementation(async () => {
                if (writeCount++ === 0) return { rowsAffected: 1 };
                throw thrown;
              }),
            })),
          })),
        };
        await cb(tx);
      });

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      const logMock = log as unknown as { error: ReturnType<typeof vi.fn> };
      const errorCall = logMock.error.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.jobId === 99 && ctx.bookId === 42 && 'error' in ctx;
      });
      expect(errorCall).toBeDefined();

      const errorCtx = errorCall![0] as { error: Record<string, unknown> };
      // serializeError() produces { message, type, stack? } — NOT a raw Error
      // (a raw Error would have no enumerable message property, since Error.message
      // is defined on the instance via defineProperty but serializeError explicitly
      // lifts it onto a plain object).
      expect(errorCtx.error).toBeTypeOf('object');
      expect(errorCtx.error.message).toBe('books write failed');
      expect(errorCtx.error.type).toBe('TypeError');
      // The shape is a plain object, not an Error instance (proves extraction happened)
      expect(errorCtx.error).not.toBeInstanceOf(Error);
    });

    it('summary log is emitted after a fully-successful sweep', async () => {
      setupBootRecovery([
        { id: 1, bookId: 10 },
        { id: 2, bookId: 20 },
      ]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 2 && ctx.recovered === 2 && ctx.failed === 0;
      });
      expect(summaryCall).toBeDefined();
    });

    it('orphan with null bookId skips the books update but still succeeds', async () => {
      const { tx } = setupBootRecovery([{ id: 77, bookId: null }]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      // tx.update was called exactly once (importJobs only, no books)
      expect(tx.update).toHaveBeenCalledTimes(1);

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && ctx.count === 1 && ctx.recovered === 1 && ctx.failed === 0;
      });
      expect(summaryCall).toBeDefined();
    });

    it('empty orphan set: no updates, no summary log, early return', async () => {
      setupBootRecovery([]);

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      expect(mockDb.db.transaction).not.toHaveBeenCalled();
      expect(mockDb.db.update).not.toHaveBeenCalled();

      const logMock = log as unknown as { info: ReturnType<typeof vi.fn> };
      const summaryCall = logMock.info.mock.calls.find((call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx && 'recovered' in ctx && 'failed' in ctx;
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
    // Private-method bypass seam for direct assertion. `start()` fire-and-forgets
    // `drainLoop()` (import-queue-worker.ts:124-145) so drainOne() rejections
    // never surface through the public API — direct invocation is the only seam.
    type DrainSeam = { drainOne(): Promise<boolean> };

    function setupSingleCandidate(claimResult: unknown) {
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
  });

  // #635 spec asked for a "concurrent claim race" test. No dedicated test was
  // added because the contract it cared about is already covered. Production
  // wires one ImportQueueWorker, so cross-worker races are not possible today.
  // Within the worker, drain() can be invoked concurrently from initial-start,
  // the nudge listener, and the safety-net poll (no reentrancy guard) — but
  // the atomic CAS UPDATE in drainOne() reduces the contract to a lost-race
  // retry, which is exercised by the "drainOne CAS claim — returns true on
  // lost race" test above. If multi-worker support or a reentrancy guard for
  // drain() is added later, this assumption needs to be revisited.
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
        // Boot recovery: no orphans
        if (selectCallCount === 1) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([]),
          };
        }
        // Drain candidates
        if (selectCallCount === 2) {
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 1 }]),
          };
        }
        if (selectCallCount === 3) {
          // Full job fetch for job 1
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
            orderBy: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 2 }]),
          };
        }
        if (selectCallCount === 5) {
          // Full job fetch for job 2
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue([{ id: 2, bookId: 20, type: 'manual', status: 'processing', metadata: '{}' }]),
          };
        }
        // No more
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]),
        };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      expect(processedIds).toContain(1);
      expect(processedIds).toContain(2);
    });

    it('unknown adapter type marks row failed with books.status=failed', async () => {
      // No adapters registered — type 'manual' is unknown

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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await worker.start();
      await new Promise(r => setTimeout(r, 100));

      // Should have: claim update, job failed update, book failed update
      const failedJob = updateSets.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(failedJob).toBeDefined();
      expect(failedJob!.lastError).toBeDefined();
      const errorJson = JSON.parse(failedJob!.lastError as string);
      expect(errorJson.message).toContain('No import adapter registered');

      const failedBook = updateSets.filter(s => s.status === 'failed' && !('phase' in s));
      expect(failedBook.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // #637 — Phase history persistence + event wiring
  // ===========================================================================

  describe('#637 phase history persistence', () => {
    it('setPhase appends new phaseHistory entry with startedAt', async () => {
      const mockBroadcaster = { emit: vi.fn() };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      // Register a simple adapter that calls setPhase
      const adapter: ImportAdapter = {
        type: 'manual',
        async process(_job: ImportJob, ctx) {
          await ctx.setPhase('analyzing');
        },
      };
      registerImportAdapter(adapter);

      // Mock: boot recovery = no orphans, 1 pending job, then no more
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // Find the setPhase update that includes phaseHistory
      const phaseUpdate = updateSets.find(s => s.phase === 'analyzing' && s.phaseHistory);
      expect(phaseUpdate).toBeDefined();
      const history = JSON.parse(phaseUpdate!.phaseHistory as string);
      expect(history).toHaveLength(1);
      expect(history[0].phase).toBe('analyzing');
      expect(history[0].startedAt).toBeTypeOf('number');
      expect(history[0].completedAt).toBeUndefined();
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // The completion update should have phaseHistory with completedAt set
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
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // Should have emitted import_phase_change events
      const phaseChangeCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_phase_change'
      );
      expect(phaseChangeCalls.length).toBeGreaterThanOrEqual(1);
      // First phase change: queued → analyzing
      expect(phaseChangeCalls[0][1]).toMatchObject({
        job_id: 1,
        book_id: 10,
        from: 'queued',
        to: 'analyzing',
      });
    });

    it('worker emits import_complete on job success with job_id and elapsed_ms', async () => {
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
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 5, bookId: 50, type: 'manual', status: 'processing', metadata: '{"title":"My Book"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const completeCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_complete'
      );
      expect(completeCalls).toHaveLength(1);
      expect(completeCalls[0][1]).toMatchObject({
        job_id: 5,
        book_id: 50,
        book_title: 'My Book',
      });
      expect(completeCalls[0][1].elapsed_ms).toBeTypeOf('number');
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
        if (selectCallCount === 3) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([{ id: 7, bookId: 70, type: 'manual', status: 'processing', phase: 'copying', metadata: '{"title":"Failed Book"}', phaseHistory: null }]) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedCalls = emitSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'import_failed'
      );
      expect(failedCalls).toHaveLength(1);
      expect(failedCalls[0][1]).toMatchObject({
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // The failed-row update should include phaseHistory with closed entry
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
      // Should not throw with 3rd arg
      const w = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);
      expect(w).toBeDefined();
    });
  });

  // ===========================================================================
  // #681 — Auto-import phase history (analyzing → copying → renaming → fetching_metadata)
  // ===========================================================================

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

      // Orchestrator stub stands in for the real copy/rename/enrich pipeline —
      // it exercises the callback bag the adapter forwards, so removing the
      // forwarding in auto.ts would break this test. Orchestrator → service
      // → helper forwarding is verified at those layers' own unit tests.
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // The adapter must have forwarded the context's callback bag to the orchestrator —
      // otherwise the orchestrator stub could not invoke setPhase, and the history
      // would stop at 'analyzing'.
      expect(orchestratorStub.importDownload).toHaveBeenCalledWith(99, expect.objectContaining({
        setPhase: expect.any(Function),
        emitProgress: expect.any(Function),
      }));
      expect(receivedCallbacks?.setPhase).toBeDefined();
      expect(receivedCallbacks?.emitProgress).toBeDefined();

      // Final completion update carries the canonical phaseHistory snapshot
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

      // Stubbed orchestrator models a mid-copy failure — requires the adapter to
      // forward callbacks so setPhase('copying') lands in phaseHistory before
      // the pipeline throws.
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      const failedUpdate = updateSets.find(s => s.status === 'failed' && s.phase === 'failed' && s.phaseHistory);
      expect(failedUpdate).toBeDefined();
      const history = JSON.parse(failedUpdate!.phaseHistory as string) as Array<{ phase: string; startedAt: number; completedAt?: number }>;
      const lastEntry = history[history.length - 1];
      expect(lastEntry.phase).toBe('copying');
      expect(lastEntry.completedAt).toBeTypeOf('number');
    });
  });

  // ===========================================================================
  // #707 — Nullable book_id / download_id in SSE payloads
  // ===========================================================================

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
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
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

    it('boot recovery still uses null comparison (not sentinel) — orphan with null bookId skips books update', async () => {
      // Re-asserts AC #3: internal DB-facing guard at import-queue-worker.ts:103
      // continues to compare against null after the sentinel removal at the SSE boundary.
      const orphanRows = [{ id: 77, bookId: null }];

      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { from: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(orphanRows) };
        return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue([]) };
      });

      const txUpdate = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      }));
      mockDb.db.transaction = vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({ update: txUpdate }));

      await worker.start();
      await new Promise(r => setTimeout(r, 50));

      // tx.update was called exactly once (importJobs only) — no books update because bookId is null
      expect(txUpdate).toHaveBeenCalledTimes(1);
    });

    it('markJobFailed still uses null comparison (not sentinel) — failed job with null bookId skips books update', async () => {
      // Re-asserts AC #3: internal DB-facing guard at markJobFailed continues to
      // compare against null after the sentinel removal at the SSE boundary.
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
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // No books update should have happened — only job-status updates (claim + failed)
      const booksFailedUpdate = updateSets.find(s => s.status === 'failed' && !('phase' in s) && !('lastError' in s));
      expect(booksFailedUpdate).toBeUndefined();

      // Job failed update DID happen
      const jobFailedUpdate = updateSets.find(s => s.status === 'failed' && s.phase === 'failed');
      expect(jobFailedUpdate).toBeDefined();
    });
  });

  // ===========================================================================
  // #717 — Adapter contract regression: real adapters reject null bookId
  //
  // Companion to #707 (which tested the SSE-emission boundary with a no-op
  // adapter). These tests register the real ManualImportAdapter and
  // AutoImportAdapter and drive the worker end-to-end with a null-bookId job,
  // verifying the adapter's typed-error reject path AND the SSE payload shape.
  // The pair guards against:
  //   (a) a regression that re-introduces `?? 0` upstream of adapter dispatch
  //       — the adapter would no longer see null and would not throw the
  //       contract error, failing the error_message assertion.
  //   (b) a regression that re-introduces `?? 0` in the SSE payload —
  //       book_id would emit as 0 instead of null, failing that assertion.
  // ===========================================================================

  describe('#717 real adapters reject null bookId end-to-end', () => {
    /**
     * Wires the same selects as setupNullBookIdJob — boot recovery (empty),
     * candidate select (id 11), full row fetch (bookId:null) — but accepts a
     * caller-supplied job type and metadata so we can exercise either real
     * adapter through the same dispatch path used in production.
     */
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
        set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) }),
      }));
    }

    it('ManualImportAdapter throws "requires a bookId" and worker emits import_failed with book_id:null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      // Real ManualImportAdapter — null guard at manual.ts:34-36 throws before
      // any deps method is touched, so the deps stubs need only satisfy the
      // constructor type. We track each stub method to assert the throw
      // happened before reaching DB/service work.
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

      setupNullBookIdRealAdapter(realAdapter, 'manual', '{"title":"Orphan Manual"}');

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // AC #2 — adapter threw a typed error with the contract message.
      const failedCall = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failedCall).toBeDefined();
      const payload = failedCall![1];
      expect(payload.error_message).toContain('requires a bookId');

      // AC #3 — payload validates against the SSE schema; book_id is null,
      // every other contract field is populated (no unexpected nulls).
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

      // AC #4 — the throw fired before any FK lookup against books or any
      // service call. If `?? 0` were re-introduced upstream, bookId would be
      // 0 and the adapter would proceed to bookService/db.select(books).
      expect(bookServiceGetById).not.toHaveBeenCalled();
      expect(settingsServiceGet).not.toHaveBeenCalled();
      // Total selects: 1 boot recovery + 1 candidate + 1 row fetch + 1 next
      // drain iteration (empty). Any 5th select means the adapter reached
      // its own books query — the regression we're guarding against.
      expect(mockDb.db.select.mock.calls.length).toBeLessThanOrEqual(4);
    });

    it('AutoImportAdapter throws "requires a bookId" and worker emits import_failed with book_id:null', async () => {
      const emitSpy = vi.fn();
      const mockBroadcaster = { emit: emitSpy };
      const workerWithBroadcaster = new ImportQueueWorker(inject<Db>(mockDb.db), log, mockBroadcaster as never);

      // Real AutoImportAdapter — null guard at auto.ts:12-15 throws before
      // importDownload is invoked. The stub records calls so we can assert
      // the orchestrator was never reached.
      const orchestratorStub = inject<ImportOrchestrator>({
        importDownload: vi.fn(),
      });
      const realAdapter = new AutoImportAdapter(orchestratorStub);

      setupNullBookIdRealAdapter(realAdapter, 'auto', '{"title":"Orphan Auto","downloadId":42}');

      await workerWithBroadcaster.start();
      await new Promise(r => setTimeout(r, 100));
      await workerWithBroadcaster.stop();

      // AC #4 — the null guard fires before any orchestrator work; if `?? 0`
      // were re-introduced upstream, this stub would have been invoked.
      expect(orchestratorStub.importDownload).not.toHaveBeenCalled();

      // AC #2 — adapter threw the contract error; worker routed through
      // markJobFailed and emitted import_failed.
      const failedCall = emitSpy.mock.calls.find(c => c[0] === 'import_failed');
      expect(failedCall).toBeDefined();
      const payload = failedCall![1];
      expect(payload.error_message).toContain('requires a bookId');

      // AC #3 — schema-conformant payload with book_id:null and every other
      // field populated.
      const parsed = importFailedPayload.safeParse(payload);
      expect(parsed.success).toBe(true);
      expect(payload.book_id).toBeNull();
      expect(payload.book_id).not.toBe(0);
      expect(payload.job_id).toBe(11);
      expect(payload.book_title).toBe('Orphan Auto');
      expect(payload.phase).toBeTypeOf('string');
      expect(payload.phase.length).toBeGreaterThan(0);
      expect(payload.error_message).toBeTypeOf('string');
      expect(payload.error_message.length).toBeGreaterThan(0);
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
        // All selects: no pending
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

      // No additional selects after stop
      expect(selectCallCount).toBe(countAfterStop);
    });
  });
});
