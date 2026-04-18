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
    it.todo('setPhase appends new phaseHistory entry with startedAt');
    it.todo('setPhase closes previous phaseHistory entry with completedAt');
    it.todo('job completion closes the current phaseHistory entry');
    it.todo('job failure closes the current phaseHistory entry');
    it.todo('skipped phase has no phaseHistory entry');
  });

  describe('#637 event wiring', () => {
    it.todo('setPhase emits import_phase_change SSE with from and to fields');
    it.todo('emitProgress throttles at 250ms — two calls <250ms apart produce one SSE event');
    it.todo('worker emits import_complete on job success with job_id and elapsed_ms');
    it.todo('worker emits import_failed on job failure with phase and error_message');
    it.todo('worker emits import_failed with book_title from job metadata');
    it.todo('EventBroadcasterService is injected via constructor');
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
