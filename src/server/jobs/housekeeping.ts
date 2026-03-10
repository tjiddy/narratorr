import cron from 'node-cron';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { BlacklistService } from '../services/index.js';

export function startHousekeepingJob(
  db: Db,
  settingsService: SettingsService,
  eventHistoryService: EventHistoryService,
  blacklistService: BlacklistService,
  log: FastifyBaseLogger,
) {
  // Run weekly on Sunday at midnight
  cron.schedule('0 0 * * 0', async () => {
    log.info('Housekeeping job started');

    // Sub-task 1: VACUUM
    try {
      await db.run(sql`VACUUM`);
      log.info('Housekeeping: VACUUM completed');
    } catch (error) {
      log.error(error, 'Housekeeping: VACUUM failed');
    }

    // Sub-task 2: Event history pruning
    try {
      const generalSettings = await settingsService.get('general');
      const retentionDays = generalSettings.housekeepingRetentionDays ?? 90;
      const deletedCount = await eventHistoryService.pruneOlderThan(retentionDays);
      log.info({ deletedCount, retentionDays }, 'Housekeeping: event history pruned');
    } catch (error) {
      log.error(error, 'Housekeeping: event history pruning failed');
    }

    // Sub-task 3: Blacklist cleanup
    try {
      const deletedCount = await blacklistService.deleteExpired();
      log.info({ deletedCount }, 'Housekeeping: expired blacklist entries cleaned');
    } catch (error) {
      log.error(error, 'Housekeeping: blacklist cleanup failed');
    }

    log.info('Housekeeping job completed');
  });

  log.info('Housekeeping job started (weekly on Sundays at midnight)');
}
