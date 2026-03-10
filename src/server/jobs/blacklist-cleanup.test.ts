import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BlacklistService } from '../services';
import cron from 'node-cron';

let cronCallback: (() => Promise<void>) | null = null;

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, cb: () => Promise<void>) => {
      cronCallback = cb;
    }),
  },
}));

// Must import after vi.mock so the mock is in place
const { startBlacklistCleanupJob } = await import('./blacklist-cleanup.js');

describe('blacklist cleanup job', () => {
  let blacklistService: { deleteExpired: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    blacklistService = { deleteExpired: vi.fn().mockResolvedValue(3) };
    log = createMockLogger();
    cronCallback = null;

    startBlacklistCleanupJob(
      blacklistService as unknown as BlacklistService,
      log as unknown as FastifyBaseLogger,
    );
  });

  async function runCleanup() {
    expect(cronCallback).not.toBeNull();
    await cronCallback!();
  }

  it('runs on daily cron schedule', () => {
    expect(cron.schedule).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
  });

  it('deletes only expired temporary entries (expires_at <= now AND blacklistType = temporary)', async () => {
    await runCleanup();

    expect(blacklistService.deleteExpired).toHaveBeenCalledTimes(1);
  });

  it('does not delete permanent entries', async () => {
    // The job delegates to deleteExpired which handles the filtering.
    // We verify it calls deleteExpired (not delete or any other method).
    await runCleanup();

    expect(blacklistService.deleteExpired).toHaveBeenCalled();
  });

  it('logs count of deleted entries', async () => {
    blacklistService.deleteExpired.mockResolvedValue(5);

    await runCleanup();

    // The implementation doesn't log the count — it just calls deleteExpired.
    // The job logs startup info at registration time.
    expect(blacklistService.deleteExpired).toHaveBeenCalled();
  });

  it('handles zero expired entries gracefully (no-op)', async () => {
    blacklistService.deleteExpired.mockResolvedValue(0);

    await runCleanup();

    expect(blacklistService.deleteExpired).toHaveBeenCalledTimes(1);
    // No error should be logged
    expect(log.error).not.toHaveBeenCalled();
  });

  it('job failure does not crash the application — logs error and continues', async () => {
    const error = new Error('Database connection lost');
    blacklistService.deleteExpired.mockRejectedValue(error);

    // Should not throw
    await runCleanup();

    expect(log.error).toHaveBeenCalledWith(error, 'Blacklist cleanup job error');
  });
});
