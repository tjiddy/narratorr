import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { Services } from './services/di.js';

// startJobs starts real croner/timeout schedulers — mock it so startRuntime's
// ordering contract can be asserted without arming any timers.
vi.mock('./jobs/index.js', () => ({ startJobs: vi.fn() }));

import { startJobs } from './jobs/index.js';
import { startRuntime } from './startup.js';

/**
 * Regression guard for the boot ordering contract (#1893): startRuntime must start
 * the import queue worker FIRST (its boot recovery precedes download recovery), then
 * start the staged-submission runner EXACTLY once (so it installs its nudge listener +
 * safety poll), then start background jobs — and return the scheduler handle. Deleting
 * the runner start or reordering the calls fails these assertions.
 */
describe('startRuntime', () => {
  function makeApp(): FastifyInstance {
    return { log: { info: vi.fn() } } as unknown as FastifyInstance;
  }

  function makeServices(order: string[]): Services {
    return {
      importQueueWorker: { start: vi.fn(async () => { order.push('importQueueWorker.start'); }) },
      importSubmissionRunner: { start: vi.fn(() => { order.push('importSubmissionRunner.start'); }) },
    } as unknown as Services;
  }

  it('starts the import worker, then the submission runner once, then background jobs — in that order', async () => {
    const order: string[] = [];
    const services = makeServices(order);
    const scheduler = { stopAll: vi.fn() };
    vi.mocked(startJobs).mockImplementation(() => { order.push('startJobs'); return scheduler; });

    const result = await startRuntime(makeApp(), services, {} as unknown as Db);

    expect(order).toEqual(['importQueueWorker.start', 'importSubmissionRunner.start', 'startJobs']);
    expect(services.importSubmissionRunner.start).toHaveBeenCalledTimes(1);
    expect(result).toBe(scheduler); // returns the scheduler handle for the caller to tear down
  });

  it('awaits the import queue worker start before starting the runner', async () => {
    const order: string[] = [];
    let workerResolved = false;
    const services = {
      importQueueWorker: { start: vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); workerResolved = true; order.push('importQueueWorker.start'); }) },
      importSubmissionRunner: { start: vi.fn(() => { expect(workerResolved).toBe(true); order.push('importSubmissionRunner.start'); }) },
    } as unknown as Services;
    vi.mocked(startJobs).mockReturnValue({ stopAll: vi.fn() });

    await startRuntime(makeApp(), services, {} as unknown as Db);

    expect(order).toEqual(['importQueueWorker.start', 'importSubmissionRunner.start']);
  });
});
