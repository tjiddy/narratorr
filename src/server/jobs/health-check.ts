import cron from 'node-cron';
import type { HealthCheckService } from '../services/health-check.service.js';
import type { FastifyBaseLogger } from 'fastify';

let started = false;

export function startHealthCheckJob(healthCheckService: HealthCheckService, log: FastifyBaseLogger) {
  if (started) return;
  started = true;

  cron.schedule('*/5 * * * *', async () => {
    try {
      await healthCheckService.runAllChecks();
    } catch (error) {
      log.error(error, 'Health check job error');
    }
  });

  log.info('Health check job started (every 5 minutes)');
}

/** Reset for tests */
export function _resetHealthCheck() {
  started = false;
}
