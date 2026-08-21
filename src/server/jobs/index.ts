import { Cron } from 'croner';
import { sql, inArray } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import { downloads } from '@db/schema.js';
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
import { runGenreMarkerSweep } from './genre-marker-sweep.js';
import { runSeriesRefreshJob } from './series-refresh.js';
import { serializeError } from '../utils/serialize-error.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { LibraryPathError, ScanInProgressError } from '../services/library-scan.service.js';
import { rescanLibraryWithCompanionSweep } from '../services/library-rescan-sweep.js';


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

// Isolate maintenance failures so later subtasks still run.
async function runGuarded(log: FastifyBaseLogger, label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (error: unknown) {
    log.warn({ error: serializeError(error) }, label);
  }
}

interface TimeoutLoopHandle {
  stop(): void;
}

/** In-memory graceful stop: prevents future fires without draining in-flight work. */
export interface JobScheduler {
  /** Idempotent. */
  stopAll(): void;
}

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger): JobScheduler {
  const retryDeps = {
    blacklistService: services.blacklist,
    retrySearchDeps: services.retrySearchDeps,
  };

  // Bypass TaskRegistry: a health pass already in flight must coalesce a trailing rerun.
  const onUpdateChanged = (): void => {
    fireAndForget(services.healthCheck.runAllChecks(), log, 'Version-check health nudge failed');
  };

  // Manual checks reuse the same health nudge as boot and cron.
  services.healthCheck.setVersionUpdateCallback(onUpdateChanged);

  const jobRegistry: JobEntry[] = [
    { name: 'monitor', type: 'cron', schedule: MONITOR_CRON_INTERVAL, callback: () => monitorDownloads(db, services.downloadClient, services.notifier, log, retryDeps, services.eventBroadcaster, services.remotePathMapping, services.qualityGateOrchestrator, services.eventHistory) },
    { name: 'enrichment', type: 'cron', schedule: '*/5 * * * *', callback: () => runEnrichment(db, services.metadata, services.book, log) },
    { name: 'import-maintenance', type: 'cron', schedule: '*/5 * * * *', callback: async () => {
      await runGuarded(log, 'Import-maintenance: completed-download processing failed', async () => {
        await services.qualityGateOrchestrator.processCompletedDownloads();
        await services.importOrchestrator.processCompletedDownloads();
        await services.qualityGateOrchestrator.cleanupDeferredRejections();
        await services.import.cleanupDeferredImports();
      });
      await runGuarded(log, 'Import-maintenance: stale-receiving sweep failed', () => services.importStaging.sweepStaleReceiving());
    } },
    { name: 'search', type: 'timeout', getIntervalMinutes: () => services.settings.get('search').then((s) => s.intervalMinutes), callback: () => runSearchJob(services.settings, services.bookList, services.indexerSearch, services.downloadOrchestrator, log, services.blacklist, services.indexer, services.eventHistory, services.retryBudget, services.eventBroadcaster, services.searchLadderCooldown) },
    { name: 'rss', type: 'timeout', getIntervalMinutes: () => services.settings.get('rss').then((s) => s.intervalMinutes), callback: () => runRssJob(services.settings, services.bookList, services.indexerSearch, services.downloadOrchestrator, services.blacklist, services.indexer, log) },
    { name: 'backup', type: 'timeout', getIntervalMinutes: () => services.settings.get('system').then((s) => s.backupIntervalMinutes), callback: () => runBackupJob(services.backup, log) },
    { name: 'housekeeping', type: 'cron', schedule: '0 0 * * 0', callback: async () => {
      await runGuarded(log, 'Housekeeping: VACUUM failed', () => db.run(sql`VACUUM`));
      // If retention cannot be read, skip both prunes but still clean the blacklist.
      let retentionDays: number | null = null;
      await runGuarded(log, 'Housekeeping: retention read failed', async () => {
        retentionDays = (await services.settings.get('general')).housekeepingRetentionDays ?? 90;
      });
      // Whole clean-completed runs go first; anything held, skipped, or failed keeps both header and details.
      if (retentionDays !== null) {
        const days = retentionDays;
        await runGuarded(log, 'Housekeeping: event-history prune failed', () => services.eventHistory.pruneOlderThan(days));
        await runGuarded(log, 'Housekeeping: clean-completed submission prune failed', () => services.importStaging.pruneCleanCompleted(days));
        await runGuarded(log, 'Housekeeping: staged-detail prune failed', () => services.importStaging.pruneCompletedDetails(days));
      }
      await runGuarded(log, 'Housekeeping: blacklist cleanup failed', () => services.blacklist.deleteExpired());
    } },
    { name: 'health-check', type: 'cron', schedule: '*/5 * * * *', callback: () => services.healthCheck.runAllChecks() },
    { name: 'version-check', type: 'cron', schedule: '0 2 * * *', callback: () => checkForUpdate(log, onUpdateChanged) },
    { name: 'import-list-sync', type: 'cron', schedule: '* * * * *', callback: () => services.importList.syncDueLists() },
    { name: 'discovery', type: 'timeout', getIntervalMinutes: () => services.settings.get('discovery').then((s) => s.intervalHours * 60), callback: () => runDiscoveryJob(services.discovery, services.settings, log) },
    { name: 'series-refresh', type: 'cron', schedule: '0 3 * * 0', callback: () => runSeriesRefreshJob(services.seriesCard, log) },
    { name: 'library-rescan', type: 'cron', schedule: '0 */6 * * *', callback: async () => {
      try {
        await rescanLibraryWithCompanionSweep({ libraryScan: services.libraryScan, companionEbook: services.companionEbook, log });
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

  runStartupRecovery(db, services, log).catch((error: unknown) => {
    log.error({ error: serializeError(error) }, 'Startup recovery failed — jobs continue normally');
  });

  // Use TaskRegistry so the boot check stamps lastRun and reuses the cron's health nudge.
  reg.runTask('version-check').catch((error: unknown) => {
    log.error({ error: serializeError(error) }, 'Startup version check failed — jobs continue normally');
  });

  let stopped = false;
  const stopAll = (): void => {
    if (stopped) return;
    stopped = true;
    for (const cron of cronHandles) cron.stop();
    for (const handle of timeoutHandles) handle.stop();
  };

  return { stopAll };
}

// Each step guarded independently (#2557): the last two run ONLY at boot (cover backfill and the
// genre sweep have no cron), so an early throw would silently lose them for the process lifetime.
// The orchestrator batches are re-run by import-maintenance within minutes; the sweep and backfill
// are not.
async function runStartupRecovery(db: Db, services: Services, log: FastifyBaseLogger): Promise<void> {
  await runGuarded(log, 'Startup recovery: stuck-download reset failed', async () => {
    // Reset only pipelineStage; completed clientStatus is the recovery entry point.
    const resetResult = await db
      .update(downloads)
      .set({ pipelineStage: 'idle' })
      .where(inArray(downloads.pipelineStage, ['checking', 'importing']))
      .returning({ id: downloads.id });

    if (resetResult.length > 0) {
      log.info({ count: resetResult.length }, 'Startup recovery: reset stuck downloads to completed');
    }
  });

  await runGuarded(log, 'Startup recovery: quality-gate batch failed', () =>
    services.qualityGateOrchestrator.processCompletedDownloads());
  await runGuarded(log, 'Startup recovery: import batch failed', () =>
    services.importOrchestrator.processCompletedDownloads());

  await runGuarded(log, 'Startup recovery: cover backfill failed', () =>
    runCoverBackfill(db, log, services.connector));
  await runGuarded(log, 'Startup recovery: genre marker sweep failed', () =>
    runGenreMarkerSweep(db, services.book, log));
}

// Croner owns both firing and the next-run timestamp exposed by TaskRegistry.
export function scheduleCron(reg: TaskRegistry, name: string, expression: string, log: FastifyBaseLogger): Cron {
  const job = new Cron(expression, async () => {
    try {
      await reg.executeTracked(name);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `${name} job error`);
    } finally {
      // A null nextRun means no future occurrence; retain the last displayed value.
      const next = job.nextRun();
      if (next) reg.setNextRun(name, next);
    }
  });
  const next = job.nextRun();
  if (next) reg.setNextRun(name, next);
  return job;
}

/** Node clamps a delay above this — like a 30-day backup interval — to 1 ms, not to the ceiling. */
export const TIMEOUT_MAX_MS = 2_147_483_647;
/** Shared by the unusable-interval arm and the failed-read catch arm. */
export const INTERVAL_RETRY_MS = 5 * 60 * 1000;

export type NormalizedInterval =
  | { kind: 'ok'; delayMs: number }
  | { kind: 'clamped'; delayMs: number }
  | { kind: 'invalid' };

// Classify the PRODUCT, never the operand: a finite `intervalMinutes` still overflows to Infinity
// after ×60000, and a null read multiplies to 0 rather than NaN. Everything Node either rejects or
// rounds up to a 1 ms re-arm is 'invalid'.
export function normalizeIntervalMs(intervalMinutes: number): NormalizedInterval {
  const delayMs = intervalMinutes * 60 * 1000;
  if (!Number.isFinite(delayMs) || delayMs < 1) return { kind: 'invalid' };
  if (delayMs > TIMEOUT_MAX_MS) return { kind: 'clamped', delayMs: TIMEOUT_MAX_MS };
  return { kind: 'ok', delayMs };
}

// stop() blocks pending or queued ticks from firing or rearming. unref() keeps
// either timer path from pinning process shutdown.
// nextRun holds a real future firing time or null — never a stale or Invalid Date — for as long as
// the loop is running; stop() cancels timers and leaves the last published value on display.
function scheduleTimeoutLoop(
  reg: TaskRegistry,
  name: string,
  getIntervalMinutes: () => Promise<number>,
  log: FastifyBaseLogger,
): TimeoutLoopHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (fn: () => void, ms: number): void => {
    timer = setTimeout(fn, ms);
    timer.unref();
  };

  async function scheduleNext() {
    if (stopped) return;
    try {
      const intervalMinutes = await getIntervalMinutes();
      const normalized = normalizeIntervalMs(intervalMinutes);
      if (stopped) return; // stop may run during the interval read

      if (normalized.kind === 'invalid') {
        // String(): pino serialises NaN and Infinity to null, which reads as a MISSING field.
        log.warn({ job: name, intervalMinutes: String(intervalMinutes) }, `Unusable ${name} interval, retrying in 5 minutes`);
        reg.setNextRun(name, null);
        arm(scheduleNext, INTERVAL_RETRY_MS);
        return;
      }

      const intervalMs = normalized.delayMs;
      if (normalized.kind === 'clamped') {
        log.warn(
          { job: name, configuredDelayMs: String(intervalMinutes * 60 * 1000), effectiveDelayMs: intervalMs },
          `${name} interval exceeds the maximum timer delay, firing early instead`,
        );
      }
      reg.setNextRun(name, new Date(Date.now() + intervalMs));

      // Named so tests can attribute spy-observed timers to this loop among ambient ones (#2398).
      const runScheduledTick = async (): Promise<void> => {
        if (stopped) return; // queued ticks must not fire after stop
        try {
          await reg.executeTracked(name);
        } catch (error: unknown) {
          log.error({ error: serializeError(error) }, `${name} job error`);
        }
        scheduleNext();
      };
      arm(runScheduledTick, intervalMs);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `Failed to read ${name} interval, retrying in 5 minutes`);
      if (stopped) return;
      // A run time we can no longer confirm must not stay on display.
      reg.setNextRun(name, null);
      arm(scheduleNext, INTERVAL_RETRY_MS);
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
