import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';

/**
 * Graceful shutdown sequence. Ordering is load-bearing:
 *  1. Stop the import queue worker FIRST — it finishes any in-flight import,
 *     which may enqueue connector refreshes on the way out.
 *  2. Drain the best-effort connector refresh queue — clears pending debounce/
 *     deadline timers (warn-logging dropped batches) and awaits any in-flight
 *     flush. This MUST run before `app.close()` so a refresh that is mid-request
 *     or mid-retry isn't silently lost when the process tears down.
 *  3. Close the Fastify app LAST to release the port.
 *
 * Extracted from the `index.ts` signal handler so the ordering contract (AC2 of
 * #1498) is unit-testable without booting the full server.
 */
export async function gracefulShutdown(app: FastifyInstance, services: Services): Promise<void> {
  app.log.info('Shutting down server…');
  await services.importQueueWorker.stop();
  await services.connector.stop();
  await app.close();
}
