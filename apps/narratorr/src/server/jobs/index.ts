import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Services } from '../routes/index.js';
import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';
import { startImportJob } from './import.js';
import { startSearchJob } from './search.js';

export function startJobs(db: Db, services: Services, log: FastifyBaseLogger) {
  startMonitorJob(db, services.downloadClient, log);
  startEnrichmentJob(db, services.metadata, log);
  startImportJob(services.import, log);
  startSearchJob(services.settings, services.book, services.indexer, services.download, log);
  log.info('Background jobs started');
}
