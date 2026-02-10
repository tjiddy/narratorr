import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import type { DownloadClientService } from '../services';
import { startMonitorJob } from './monitor.js';

export function startJobs(db: Db, downloadClientService: DownloadClientService, log: FastifyBaseLogger) {
  startMonitorJob(db, downloadClientService, log);
  log.info('Background jobs started');
}
