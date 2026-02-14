import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import type { DownloadClientService } from '../services';
import type { MetadataService } from '../services/metadata.service.js';
import type { ImportService } from '../services/import.service.js';
import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';
import { startImportJob } from './import.js';

export function startJobs(db: Db, downloadClientService: DownloadClientService, metadataService: MetadataService, importService: ImportService, log: FastifyBaseLogger) {
  startMonitorJob(db, downloadClientService, log);
  startEnrichmentJob(db, metadataService, log);
  startImportJob(importService, log);
  log.info('Background jobs started');
}
