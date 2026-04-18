import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { ImportQueueWorker } from './import-queue-worker.js';
import { registerImportAdapter, clearImportAdapters } from './import-adapters/registry.js';
import type { ImportAdapter, ImportJob } from './import-adapters/types.js';

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
    it('marks processing rows as failed with last_error JSON on startup', async () => {
      // Seed: first select returns orphan rows, second (drain) returns no pending
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };
      let selectCallCount = 0;
      mockDb.db.select = vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          // Boot recovery: return orphan
          return {
            from: vi.fn().mockReturnThis(),
            where: vi.fn().mockResolvedValue([{ id: 99, bookId: 42 }]),
          };
        }
        // Drain loop: no pending
        return selectChain;
      });

      const updateSets: Record<string, unknown>[] = [];
      mockDb.db.update = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          updateSets.push(payload);
          return { where: vi.fn().mockResolvedValue({ rowsAffected: 1 }) };
        }),
      }));

      await worker.start();
      // Give drain loop a tick to run
      await new Promise(r => setTimeout(r, 50));

      // First update is the import_jobs row
      expect(updateSets[0]).toMatchObject({
        status: 'failed',
        phase: 'failed',
      });
      const lastError = JSON.parse(updateSets[0].lastError as string);
      expect(lastError.message).toBe('Interrupted by server restart');
      expect(lastError.type).toBe('ProcessRestart');

      // Second update is the books row
      expect(updateSets[1]).toMatchObject({ status: 'failed' });
    });
  });

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
