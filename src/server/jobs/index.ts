import cron from 'node-cron';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import type { TaskRegistry } from '../services/task-registry.js';
import { createRetrySearchDeps } from '../services/retry-search.js';
import { monitorDownloads } from './monitor.js';
import { runEnrichment } from './enrichment.js';
import { runSearchJob } from './search.js';
import { runRssJob } from './rss.js';
import { runBackupJob } from './backup.js';
import { checkForUpdate } from './version-check.js';
import { runDiscoveryJob } from './discovery.js';

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger) {
  const retrySearchDeps = createRetrySearchDeps(
    { indexer: services.indexer, downloadOrchestrator: services.downloadOrchestrator, blacklist: services.blacklist, book: services.book, settings: services.settings, retryBudget: services.retryBudget },
    log,
  );

  const retryDeps = {
    blacklistService: services.blacklist,
    retrySearchDeps,
  };

  const reg = services.taskRegistry;

  // Register all jobs with the task registry for the dashboard
  reg.register('monitor', 'cron', () => monitorDownloads(db, services.downloadClient, services.notifier, log, retryDeps, services.eventBroadcaster), '*/30 * * * * *');
  reg.register('enrichment', 'cron', () => runEnrichment(db, services.metadata, log), '*/5 * * * *');
  reg.register('import', 'cron', async () => {
    await services.qualityGateOrchestrator.processCompletedDownloads();
    await services.importOrchestrator.processCompletedDownloads();
  }, '*/60 * * * * *');
  reg.register('search', 'timeout', () => runSearchJob(services.settings, services.bookList, services.indexer, services.downloadOrchestrator, log, services.retryBudget));
  reg.register('rss', 'timeout', () => runRssJob(services.settings, services.bookList, services.book, services.indexer, services.downloadOrchestrator, services.blacklist, log));
  reg.register('backup', 'timeout', () => runBackupJob(services.backup, log));
  reg.register('housekeeping', 'cron', async () => {
    await db.run(sql`VACUUM`);
    const generalSettings = await services.settings.get('general');
    const retentionDays = generalSettings.housekeepingRetentionDays ?? 90;
    await services.eventHistory.pruneOlderThan(retentionDays);
    await services.blacklist.deleteExpired();
  }, '0 0 * * 0');
  reg.register('recycle-cleanup', 'cron', () => services.recyclingBin.purgeExpired(), '0 2 * * *');
  reg.register('health-check', 'cron', () => services.healthCheck.runAllChecks(), '*/5 * * * *');
  reg.register('version-check', 'cron', () => checkForUpdate(log), '0 2 * * *');
  reg.register('import-list-sync', 'cron', () => services.importList.syncDueLists(), '* * * * *');
  reg.register('discovery', 'timeout', () => runDiscoveryJob(services.discovery, services.settings, log));

  // Schedule cron jobs — all go through the registry for lastRun/running tracking
  scheduleCron(reg, 'monitor', '*/30 * * * * *', log);
  scheduleCron(reg, 'enrichment', '*/5 * * * *', log);
  scheduleCron(reg, 'import', '*/60 * * * * *', log);
  scheduleCron(reg, 'housekeeping', '0 0 * * 0', log);
  scheduleCron(reg, 'recycle-cleanup', '0 2 * * *', log);
  scheduleCron(reg, 'health-check', '*/5 * * * *', log);
  scheduleCron(reg, 'version-check', '0 2 * * *', log);
  scheduleCron(reg, 'import-list-sync', '* * * * *', log);

  // Schedule timeout-loop jobs — use registry tracking for lastRun/running/nextRun
  scheduleTimeoutLoop(reg, 'search', () => services.settings.get('search').then((s) => s.intervalMinutes), log);
  scheduleTimeoutLoop(reg, 'rss', () => services.settings.get('rss').then((s) => s.intervalMinutes), log);
  scheduleTimeoutLoop(reg, 'backup', () => services.settings.get('system').then((s) => s.backupIntervalMinutes), log);
  scheduleTimeoutLoop(reg, 'discovery', () => services.settings.get('discovery').then((s) => s.intervalHours * 60), log);

  log.info('Background jobs started');
}

function scheduleCron(reg: TaskRegistry, name: string, expression: string, log: FastifyBaseLogger): void {
  cron.schedule(expression, async () => {
    try {
      await reg.executeTracked(name);
    } catch (error) {
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
        } catch (error) {
          log.error(error, `${name} job error`);
        }
        scheduleNext();
      }, intervalMs);
    } catch (error) {
      log.error(error, `Failed to read ${name} interval, retrying in 5 minutes`);
      setTimeout(scheduleNext, 5 * 60 * 1000);
    }
  }

  scheduleNext();
}
