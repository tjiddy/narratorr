import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';
import { gracefulShutdown } from './shutdown.js';

/**
 * Regression guard for AC2 of #1498: the production shutdown handler must drain
 * the connector refresh queue BEFORE closing the app. These tests fail if
 * `services.connector.stop()` is removed from the sequence OR moved after
 * `app.close()`.
 */
describe('gracefulShutdown', () => {
  function makeApp(order: string[]): FastifyInstance {
    return {
      log: { info: vi.fn() },
      close: vi.fn(async () => { order.push('app.close'); }),
    } as unknown as FastifyInstance;
  }

  function makeServices(order: string[]): Services {
    return {
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      connector: { stop: vi.fn(async () => { order.push('connector.stop'); }) },
    } as unknown as Services;
  }

  it('stops the import worker, drains the connector queue, then closes the app — in that order', async () => {
    const order: string[] = [];
    const app = makeApp(order);
    const services = makeServices(order);

    await gracefulShutdown(app, services);

    // Connector drain is both PRESENT and ordered before app.close — catches a
    // deleted stop() call and a stop() moved after close().
    expect(order).toEqual(['importQueueWorker.stop', 'connector.stop', 'app.close']);
    expect(services.connector.stop).toHaveBeenCalledTimes(1);
  });

  it('awaits connector.stop() before invoking app.close() (drain is not fire-and-forget)', async () => {
    const order: string[] = [];
    let releaseConnectorStop!: () => void;
    const app = makeApp(order);
    const services = {
      importQueueWorker: { stop: vi.fn(async () => { order.push('importQueueWorker.stop'); }) },
      connector: {
        stop: vi.fn(() => new Promise<void>((resolve) => {
          releaseConnectorStop = () => { order.push('connector.stop'); resolve(); };
        })),
      },
    } as unknown as Services;

    const done = gracefulShutdown(app, services);
    // Flush all pending microtasks so execution parks on the awaited connector.stop().
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(services.connector.stop).toHaveBeenCalledTimes(1);
    expect(app.close).not.toHaveBeenCalled(); // blocked on the still-pending connector drain

    releaseConnectorStop();
    await done;

    expect(order).toEqual(['importQueueWorker.stop', 'connector.stop', 'app.close']);
  });
});
