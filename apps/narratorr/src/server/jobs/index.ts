import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import type { DownloadClientService } from '../services';
import type { MetadataService } from '../services/metadata.service.js';
import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';

export function startJobs(db: Db, downloadClientService: DownloadClientService, metadataService: MetadataService, log: FastifyBaseLogger) {
  startMonitorJob(db, downloadClientService, log);
  startEnrichmentJob(db, metadataService, log);
  log.info('Background jobs started');
}
