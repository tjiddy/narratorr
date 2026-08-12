import type { FastifyInstance } from 'fastify';
import type { Db } from '@db/index.js';
import type { Services } from './services/di.js';
import { startJobs, type JobScheduler } from './jobs/index.js';
import {
  settleInterruptedMerges,
  requeueRecoveredMerges,
  type MergeRecoveryPlan,
} from './services/merge-boot-recovery.js';
import { serializeError } from './utils/serialize-error.js';

/**
 * Load-bearing boot order: settle interrupted merges before producers start;
 * start the import worker so its marker sweep is the sole recovery actor; then
 * requeue the settled plan, start staged submissions, and start background jobs last.
 * Merge recovery is nonfatal; failed settlement leaves no plan to requeue.
 */
export async function startRuntime(app: FastifyInstance, services: Services, db: Db): Promise<JobScheduler> {
  let plan: MergeRecoveryPlan | null = null;
  try {
    plan = await settleInterruptedMerges({
      db,
      log: app.log,
      eventHistory: services.eventHistory,
      bookService: services.book,
      settingsService: services.settings,
    });
  } catch (error: unknown) {
    app.log.error({ error: serializeError(error) }, 'Merge boot recovery (settlement) failed — continuing startup');
  }

  await services.importQueueWorker.start();

  if (plan) {
    try {
      await requeueRecoveredMerges(services.merge, plan, app.log);
    } catch (error: unknown) {
      app.log.error({ error: serializeError(error) }, 'Merge boot recovery (re-queue) failed — continuing startup');
    }
  }

  services.importSubmissionRunner.start();
  return startJobs(db, services, app.log);
}
