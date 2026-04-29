import cron from 'node-cron';
import { sql, inArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { downloads } from '../../db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { MONITOR_CRON_INTERVAL } from './constants.js';
import { monitorDownloads } from './monitor.js';
import { runEnrichment } from './enrichment.js';
import { runSearchJob, runUpgradeSearchJob } from './search.js';
import { runRssJob } from './rss.js';
import { runBackupJob } from './backup.js';
import { checkForUpdate } from './version-check.js';
import { runDiscoveryJob } from './discovery.js';
import { runCoverBackfill } from './cover-backfill.js';
import { serializeError } from '../utils/serialize-error.js';


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

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger) {
  // RetrySearchDeps is constructed once in createServices() and exposed on the
  // Services bag so jobs and the composition root share the same instance.
  const retryDeps = {
    blacklistService: services.blacklist,
    retrySearchDeps: services.retrySearchDeps,
  };

  /** Job registry — adding a new job requires one entry here. */
  const jobRegistry: JobEntry[] = [
    { name: 'monitor', type: 'cron', schedule: MONITOR_CRON_INTERVAL, callback: () => monitorDownloads(db, services.downloadClient, services.notifier, log, retryDeps, services.eventBroadcaster, services.remotePathMapping, services.qualityGateOrchestrator, services.eventHistory) },
    { name: 'enrichment', type: 'cron', schedule: '*/5 * * * *', callback: () => runEnrichment(db, services.metadata, services.book, log) },
    { name: 'import-maintenance', type: 'cron', schedule: '*/5 * * * *', callback: async () => { await services.qualityGateOrchestrator.processCompletedDownloads(); await services.importOrchestrator.processCompletedDownloads(); await services.qualityGateOrchestrator.cleanupDeferredRejections(); await services.import.cleanupDeferredImports(); } },
    { name: 'search', type: 'timeout', getIntervalMinutes: () => services.settings.get('search').then((s) => s.intervalMinutes), callback: () => runSearchJob(services.settings, services.bookList, services.indexer, services.downloadOrchestrator, log, services.blacklist, services.retryBudget, services.eventBroadcaster) },
    { name: 'upgrade-search', type: 'timeout', getIntervalMinutes: () => services.settings.get('search').then((s) => s.intervalMinutes), callback: () => runUpgradeSearchJob(services.settings, services.book, services.indexer, services.downloadOrchestrator, log) },
    { name: 'rss', type: 'timeout', getIntervalMinutes: () => services.settings.get('rss').then((s) => s.intervalMinutes), callback: () => runRssJob(services.settings, services.bookList, services.book, services.indexer, services.downloadOrchestrator, services.blacklist, log) },
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
    { name: 'version-check', type: 'cron', schedule: '0 2 * * *', callback: () => checkForUpdate(log) },
    { name: 'import-list-sync', type: 'cron', schedule: '* * * * *', callback: () => services.importList.syncDueLists() },
    { name: 'discovery', type: 'timeout', getIntervalMinutes: () => services.settings.get('discovery').then((s) => s.intervalHours * 60), callback: () => runDiscoveryJob(services.discovery, services.settings, log) },
  ];

  const reg = services.taskRegistry;

  for (const job of jobRegistry) {
    const fn = job.callback as () => Promise<unknown>;
    if (job.type === 'cron') {
      reg.register(job.name, 'cron', fn, job.schedule);
      scheduleCron(reg, job.name, job.schedule, log);
    } else {
      reg.register(job.name, 'timeout', fn);
      scheduleTimeoutLoop(reg, job.name, job.getIntervalMinutes, log);
    }
  }

  log.info('Background jobs started');

  // Startup recovery: reset stuck downloads and reprocess (#358)
  runStartupRecovery(db, services, log).catch((error: unknown) => {
    log.error({ error: serializeError(error) }, 'Startup recovery failed — jobs continue normally');
  });
}

async function runStartupRecovery(db: Db, services: Services, log: FastifyBaseLogger): Promise<void> {
  // Reset downloads stuck in checking/importing back to completed
  const resetResult = await db
    .update(downloads)
    .set({ status: 'completed' })
    .where(inArray(downloads.status, ['checking', 'importing']))
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

function scheduleCron(reg: TaskRegistry, name: string, expression: string, log: FastifyBaseLogger): void {
  cron.schedule(expression, async () => {
    try {
      await reg.executeTracked(name);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `${name} job error`);
    }
  });
}

function scheduleTimeoutLoop(
  reg: TaskRegistry,
  name: string,
  getIntervalMinutes: () => Promise<number>,
  log: FastifyBaseLogger,
): void {
  async function scheduleNext() {
    try {
      const intervalMinutes = await getIntervalMinutes();
      const intervalMs = intervalMinutes * 60 * 1000;
      reg.setNextRun(name, new Date(Date.now() + intervalMs));

      setTimeout(async () => {
        try {
          await reg.executeTracked(name);
        } catch (error: unknown) {
          log.error({ error: serializeError(error) }, `${name} job error`);
        }
        scheduleNext();
      }, intervalMs);
    } catch (error: unknown) {
      log.error({ error: serializeError(error) }, `Failed to read ${name} interval, retrying in 5 minutes`);
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
}
