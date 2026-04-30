import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { BookImportService, EnqueueImportResult } from '../services/book-import.service.js';
import { enqueueAutoImport } from './enqueue-auto-import.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function createMockBookImportService(result: EnqueueImportResult) {
  return {
    enqueue: vi.fn().mockResolvedValue(result),
  };
}

describe('enqueueAutoImport (thin wrapper around BookImportService.enqueue)', () => {
  let log: FastifyBaseLogger;
  const nudge = vi.fn((): void => {});

  beforeEach(() => {
    log = createMockLogger();
    nudge.mockClear();
  });

  it('delegates to BookImportService.enqueue with type=auto and downloadId metadata', async () => {
    const svc = createMockBookImportService({ jobId: 42 });

    const result = await enqueueAutoImport(svc as unknown as BookImportService, 99, 1, nudge, log);

    expect(result).toBe(true);
    expect(svc.enqueue).toHaveBeenCalledWith({
      bookId: 1,
      type: 'auto',
      metadata: JSON.stringify({ downloadId: 99 }),
    });
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it('returns false and skips nudge when enqueue reports active-job-exists', async () => {
    const svc = createMockBookImportService({ error: 'active-job-exists', status: 409 });

    const result = await enqueueAutoImport(svc as unknown as BookImportService, 99, 1, nudge, log);

    expect(result).toBe(false);
    expect(nudge).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ downloadId: 99, bookId: 1 }),
      expect.stringContaining('skipping'),
    );
  });

  it('does not catch unexpected errors from enqueue', async () => {
    const svc = {
      enqueue: vi.fn().mockRejectedValue(new Error('disk I/O error')),
    };

    await expect(
      enqueueAutoImport(svc as unknown as BookImportService, 99, 1, nudge, log),
    ).rejects.toThrow('disk I/O error');
    expect(nudge).not.toHaveBeenCalled();
  });
});
