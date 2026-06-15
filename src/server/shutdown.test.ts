import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';
import type { JobScheduler } from './jobs/index.js';
import { gracefulShutdown } from './shutdown.js';

/**
 * Regression guard for AC2 of #1498 and the scheduler-first ordering of #1515:
 * the production shutdown handler must stop the job scheduler FIRST, then stop
 * the import worker, drain the connector refresh queue, and close the app LAST.
 * These tests fail if the scheduler stop is removed/moved, or if `connector.stop`
 * is deleted or moved after `app.close()`.
 */
describe('gracefulShutdown', () => {
  function makeApp(order: string[]): FastifyInstance {
    return {
      log: { info: vi.fn() },
      close: vi.fn(async () => { order.push('app.close'); }),
    } as unknown as FastifyInstance;
  }

  function makeScheduler(order: string[]): JobScheduler {
    return { stopAll: vi.fn(() => { order.push('jobScheduler.stopAll'); }) };
  }

  function makeServices(order: string[]): Services {
    return {
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;
  }

  it('stops the scheduler, then the import worker, drains the connector queue, then closes the app — in that order', async () => {
    const order: string[] = [];
    const app = makeApp(order);
    const services = makeServices(order);
    const jobScheduler = makeScheduler(order);

    await gracefulShutdown(app, services, jobScheduler);

    // Scheduler stop is FIRST; connector drain is both PRESENT and ordered before
    // app.close — catches a missing scheduler stop, a deleted connector stop(),
    // and a stop() moved after close().
    expect(order).toEqual(['jobScheduler.stopAll', 'importQueueWorker.stop', 'connector.stop', 'app.close']);
    expect(jobScheduler.stopAll).toHaveBeenCalledTimes(1);
    expect(services.connector.stop).toHaveBeenCalledTimes(1);
  });

  it('awaits connector.stop() before invoking app.close() (drain is not fire-and-forget)', async () => {
    const order: string[] = [];
    let releaseConnectorStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      connector: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseConnectorStop = () => { order.push('connector.stop'); resolve(); };
        })),
      },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Flush all pending microtasks so execution parks on the awaited connector.stop().
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(services.connector.stop).toHaveBeenCalledTimes(1);
    expect(app.close).not.toHaveBeenCalled(); // blocked on the still-pending connector drain

    releaseConnectorStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'importQueueWorker.stop', 'connector.stop', 'app.close']);
  });

  // #1515 — the scheduler must be quiesced BEFORE the awaited drains run, not just
  // before app.close(). Park importQueueWorker.stop() on a deferred promise and
  // assert the scheduler stopAll has ALREADY fired while that drain is pending —
  // proving no cron/timeout callback can enqueue work into the queues being drained.
  it('stops the scheduler BEFORE the awaited import-worker / connector drains begin', async () => {
    const order: string[] = [];
    let releaseImportStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      importQueueWorker: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseImportStop = () => { order.push('importQueueWorker.stop'); resolve(); };
        })),
      },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Park on the still-pending import-worker drain.
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    // The scheduler is already stopped while the import-worker drain is mid-flight,
    // and the connector drain + close have not started yet.
    expect(jobScheduler.stopAll).toHaveBeenCalledTimes(1);
    expect(services.importQueueWorker.stop).toHaveBeenCalledTimes(1);
    expect(services.connector.stop).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    expect(order).toEqual(['jobScheduler.stopAll']);

    releaseImportStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'importQueueWorker.stop', 'connector.stop', 'app.close']);
  });
});
