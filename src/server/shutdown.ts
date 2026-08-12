import type { FastifyInstance } from 'fastify';
import type { Services } from './services/di.js';
import type { JobScheduler } from './jobs/index.js';

/**
 * Load-bearing shutdown order: stop schedulers, close hijacked SSE replies, then
 * drain staged submissions → import worker → companion reconciler → connector queue.
 * Each stage can feed the next; Fastify closes last after work and replies are gone.
 */
export async function gracefulShutdown(
  app: FastifyInstance,
  services: Services,
  jobScheduler: JobScheduler,
): Promise<void> {
  app.log.info('Shutting down server…');
  jobScheduler.stopAll();
  services.eventBroadcaster.stop();
  await services.importSubmissionRunner.stop();
  await services.importQueueWorker.stop();
  await services.companionEbook.stop();
  await services.connector.stop();
  await app.close();
}
