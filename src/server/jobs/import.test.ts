import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportOrchestrator } from '../services/import-orchestrator.js';
import type { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(),
  },
}));

import cron from 'node-cron';

describe('startImportJob', () => {
  let mockOrchestrator: ImportOrchestrator;
  let mockQualityGateOrchestrator: QualityGateOrchestrator;
  let mockLog: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrchestrator = {
      processCompletedDownloads: vi.fn().mockResolvedValue(undefined),
    } as unknown as ImportOrchestrator;
    mockQualityGateOrchestrator = {
      processCompletedDownloads: vi.fn().mockResolvedValue(undefined),
    } as unknown as QualityGateOrchestrator;
    mockLog = {
      info: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger;
  });

  it('registers a cron schedule with the expected expression', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockOrchestrator, mockQualityGateOrchestrator, mockLog);

    expect(cron.schedule).toHaveBeenCalledWith(
      '*/60 * * * * *',
      expect.any(Function),
    );
  });

  it('logs startup message after scheduling', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockOrchestrator, mockQualityGateOrchestrator, mockLog);

    expect(mockLog.info).toHaveBeenCalledWith('Import job started (every 60 seconds)');
  });

  it('calls quality gate orchestrator then processCompletedDownloads when cron fires', async () => {
    const { startImportJob } = await import('./import.js');
    startImportJob(mockOrchestrator, mockQualityGateOrchestrator, mockLog);

    const callback = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await callback();

    expect(mockQualityGateOrchestrator.processCompletedDownloads).toHaveBeenCalled();
    expect(mockOrchestrator.processCompletedDownloads).toHaveBeenCalled();
  });

  it('logs error without throwing when processCompletedDownloads fails', async () => {
    const error = new Error('Import failed');
    (mockOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockRejectedValue(error);

    const { startImportJob } = await import('./import.js');
    startImportJob(mockOrchestrator, mockQualityGateOrchestrator, mockLog);

    const callback = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls[0][1];
    await callback();

    expect(mockLog.error).toHaveBeenCalledWith(error, 'Import job error');
  });
});
