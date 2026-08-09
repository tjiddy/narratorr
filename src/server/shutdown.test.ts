import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';
import type { JobScheduler } from './jobs/index.js';
import { gracefulShutdown } from './shutdown.js';

/** Guard the producer-to-consumer shutdown order. */
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
      eventBroadcaster: { stop: vi.fn(() => { order.push('eventBroadcaster.stop'); }) },
      importSubmissionRunner: { stop: vi.fn(async () => { order.push('importSubmissionRunner.stop'); }) },
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      companionEbook: { stop: vi.fn(async () => { order.push('companionEbook.stop'); }) },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;
  }

  it('stops the scheduler and heartbeat, then the import worker, drains the connector queue, then closes the app — in that order', async () => {
    const order: string[] = [];
    const app = makeApp(order);
    const services = makeServices(order);
    const jobScheduler = makeScheduler(order);

    await gracefulShutdown(app, services, jobScheduler);

    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop', 'companionEbook.stop', 'connector.stop', 'app.close']);
    expect(jobScheduler.stopAll).toHaveBeenCalledTimes(1);
    expect(services.eventBroadcaster.stop).toHaveBeenCalledTimes(1);
    expect(services.connector.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the SSE heartbeat before the awaited drains so no frame is written mid-teardown (#1776)', async () => {
    const order: string[] = [];
    let releaseImportStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      eventBroadcaster: { stop: vi.fn(() => { order.push('eventBroadcaster.stop'); }) },
      importSubmissionRunner: { stop: vi.fn(async () => { order.push('importSubmissionRunner.stop'); }) },
      importQueueWorker: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseImportStop = () => { order.push('importQueueWorker.stop'); resolve(); };
        })),
      },
      companionEbook: { stop: vi.fn(async () => { order.push('companionEbook.stop'); }) },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Let shutdown reach the deferred import-worker drain.
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(services.eventBroadcaster.stop).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop']);

    releaseImportStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop', 'companionEbook.stop', 'connector.stop', 'app.close']);
  });

  it('awaits connector.stop() before invoking app.close() (drain is not fire-and-forget)', async () => {
    const order: string[] = [];
    let releaseConnectorStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      eventBroadcaster: { stop: vi.fn(() => { order.push('eventBroadcaster.stop'); }) },
      importSubmissionRunner: { stop: vi.fn(async () => { order.push('importSubmissionRunner.stop'); }) },
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      companionEbook: { stop: vi.fn(async () => { order.push('companionEbook.stop'); }) },
      connector: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseConnectorStop = () => { order.push('connector.stop'); resolve(); };
        })),
      },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Flush pending microtasks until execution parks on the deferred connector drain.
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(services.connector.stop).toHaveBeenCalledTimes(1);
    expect(app.close).not.toHaveBeenCalled();

    releaseConnectorStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop', 'companionEbook.stop', 'connector.stop', 'app.close']);
  });

  it('stops the scheduler BEFORE the awaited import-worker / connector drains begin', async () => {
    const order: string[] = [];
    let releaseImportStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      eventBroadcaster: { stop: vi.fn(() => { order.push('eventBroadcaster.stop'); }) },
      importSubmissionRunner: { stop: vi.fn(async () => { order.push('importSubmissionRunner.stop'); }) },
      importQueueWorker: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseImportStop = () => { order.push('importQueueWorker.stop'); resolve(); };
        })),
      },
      companionEbook: { stop: vi.fn(async () => { order.push('companionEbook.stop'); }) },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Let shutdown reach the deferred import-worker drain.
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(jobScheduler.stopAll).toHaveBeenCalledTimes(1);
    expect(services.importQueueWorker.stop).toHaveBeenCalledTimes(1);
    expect(services.connector.stop).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop']);

    releaseImportStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop', 'companionEbook.stop', 'connector.stop', 'app.close']);
  });

  // An immediately resolved companion stop cannot distinguish await from fire-and-forget.
  it('awaits companionEbook.stop() before the connector drain and app.close (drain is not fire-and-forget)', async () => {
    const order: string[] = [];
    let releaseCompanionStop!: () => void;
    const app = makeApp(order);
    const jobScheduler = makeScheduler(order);
    const services = {
      eventBroadcaster: { stop: vi.fn(() => { order.push('eventBroadcaster.stop'); }) },
      importSubmissionRunner: { stop: vi.fn(async () => { order.push('importSubmissionRunner.stop'); }) },
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      companionEbook: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseCompanionStop = () => { order.push('companionEbook.stop'); resolve(); };
        })),
      },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;

    const done = gracefulShutdown(app, services, jobScheduler);
    // Let shutdown reach the deferred companion drain.
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(services.companionEbook.stop).toHaveBeenCalledTimes(1);
    expect(services.connector.stop).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop']);

    releaseCompanionStop();
    await done;

    expect(order).toEqual(['jobScheduler.stopAll', 'eventBroadcaster.stop', 'importSubmissionRunner.stop', 'importQueueWorker.stop', 'companionEbook.stop', 'connector.stop', 'app.close']);
  });
});
