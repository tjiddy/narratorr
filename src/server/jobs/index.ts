import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';
import { startImportJob } from './import.js';
import { startSearchJob } from './search.js';

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
  });
  startEnrichmentJob(db, services.metadata, log);
  startImportJob(services.import, log);
  startSearchJob(services.settings, services.book, services.indexer, services.download, log, services.retryBudget);
  log.info('Background jobs started');
}
