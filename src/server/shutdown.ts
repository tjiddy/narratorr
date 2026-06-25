import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';
import type { JobScheduler } from './jobs/index.js';

/**
 * Graceful shutdown sequence. Ordering is load-bearing:
 *  1. Stop the background job scheduler FIRST — halt every cron + timeout-loop so
 *     no scheduled callback can enqueue new import jobs or connector refreshes
 *     while the drains below are awaiting. `stopAll` has no drain to await (it
 *     just stops firing), so it must run before the awaited drains rather than
 *     alongside them — otherwise the import-maintenance cron / library-rescan can
 *     keep feeding the very queues being drained and they never reach quiescence
 *     (#1515).
 *  2. Stop the import queue worker — it finishes any in-flight import, which may
 *     enqueue connector refreshes on the way out.
 *  3. Drain the best-effort connector refresh queue — clears pending debounce/
 *     deadline timers (warn-logging dropped batches) and awaits any in-flight
 *     flush. This MUST run before `app.close()` so a refresh that is mid-request
 *     or mid-retry isn't silently lost when the process tears down.
 *  4. Close the Fastify app LAST to release the port.
 *
 * Extracted from the `index.ts` signal handler so the ordering contract (AC2 of
 * #1498, scheduler-first of #1515) is unit-testable without booting the server.
 */
export async function gracefulShutdown(
  app: FastifyInstance,
  services: Services,
  jobScheduler: JobScheduler,
): Promise<void> {
  app.log.info('Shutting down server…');
  jobScheduler.stopAll();
  await services.importQueueWorker.stop();
  await services.connector.stop();
  await app.close();
}
