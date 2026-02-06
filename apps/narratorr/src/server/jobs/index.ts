import type { Db } from '@narratorr/db';
import type { DownloadClientService } from '../services';
import { startMonitorJob } from './monitor.js';

export function startJobs(db: Db, downloadClientService: DownloadClientService) {
  startMonitorJob(db, downloadClientService);
  console.log('Background jobs started');
}
