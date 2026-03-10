import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';
import { startImportJob } from './import.js';
import { startSearchJob } from './search.js';
import { startRssJob } from './rss.js';
import { startBlacklistCleanupJob } from './blacklist-cleanup.js';

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger) {
  const retrySearchDeps = {
    indexerService: services.indexer,
    downloadService: services.download,
    blacklistService: services.blacklist,
    bookService: services.book,
    settingsService: services.settings,
    retryBudget: services.retryBudget,
    log,
  };

  startMonitorJob(db, services.downloadClient, services.notifier, log, {
    blacklistService: services.blacklist,
    retrySearchDeps,
  }, services.eventBroadcaster);
  startEnrichmentJob(db, services.metadata, log);
  startImportJob(services.import, services.qualityGate, log);
  startSearchJob(services.settings, services.book, services.indexer, services.download, log, services.retryBudget);
  startRssJob(services.settings, services.book, services.indexer, services.download, services.blacklist, log);
  startBlacklistCleanupJob(services.blacklist, log);
  log.info('Background jobs started');
}
