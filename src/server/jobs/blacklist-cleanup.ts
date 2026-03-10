import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { BlacklistService } from '../services';

export function startBlacklistCleanupJob(
  blacklistService: BlacklistService,
  log: FastifyBaseLogger,
) {
  // Run daily at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await blacklistService.deleteExpired();
    } catch (error) {
      log.error(error, 'Blacklist cleanup job error');
    }
  });

  log.info('Blacklist cleanup job started (daily at midnight)');
}
