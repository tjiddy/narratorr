import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportOrchestrator } from '../services/import-orchestrator.js';
import type { QualityGateService } from '../services/quality-gate.service.js';

export function startImportJob(importOrchestrator: ImportOrchestrator, qualityGateService: QualityGateService, log: FastifyBaseLogger) {
  // Run every 60 seconds
  cron.schedule('*/60 * * * * *', async () => {
    try {
      // Quality gate runs first: completed → checking → (completed|pending_review|failed)
      await qualityGateService.processCompletedDownloads();
      // Import picks up downloads that passed the gate (still completed)
      await importOrchestrator.processCompletedDownloads();
    } catch (error) {
      log.error(error, 'Import job error');
    }
  });

  log.info('Import job started (every 60 seconds)');
}
