import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportService } from '../services/import.service.js';
import type { QualityGateService } from '../services/quality-gate.service.js';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(),
  },
}));

import cron from 'node-cron';

describe('startImportJob', () => {
  let mockImportService: ImportService;
  let mockQualityGateService: QualityGateService;
  let mockLog: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockImportService = {
      processCompletedDownloads: vi.fn().mockResolvedValue(undefined),
    } as unknown as ImportService;
    mockQualityGateService = {
      processCompletedDownloads: vi.fn().mockResolvedValue(undefined),
    } as unknown as QualityGateService;
    mockLog = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger;
  });

  it('registers a cron schedule with the expected expression', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockImportService, mockQualityGateService, mockLog);

    expect(cron.schedule).toHaveBeenCalledWith(
      '*/60 * * * * *',
      expect.any(Function),
    );
  });

  it('logs startup message after scheduling', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockImportService, mockQualityGateService, mockLog);

    expect(mockLog.info).toHaveBeenCalledWith('Import job started (every 60 seconds)');
  });

  it('calls quality gate then processCompletedDownloads when cron fires', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockImportService, mockQualityGateService, mockLog);

    const callback = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await callback();

    expect(mockQualityGateService.processCompletedDownloads).toHaveBeenCalled();
    expect(mockImportService.processCompletedDownloads).toHaveBeenCalled();
  });

  it('logs error without throwing when processCompletedDownloads fails', async () => {
    const error = new Error('Import failed');
    (mockImportService.processCompletedDownloads as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const { startImportJob } = await import('./import.js');
    startImportJob(mockImportService, mockQualityGateService, mockLog);

    const callback = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await callback();

    expect(mockLog.error).toHaveBeenCalledWith(error, 'Import job error');
  });
});
