import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { SettingsService } from '../services/settings.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import type { BlacklistService } from '../services/index.js';
import cron from 'node-cron';

let cronCallback: (() => Promise<void>) | null = null;

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, cb: () => Promise<void>) => {
      cronCallback = cb;
    }),
  },
}));

const { startHousekeepingJob } = await import('./housekeeping.js');

describe('housekeeping job', () => {
  let db: { run: ReturnType<typeof vi.fn> };
  let settingsService: { get: ReturnType<typeof vi.fn> };
  let eventHistoryService: { pruneOlderThan: ReturnType<typeof vi.fn> };
  let blacklistService: { deleteExpired: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = { run: vi.fn().mockResolvedValue(undefined) };
    settingsService = {
      get: vi.fn().mockResolvedValue({ logLevel: 'info', housekeepingRetentionDays: 90 }),
    };
    eventHistoryService = { pruneOlderThan: vi.fn().mockResolvedValue(5) };
    blacklistService = { deleteExpired: vi.fn().mockResolvedValue(3) };
    log = createMockLogger();
    cronCallback = null;

    startHousekeepingJob(
      db as unknown as Db,
      settingsService as unknown as SettingsService,
      eventHistoryService as unknown as EventHistoryService,
      blacklistService as unknown as BlacklistService,
      log as unknown as FastifyBaseLogger,
    );
  });

  async function runHousekeeping() {
    expect(cronCallback).not.toBeNull();
    await cronCallback!();
  }

  describe('scheduling & registration', () => {
    it('registers with weekly cron expression (0 0 * * 0)', () => {
      expect(cron.schedule).toHaveBeenCalledWith('0 0 * * 0', expect.any(Function));
    });

    it('logs startup message on registration', () => {
      expect(log.info).toHaveBeenCalledWith('Housekeeping job started (weekly on Sundays at midnight)');
    });
  });

  describe('VACUUM sub-task', () => {
    it('executes db.run(sql`VACUUM`) and logs confirmation', async () => {
      await runHousekeeping();

      expect(db.run).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith('Housekeeping: VACUUM completed');
    });

    it('VACUUM failure (database is locked) → error logged, other sub-tasks still run', async () => {
      const error = new Error('database is locked');
      db.run.mockRejectedValue(error);

      await runHousekeeping();

      expect(log.error).toHaveBeenCalledWith(error, 'Housekeeping: VACUUM failed');
      expect(eventHistoryService.pruneOlderThan).toHaveBeenCalled();
      expect(blacklistService.deleteExpired).toHaveBeenCalled();
    });

    it('VACUUM failure (disk full) → error logged, other sub-tasks still run', async () => {
      const error = new Error('disk full');
      db.run.mockRejectedValue(error);

      await runHousekeeping();

      expect(log.error).toHaveBeenCalledWith(error, 'Housekeeping: VACUUM failed');
      expect(eventHistoryService.pruneOlderThan).toHaveBeenCalled();
      expect(blacklistService.deleteExpired).toHaveBeenCalled();
    });
  });

  describe('event history pruning sub-task', () => {
    it('calls EventHistoryService.pruneOlderThan with retention days from settings', async () => {
      settingsService.get.mockResolvedValue({ logLevel: 'info', housekeepingRetentionDays: 30 });

      await runHousekeeping();

      expect(settingsService.get).toHaveBeenCalledWith('general');
      expect(eventHistoryService.pruneOlderThan).toHaveBeenCalledWith(30);
    });

    it('logs count of pruned events', async () => {
      eventHistoryService.pruneOlderThan.mockResolvedValue(42);

      await runHousekeeping();

      expect(log.info).toHaveBeenCalledWith(
        { deletedCount: 42, retentionDays: 90 },
        'Housekeeping: event history pruned',
      );
    });

    it('pruning failure → error logged, blacklist cleanup still runs', async () => {
      const error = new Error('pruning failed');
      eventHistoryService.pruneOlderThan.mockRejectedValue(error);

      await runHousekeeping();

      expect(log.error).toHaveBeenCalledWith(error, 'Housekeeping: event history pruning failed');
      expect(blacklistService.deleteExpired).toHaveBeenCalled();
    });
  });

  describe('blacklist cleanup sub-task', () => {
    it('calls BlacklistService.deleteExpired()', async () => {
      await runHousekeeping();

      expect(blacklistService.deleteExpired).toHaveBeenCalledTimes(1);
    });

    it('logs count of expired entries removed', async () => {
      blacklistService.deleteExpired.mockResolvedValue(7);

      await runHousekeeping();

      expect(log.info).toHaveBeenCalledWith(
        { deletedCount: 7 },
        'Housekeeping: expired blacklist entries cleaned',
      );
    });

    it('cleanup failure → error logged, job completes', async () => {
      const error = new Error('cleanup failed');
      blacklistService.deleteExpired.mockRejectedValue(error);

      await runHousekeeping();

      expect(log.error).toHaveBeenCalledWith(error, 'Housekeeping: blacklist cleanup failed');
      expect(log.info).toHaveBeenCalledWith('Housekeeping job completed');
    });
  });

  describe('error isolation', () => {
    it('all three sub-tasks fail → three separate error logs, job completes without crash', async () => {
      db.run.mockRejectedValue(new Error('vacuum failed'));
      eventHistoryService.pruneOlderThan.mockRejectedValue(new Error('prune failed'));
      blacklistService.deleteExpired.mockRejectedValue(new Error('cleanup failed'));

      await runHousekeeping();

      expect(log.error).toHaveBeenCalledTimes(3);
      expect(log.info).toHaveBeenCalledWith('Housekeeping job completed');
    });
  });

  describe('settings integration', () => {
    it('reads general.housekeepingRetentionDays from settings service', async () => {
      await runHousekeeping();

      expect(settingsService.get).toHaveBeenCalledWith('general');
    });

    it('uses default 90 when setting not configured', async () => {
      settingsService.get.mockResolvedValue({ logLevel: 'info' });

      await runHousekeeping();

      expect(eventHistoryService.pruneOlderThan).toHaveBeenCalledWith(90);
    });
  });
});
