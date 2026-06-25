import { Cron } from 'croner';
import { sql, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { downloads } from '../../db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../services/di.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { MONITOR_CRON_INTERVAL } from './constants.js';
import { monitorDownloads } from './monitor.js';
import { runEnrichment } from './enrichment.js';
import { runSearchJob } from './search.js';
import { runRssJob } from './rss.js';
import { runBackupJob } from './backup.js';
import { checkForUpdate } from './version-check.js';
import { runDiscoveryJob } from './discovery.js';
import { runCoverBackfill } from './cover-backfill.js';
import { runSeriesRefreshJob } from './series-refresh.js';
import { serializeError } from '../utils/serialize-error.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { LibraryPathError, ScanInProgressError } from '../services/library-scan.service.js';


interface CronJob {
  name: string;
  type: 'cron';
  schedule: string;
  callback: () => Promise<unknown> | unknown;
}

interface TimeoutJob {
  name: string;
  type: 'timeout';
  getIntervalMinutes: () => Promise<number>;
  callback: () => Promise<unknown> | unknown;
}

type JobEntry = CronJob | TimeoutJob;

/** Stoppable handle for a single timeout-loop job (see `scheduleTimeoutLoop`). */
interface TimeoutLoopHandle {
  stop(): void;
}

/**
 * Handle returned by `startJobs` so the graceful-shutdown path can halt the
 * scheduler. BEST-EFFORT / GRACEFUL-ONLY: `stopAll` stops clean firing during a
 * graceful shutdown — it has no durable backing and makes no guarantee against a
 * hard crash (SIGKILL/OOM), mirroring the connector refresh queue's contract
 * (see CLAUDE.md "Connector refresh queue is best-effort, in-memory", #769/#877/
 * #885). It does NOT drain in-flight work; it just guarantees no scheduled job
 * fires again once invoked.
 */
export interface JobScheduler {
  /** Stop every cron + timeout-loop job. Idempotent — a second call is a no-op. */
  stopAll(): void;
}

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger): JobScheduler {
  // RetrySearchDeps is constructed once in createServices() and exposed on the
  // Services bag so jobs and the composition root share the same instance.
  const retryDeps = {
    blacklistService: services.blacklist,
    retrySearchDeps: services.retrySearchDeps,
  };

  // When a version-check changes the cached update status, recompute health so
  // the health card + nav dot reflect it within one UI poll instead of lagging
  // until the next scheduled health-check tick. Must call the service directly
  // (not `executeTracked('health-check')`, which silently no-ops mid-pass) so
  // the coalesced trailing rerun in runAllChecks always consumes the new status.
  const onUpdateChanged = (): void => {
    fireAndForget(services.healthCheck.runAllChecks(), log, 'Version-check health nudge failed');
  };

  // Expose that same nudge to the manual "Run Now" health route so a manual run
  // can fire a live version check (`runManualChecks`) using the *identical*
  // callback the boot/2 AM invocations use — keeping the SSE/health-nudge
  // side-effects consistent across paths (#1411). The scheduled health-check cron
  // is untouched: it calls `runAllChecks()` directly and pays no fetch cost.
  services.healthCheck.setVersionUpdateCallback(onUpdateChanged);

  /** Job registry — adding a new job requires one entry here. */
  const jobRegistry: JobEntry[] = [
    { name: 'monitor', type: 'cron', schedule: MONITOR_CRON_INTERVAL, callback: () => monitorDownloads(db, services.downloadClient, services.notifier, log, retryDeps, services.eventBroadcaster, services.remotePathMapping, services.qualityGateOrchestrator, services.eventHistory) },
    { name: 'enrichment', type: 'cron', schedule: '*/5 * * * *', callback: () => runEnrichment(db, services.metadata, services.book, log) },
    { name: 'import-maintenance', type: 'cron', schedule: '*/5 * * * *', callback: async () => { await services.qualityGateOrchestrator.processCompletedDownloads(); await services.importOrchestrator.processCompletedDownloads(); await services.qualityGateOrchestrator.cleanupDeferredRejections(); await services.import.cleanupDeferredImports(); } },
    { name: 'search', type: 'timeout', getIntervalMinutes: () => services.settings.get('search').then((s) => s.intervalMinutes), callback: () => runSearchJob(services.settings, services.bookList, services.indexerSearch, services.downloadOrchestrator, log, services.blacklist, services.indexer, services.eventHistory, services.retryBudget, services.eventBroadcaster) },
    { name: 'rss', type: 'timeout', getIntervalMinutes: () => services.settings.get('rss').then((s) => s.intervalMinutes), callback: () => runRssJob(services.settings, services.bookList, services.indexerSearch, services.downloadOrchestrator, services.blacklist, services.indexer, log) },
    { name: 'backup', type: 'timeout', getIntervalMinutes: () => services.settings.get('system').then((s) => s.backupIntervalMinutes), callback: () => runBackupJob(services.backup, log) },
    { name: 'housekeeping', type: 'cron', schedule: '0 0 * * 0', callback: async () => {
      try { await db.run(sql`VACUUM`); } catch (error: unknown) { log.warn({ error: serializeError(error) }, 'Housekeeping: VACUUM failed'); }
      try {
        const generalSettings = await services.settings.get('general');
        const retentionDays = generalSettings.housekeepingRetentionDays ?? 90;
        await services.eventHistory.pruneOlderThan(retentionDays);
      } catch (error: unknown) { log.warn({ error: serializeError(error) }, 'Housekeeping: retention prune failed'); }
      try { await services.blacklist.deleteExpired(); } catch (error: unknown) { log.warn({ error: serializeError(error) }, 'Housekeeping: blacklist cleanup failed'); }
    } },
    { name: 'health-check', type: 'cron', schedule: '*/5 * * * *', callback: () => services.healthCheck.runAllChecks() },
    { name: 'version-check', type: 'cron', schedule: '0 2 * * *', callback: () => checkForUpdate(log, onUpdateChanged) },
    { name: 'import-list-sync', type: 'cron', schedule: '* * * * *', callback: () => services.importList.syncDueLists() },
    { name: 'discovery', type: 'timeout', getIntervalMinutes: () => services.settings.get('discovery').then((s) => s.intervalHours * 60), callback: () => runDiscoveryJob(services.discovery, services.settings, log) },
    { name: 'series-refresh', type: 'cron', schedule: '0 3 * * 0', callback: () => runSeriesRefreshJob(services.seriesCard, log) },
    { name: 'library-rescan', type: 'cron', schedule: '0 */6 * * *', callback: async () => {
      try {
        await services.libraryScan.rescanLibrary();
      } catch (error: unknown) {
        if (error instanceof LibraryPathError || error instanceof ScanInProgressError) {
          log.warn({ error: serializeError(error) }, 'Scheduled library rescan skipped');
          return;
        }
        throw error;
      }
    } },
  ];

  const reg = services.taskRegistry;

  // Capture every scheduler handle so `stopAll` can halt them on shutdown. Both
  // collections are append-only here and only read by `stopAll`.
  const cronHandles: Cron[] = [];
  const timeoutHandles: TimeoutLoopHandle[] = [];

  for (const job of jobRegistry) {
    const fn = job.callback as () => Promise<unknown>;
    if (job.type === 'cron') {
      reg.register(job.name, 'cron', fn, job.schedule);
      cronHandles.push(scheduleCron(reg, job.name, job.schedule, log));
    } else {
      reg.register(job.name, 'timeout', fn);
      timeoutHandles.push(scheduleTimeoutLoop(reg, job.name, job.getIntervalMinutes, log));
    }
  }

  log.info('Background jobs started');

  // Startup recovery: reset stuck downloads and reprocess (#358)
  runStartupRecovery(db, services, log).catch((error: unknown) => {
    log.error({ error: serializeError(error) }, 'Startup recovery failed — jobs continue normally');
  });

  // Run the version check once on boot so the update banner reflects reality
  // before the 2 AM cron fires (#1225). Route through the registry (rather than
  // calling checkForUpdate directly) so the boot run stamps `lastRun` — otherwise
  // the Jobs page shows `Last Run: —` until the 2 AM cron, even though a check
  // just ran (#1317). runTask invokes the registered `version-check` callback,
  // which closes over the same `onUpdateChanged` health nudge (#1262). Fire-and-
  // forget: the trailing .catch guards against any rejection (including a
  // NOT_FOUND/ALREADY_RUNNING TaskRegistryError) so a failed check never blocks
  // or crashes startup.
  reg.runTask('version-check').catch((error: unknown) => {
    log.error({ error: serializeError(error) }, 'Startup version check failed — jobs continue normally');
  });

  // Best-effort, graceful-only scheduler stop (see JobScheduler doc). Memoized via
  // `stopped` so a second call is a true no-op: it never re-invokes `Cron.stop()`
  // or a timeout handle's stop. `gracefulShutdown` calls this FIRST — before the
  // import-worker / connector drains — so no cron or timeout callback can enqueue
  // new import jobs or connector refreshes while those drains are awaiting.
  let stopped = false;
  const stopAll = (): void => {
    if (stopped) return;
    stopped = true;
    for (const cron of cronHandles) cron.stop();
    for (const handle of timeoutHandles) handle.stop();
  };

  return { stopAll };
}

