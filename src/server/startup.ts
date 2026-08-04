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
 * Runtime start sequence. Ordering is load-bearing and mirrors the shutdown
 * contract in reverse:
 *  1. Settle interrupted merges FIRST (#2099) — classify, clean and record a terminal
 *     `merge_failed` for every merge the last process death left dangling. This step is a
 *     true barrier: `startRuntime` runs before `listenWithRetry`, so the HTTP merge route is
 *     unreachable, and the import worker (the only other merge producer) has not started —
 *     the process has no merge in flight and none can begin. Returns the plan step 3 completes.
 *  2. Start the import queue worker — its boot recovery marks orphaned `processing` jobs
 *     before download recovery re-enqueues anything, and its marker sweep converges stranded
 *     `.import-commit-pending` markers.
 *  3. Re-queue the recovered merges (#2099), then log the single recovery summary. Deferred
 *     past step 2 rather than folded into step 1: `enqueueMerge` starts `executeMerge` on the
 *     event loop and that calls `recoverInterruptedCommit` — the same marker recovery step 2's
 *     sweep performs, which documents itself as the single recovery actor per marker. Issuing
 *     re-queues earlier would put two actors on one marker.
 *  4. Start the staged-submission runner (#1893) — installs its nudge listener +
 *     safety poll and boot-auto-resumes any 'processing' submission. Without this
 *     call a finalized submission never processes, so it MUST run on boot.
 *  5. Start background jobs LAST (download startup recovery may re-enqueue
 *     downloads), returning the scheduler handle the caller tears down.
 *
 * Both merge-recovery phases are NONFATAL, matching `runStartupRecovery`'s posture: a throw is
 * caught, logged at `error`, and boot continues. A settlement phase that throws skips the
 * re-queue phase entirely — there is no plan to consume and no summary to complete, so the
 * `error` log is the record — while steps 2, 4 and 5 still run.
 *
 * Extracted from the `index.ts` boot path so the ordering contract is unit-testable
 * without booting the server (mirrors `gracefulShutdown`).
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
