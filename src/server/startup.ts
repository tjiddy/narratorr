import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import type { Services } from './services/di.js';
import { startJobs, type JobScheduler } from './jobs/index.js';

/**
 * Runtime start sequence. Ordering is load-bearing and mirrors the shutdown
 * contract in reverse:
 *  1. Start the import queue worker FIRST — its boot recovery marks orphaned
 *     `processing` jobs before download recovery re-enqueues anything.
 *  2. Start the staged-submission runner (#1893) — installs its nudge listener +
 *     safety poll and boot-auto-resumes any 'processing' submission. Without this
 *     call a finalized submission never processes, so it MUST run on boot.
 *  3. Start background jobs LAST (download startup recovery may re-enqueue
 *     downloads), returning the scheduler handle the caller tears down.
 *
 * Extracted from the `index.ts` boot path so the ordering contract is unit-testable
 * without booting the server (mirrors `gracefulShutdown`).
 */
export async function startRuntime(app: FastifyInstance, services: Services, db: Db): Promise<JobScheduler> {
  await services.importQueueWorker.start();
  services.importSubmissionRunner.start();
  return startJobs(db, services, app.log);
}