async function runStartupRecovery(db: Db, services: Services, log: FastifyBaseLogger): Promise<void> {
  // Reset downloads stuck mid-pipeline back to the `(completed, idle)` entry point
  // so the orchestrators re-claim them. This resets ONLY the `pipelineStage` axis —
  // `clientStatus` (still 'completed', the client download had finished) is
  // preserved. Bulk recovery write; the per-row transition helper does not apply.
  const resetResult = await db
    .update(downloads)
    .set({ pipelineStage: 'idle' })
    .where(inArray(downloads.pipelineStage, ['checking', 'importing']))
    .returning({ id: downloads.id });

  if (resetResult.length > 0) {
    log.info({ count: resetResult.length }, 'Startup recovery: reset stuck downloads to completed');
  }

  // Reprocess via existing batch methods
  await services.qualityGateOrchestrator.processCompletedDownloads();
  await services.importOrchestrator.processCompletedDownloads();

  // Backfill: download remote covers for imported books (#369)
  await runCoverBackfill(db, log);
}

/**
 * Schedule a cron job via croner. croner is the single source of truth for both
 * firing and the displayed next-run: `job.nextRun()` is the real next fire time,
 * stored on the registry at registration and refreshed after each run (mirroring
 * how timeout-loop jobs use `setNextRun`). The constructed `Cron` is returned so
 * tests can `.stop()` it for deterministic cleanup; production ignores the handle.
 */
