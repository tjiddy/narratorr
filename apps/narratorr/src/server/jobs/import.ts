import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportService } from '../services/import.service.js';

export function startImportJob(importService: ImportService, log: FastifyBaseLogger) {
  // Run every 60 seconds
  cron.schedule('*/60 * * * * *', async () => {
    try {
      await importService.processCompletedDownloads();
    } catch (error) {
      log.error(error, 'Import job error');
    }
  });

  log.info('Import job started (every 60 seconds)');
}
