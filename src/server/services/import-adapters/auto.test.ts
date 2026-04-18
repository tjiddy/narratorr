import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportAdapterContext, ImportJob, AutoImportJobPayload } from './types.js';
import type { ImportOrchestrator } from '../import-orchestrator.js';
import { AutoImportAdapter } from './auto.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  const payload: AutoImportJobPayload = { downloadId: 99 };
  return {
    id: 1,
    bookId: 42,
    type: 'auto',
    status: 'processing',
    phase: 'queued',
    metadata: JSON.stringify(payload),
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    phaseHistory: null,
    completedAt: null,
    ...overrides,
  };
}

describe('AutoImportAdapter', () => {
  let adapter: AutoImportAdapter;
  let mockOrchestrator: { importDownload: ReturnType<typeof vi.fn> };
  let ctx: ImportAdapterContext;
  let setPhase: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOrchestrator = {
      importDownload: vi.fn().mockResolvedValue({ downloadId: 99, bookId: 42, targetPath: '/lib/Author/Title', fileCount: 3, totalSize: 100_000 }),
    };

    setPhase = vi.fn().mockResolvedValue(undefined);
    ctx = {
      db: {} as never,
      log: createMockLogger(),
      setPhase: setPhase as unknown as ImportAdapterContext['setPhase'],
      emitProgress: vi.fn(),
    };

    adapter = new AutoImportAdapter(mockOrchestrator as unknown as ImportOrchestrator);
  });

  describe('process', () => {
    it('delegates to ImportOrchestrator.importDownload() with downloadId from metadata', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      expect(mockOrchestrator.importDownload).toHaveBeenCalledWith(99);
    });

    it('calls setPhase with analyzing before delegating', async () => {
      const job = makeJob();
      await adapter.process(job, ctx);

      expect(setPhase).toHaveBeenCalledWith('analyzing');
      // setPhase should be called before importDownload
      const setPhaseOrder = setPhase.mock.invocationCallOrder[0];
      const importOrder = mockOrchestrator.importDownload.mock.invocationCallOrder[0];
      expect(setPhaseOrder).toBeLessThan(importOrder);
    });

    it('throws when bookId is null on the job', async () => {
      const job = makeJob({ bookId: null });

      await expect(adapter.process(job, ctx)).rejects.toThrow('AutoImportAdapter requires a bookId');
    });

    it('throws descriptive error when downloadId is missing from metadata', async () => {
      const job = makeJob({ metadata: JSON.stringify({}) });

      await expect(adapter.process(job, ctx)).rejects.toThrow('downloadId missing from metadata');
    });

    it('propagates error from ImportOrchestrator.importDownload()', async () => {
      mockOrchestrator.importDownload.mockRejectedValue(new Error('No audio files found'));
      const job = makeJob();

      await expect(adapter.process(job, ctx)).rejects.toThrow('No audio files found');
    });
  });
});