export function scheduleCron(reg: TaskRegistry, name: string, expression: string, log: FastifyBaseLogger): Cron {
  const job = new Cron(expression, async () => {
    try {
      await reg.executeTracked(name);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `${name} job error`);
    } finally {
      // Refresh the displayed next-run after each fire. Skip on null (no future
      // occurrence) so a stale value is left untouched rather than crashing
      // setNextRun, which expects a Date. Never exercised by the recurring
      // production jobs — defensive only.
      const next = job.nextRun();
      if (next) reg.setNextRun(name, next);
    }
  });
  const next = job.nextRun();
  if (next) reg.setNextRun(name, next);
  return job;
}

/**
 * Schedule a self-re-arming `setTimeout` loop and return a stoppable handle.
 *
 * `stop()` clears the pending timer AND sets a `stopped` flag closed over by
 * `scheduleNext`, so once stopped the loop never schedules another tick or fires
 * its callback again — even if a timer was already pending or a tick's macrotask
 * was already queued at the moment of stop (the callback short-circuits on the
 * flag). Both `setTimeout` sites (the main interval and the retry-on-error timer)
 * are captured and `unref()`'d so a pending tick can't pin the event loop past
 * SIGTERM, mirroring the connector refresh queue's timers (#1498/#1512).
 */
function scheduleTimeoutLoop(
  reg: TaskRegistry,
  name: string,
  getIntervalMinutes: () => Promise<number>,
  log: FastifyBaseLogger,
): TimeoutLoopHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  // Arm a timer that does not keep the event loop alive (see doc above).
  const arm = (fn: () => void, ms: number): void => {
    timer = setTimeout(fn, ms);
    timer.unref();
  };

  async function scheduleNext() {
    if (stopped) return;
    try {
      const intervalMinutes = await getIntervalMinutes();
      const intervalMs = intervalMinutes * 60 * 1000;
      if (stopped) return; // could have stopped while awaiting the interval read
      reg.setNextRun(name, new Date(Date.now() + intervalMs));

      arm(async () => {
        if (stopped) return; // a queued tick must not fire after stop
        try {
          await reg.executeTracked(name);
        } catch (error: unknown) {
          log.error({ error: serializeError(error) }, `${name} job error`);
        }
        scheduleNext();
      }, intervalMs);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `Failed to read ${name} interval, retrying in 5 minutes`);
      if (stopped) return;
      arm(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
