import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '@db/index.js';
import type { Services } from './services/di.js';

// startJobs starts real croner/timeout schedulers — mock it so startRuntime's
// ordering contract can be asserted without arming any timers.
vi.mock('./jobs/index.js', () => ({ startJobs: vi.fn() }));

// The merge-recovery phases do real DB + filesystem work; here only their POSITION in the
// boot sequence and their nonfatal posture are under test (their behavior lives in
// merge-boot-recovery.test.ts / .integration.test.ts).
vi.mock('./services/merge-boot-recovery.js', () => ({
  settleInterruptedMerges: vi.fn(),
  requeueRecoveredMerges: vi.fn(),
}));

import { startJobs } from './jobs/index.js';
import { settleInterruptedMerges, requeueRecoveredMerges } from './services/merge-boot-recovery.js';
import { startRuntime } from './startup.js';

const PLAN = { requeue: [7], counters: { candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 } };

/**
 * Regression guard for the boot ordering contract (#1893, #2099): startRuntime must settle
 * interrupted merges FIRST (before any merge producer exists), then start the import queue
 * worker, then issue the recovered re-queues (after the worker's marker sweep, the single
 * recovery actor per marker), then start the staged-submission runner EXACTLY once, then
 * background jobs — and return the scheduler handle. Deleting a call or reordering fails these.
 */
describe('startRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(settleInterruptedMerges).mockResolvedValue(PLAN);
    vi.mocked(requeueRecoveredMerges).mockResolvedValue(undefined);
  });

  function makeApp(): FastifyInstance {
    return { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as unknown as FastifyInstance;
  }

  function makeServices(order: string[]): Services {
    return {
      importQueueWorker: { start: vi.fn(async () => { order.push('importQueueWorker.start'); }) },
      importSubmissionRunner: { start: vi.fn(() => { order.push('importSubmissionRunner.start'); }) },
      eventHistory: {}, book: {}, settings: {}, merge: {},
    } as unknown as Services;
  }

  it('settles merges, then starts the worker, then re-queues, then the runner once, then jobs — in that order', async () => {
    const order: string[] = [];
    const services = makeServices(order);
    const scheduler = { stopAll: vi.fn() };
    vi.mocked(settleInterruptedMerges).mockImplementation(async () => { order.push('settleInterruptedMerges'); return PLAN; });
    vi.mocked(requeueRecoveredMerges).mockImplementation(async () => { order.push('requeueRecoveredMerges'); });
    vi.mocked(startJobs).mockImplementation(() => { order.push('startJobs'); return scheduler; });

    const result = await startRuntime(makeApp(), services, {} as unknown as Db);

    expect(order).toEqual([
      'settleInterruptedMerges',
      'importQueueWorker.start',
      'requeueRecoveredMerges',
      'importSubmissionRunner.start',
      'startJobs',
    ]);
    expect(services.importSubmissionRunner.start).toHaveBeenCalledTimes(1);
    // The plan crosses the worker barrier intact — phase 2 receives phase 1's own object.
    expect(requeueRecoveredMerges).toHaveBeenCalledWith(services.merge, PLAN, expect.anything());
    expect(result).toBe(scheduler); // returns the scheduler handle for the caller to tear down
  });

  it('awaits the settlement before the worker starts, and the worker before the re-queue', async () => {
    const order: string[] = [];
    let settlementResolved = false;
    let workerResolved = false;
    vi.mocked(settleInterruptedMerges).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      settlementResolved = true;
      order.push('settleInterruptedMerges');
      return PLAN;
    });
    vi.mocked(requeueRecoveredMerges).mockImplementation(async () => {
      expect(workerResolved).toBe(true);
      order.push('requeueRecoveredMerges');
    });
    const services = {
      importQueueWorker: { start: vi.fn(async () => {
        expect(settlementResolved).toBe(true);
        await new Promise((r) => setTimeout(r, 5));
        workerResolved = true;
        order.push('importQueueWorker.start');
      }) },
      importSubmissionRunner: { start: vi.fn(() => { order.push('importSubmissionRunner.start'); }) },
      eventHistory: {}, book: {}, settings: {}, merge: {},
    } as unknown as Services;
    vi.mocked(startJobs).mockReturnValue({ stopAll: vi.fn() });

    await startRuntime(makeApp(), services, {} as unknown as Db);

    expect(order).toEqual([
      'settleInterruptedMerges',
      'importQueueWorker.start',
      'requeueRecoveredMerges',
      'importSubmissionRunner.start',
    ]);
  });

  it('a throwing settlement phase is nonfatal and skips the re-queue phase entirely', async () => {
    const order: string[] = [];
    const services = makeServices(order);
    const app = makeApp();
    const scheduler = { stopAll: vi.fn() };
    vi.mocked(settleInterruptedMerges).mockRejectedValue(new Error('detection query failed'));
    vi.mocked(startJobs).mockImplementation(() => { order.push('startJobs'); return scheduler; });

    const result = await startRuntime(app, services, {} as unknown as Db);

    // Never invoked at all — not with an empty plan, not with a partial one (AC9).
    expect(requeueRecoveredMerges).not.toHaveBeenCalled();
    expect(order).toEqual(['importQueueWorker.start', 'importSubmissionRunner.start', 'startJobs']);
    expect(result).toBe(scheduler);
    expect(app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'detection query failed' }) }),
      expect.stringContaining('Merge boot recovery'),
    );
  });

  it('a throwing re-queue phase is nonfatal — the runner and jobs still start', async () => {
    const order: string[] = [];
    const services = makeServices(order);
    const app = makeApp();
    const scheduler = { stopAll: vi.fn() };
    vi.mocked(requeueRecoveredMerges).mockRejectedValue(new Error('enqueue exploded'));
    vi.mocked(startJobs).mockImplementation(() => { order.push('startJobs'); return scheduler; });

    const result = await startRuntime(app, services, {} as unknown as Db);

    expect(order).toEqual(['importQueueWorker.start', 'importSubmissionRunner.start', 'startJobs']);
    expect(result).toBe(scheduler);
    expect(app.log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Merge boot recovery'));
  });
});
