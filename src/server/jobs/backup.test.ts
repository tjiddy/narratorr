import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBackupJob, startBackupJob } from './backup.js';
import type { BackupService } from '../services/backup.service.js';
import type { SettingsService } from '../services/index.js';
import type { FastifyBaseLogger } from 'fastify';

function createMockLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

describe('runBackupJob', () => {
  it('calls create and prune on success', async () => {
    const mockBackup = {
      create: vi.fn().mockResolvedValue({ filename: 'test.zip', timestamp: new Date().toISOString(), size: 1024 }),
      prune: vi.fn().mockResolvedValue(2),
    } as unknown as BackupService;

    const result = await runBackupJob(mockBackup, createMockLog());

    expect(result).toEqual({ created: true, pruned: 2 });
    expect(mockBackup.create).toHaveBeenCalled();
    expect(mockBackup.prune).toHaveBeenCalled();
  });

  it('returns created=false on failure without throwing', async () => {
    const mockBackup = {
      create: vi.fn().mockRejectedValue(new Error('disk full')),
      prune: vi.fn(),
    } as unknown as BackupService;

    const result = await runBackupJob(mockBackup, createMockLog());

    expect(result).toEqual({ created: false, pruned: 0 });
    expect(mockBackup.prune).not.toHaveBeenCalled();
  });

  it('logs error on failure', async () => {
    const mockBackup = {
      create: vi.fn().mockRejectedValue(new Error('disk full')),
      prune: vi.fn(),
    } as unknown as BackupService;
    const log = createMockLog();

    await runBackupJob(mockBackup, log);

    expect((log as unknown as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalled();
  });
});

describe('startBackupJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads interval from settings and schedules setTimeout', async () => {
    const mockSettings = {
      get: vi.fn().mockResolvedValue({ backupIntervalMinutes: 60 }),
    } as unknown as SettingsService;
    const mockBackup = {} as unknown as BackupService;
    const log = createMockLog();

    startBackupJob(mockSettings, mockBackup, log);

    // Let the async scheduleNext() resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSettings.get).toHaveBeenCalledWith('system');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('retries in 5 minutes when settings read fails', async () => {
    const mockSettings = {
      get: vi.fn().mockRejectedValue(new Error('db error')),
    } as unknown as SettingsService;
    const mockBackup = {} as unknown as BackupService;
    const log = createMockLog();

    startBackupJob(mockSettings, mockBackup, log);

    // Let the async scheduleNext() reject and hit the catch branch
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(1);
  });

  it('fires the timer callback, runs backup job, and recursively reschedules', async () => {
    const mockSettings = {
      get: vi.fn().mockResolvedValue({ backupIntervalMinutes: 60 }),
    } as unknown as SettingsService;
    const mockBackup = {
      create: vi.fn().mockResolvedValue({ filename: 'test.zip', timestamp: '2026-01-01', size: 1024 }),
      prune: vi.fn().mockResolvedValue(0),
    } as unknown as BackupService;
    const log = createMockLog();

    startBackupJob(mockSettings, mockBackup, log);

    // Let scheduleNext() resolve and schedule the initial timer
    await vi.advanceTimersByTimeAsync(0);
    expect(mockSettings.get).toHaveBeenCalledTimes(1);

    // Fire the timer (60 min = 3600000ms) — this runs the backup job
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    // The job should have run
    expect(mockBackup.create).toHaveBeenCalled();
    expect(mockBackup.prune).toHaveBeenCalled();

    // scheduleNext should have re-read settings for the next cycle
    expect(mockSettings.get).toHaveBeenCalledTimes(2);

    // A new timer should be scheduled for the next cycle
    expect(vi.getTimerCount()).toBe(1);
  });

  it('logs startup message', () => {
    const mockSettings = {
      get: vi.fn().mockResolvedValue({ backupIntervalMinutes: 60 }),
    } as unknown as SettingsService;
    const mockBackup = {} as unknown as BackupService;
    const log = createMockLog();

    startBackupJob(mockSettings, mockBackup, log);

    expect(log.info).toHaveBeenCalledWith('Backup job scheduler started');
  });
});
