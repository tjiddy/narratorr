import cron from 'node-cron';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { createRetrySearchDeps } from '../services/retry-search.js';
import { MONITOR_CRON_INTERVAL } from './constants.js';
import { monitorDownloads } from './monitor.js';
import { runEnrichment } from './enrichment.js';
import { runSearchJob } from './search.js';
import { runRssJob } from './rss.js';
import { runBackupJob } from './backup.js';
import { checkForUpdate } from './version-check.js';
import { runDiscoveryJob } from './discovery.js';

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
  const retrySearchDeps = createRetrySearchDeps(
    { indexer: services.indexer, downloadOrchestrator: services.downloadOrchestrator, blacklist: services.blacklist, book: services.book, settings: services.settings, retryBudget: services.retryBudget },
    log,
  );

  const retryDeps = {
    blacklistService: services.blacklist,
    retrySearchDeps,
  };

  /** Job registry — adding a new job requires one entry here. */
  const jobRegistry: JobEntry[] = [
    { name: 'monitor', type: 'cron', schedule: MONITOR_CRON_INTERVAL, callback: () => monitorDownloads(db, services.downloadClient, services.notifier, log, retryDeps, services.eventBroadcaster) },
    { name: 'enrichment', type: 'cron', schedule: '*/5 * * * *', callback: () => runEnrichment(db, services.metadata, log) },
    { name: 'import', type: 'cron', schedule: '*/60 * * * * *', callback: async () => { await services.qualityGateOrchestrator.processCompletedDownloads(); await services.importOrchestrator.processCompletedDownloads(); } },
    { name: 'search', type: 'timeout', getIntervalMinutes: () => services.settings.get('search').then((s) => s.intervalMinutes), callback: () => runSearchJob(services.settings, services.bookList, services.indexer, services.downloadOrchestrator, log, services.retryBudget) },
    { name: 'rss', type: 'timeout', getIntervalMinutes: () => services.settings.get('rss').then((s) => s.intervalMinutes), callback: () => runRssJob(services.settings, services.bookList, services.book, services.indexer, services.downloadOrchestrator, services.blacklist, log) },
    { name: 'backup', type: 'timeout', getIntervalMinutes: () => services.settings.get('system').then((s) => s.backupIntervalMinutes), callback: () => runBackupJob(services.backup, log) },
    { name: 'housekeeping', type: 'cron', schedule: '0 0 * * 0', callback: async () => { await db.run(sql`VACUUM`); const generalSettings = await services.settings.get('general'); const retentionDays = generalSettings.housekeepingRetentionDays ?? 90; await services.eventHistory.pruneOlderThan(retentionDays); await services.blacklist.deleteExpired(); } },
    { name: 'recycle-cleanup', type: 'cron', schedule: '0 2 * * *', callback: () => services.recyclingBin.purgeExpired() },
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
}

function scheduleCron(reg: TaskRegistry, name: string, expression: string, log: FastifyBaseLogger): void {
  cron.schedule(expression, async () => {
    try {
      await reg.executeTracked(name);
    } catch (error: unknown) {
      log.error(error, `${name} job error`);
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
          log.error(error, `${name} job error`);
        }
        scheduleNext();
      }, intervalMs);
    } catch (error: unknown) {
      log.error(error, `Failed to read ${name} interval, retrying in 5 minutes`);
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
}
