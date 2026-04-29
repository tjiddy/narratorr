import { describe, it, expect, vi } from 'vitest';
import { runBackupJob } from './backup.js';
import type { BackupService } from '../services/backup.service.js';
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

  it('logs error on failure with canonical serialized payload', async () => {
    const mockBackup = {
      create: vi.fn().mockRejectedValue(new Error('disk full')),
      prune: vi.fn(),
    } as unknown as BackupService;
    const log = createMockLog();

    await runBackupJob(mockBackup, log);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: 'disk full', type: 'Error' }) }),
      'Backup job failed',
    );
  });
});

