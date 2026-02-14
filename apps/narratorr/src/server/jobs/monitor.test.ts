import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';

let cronCallback: (() => Promise<void>) | null = null;

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, cb: () => Promise<void>) => {
      cronCallback = cb;
    }),
  },
}));

// Must import after vi.mock so the mock is in place
const { startMonitorJob } = await import('./monitor.js');

describe('monitor job', () => {
  let db: ReturnType<typeof createMockDb>;
  let downloadClientService: { getAdapter: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let adapter: { getDownload: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    adapter = { getDownload: vi.fn() };
    downloadClientService = { getAdapter: vi.fn().mockResolvedValue(adapter) };
    cronCallback = null;

    // Register the cron callback
    startMonitorJob(db as any, downloadClientService as any, log as any);
  });

  async function runMonitor() {
    expect(cronCallback).not.toBeNull();
    await cronCallback!();
  }

  it('does nothing when no active downloads', async () => {
    db.select.mockReturnValueOnce(mockDbChain([]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips downloads without externalId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: null, downloadClientId: 10, status: 'downloading' },
    ]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips downloads without downloadClientId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: null, status: 'downloading' },
    ]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('marks download as failed when not found in client', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(adapter.getDownload).toHaveBeenCalledWith('ext-1');
    expect(db.update).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
  });

  it('updates progress and status from adapter', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 50,
      status: 'downloading',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(db.update).toHaveBeenCalled();
    // Status unchanged, so debug log for progress
    expect(log.debug).toHaveBeenCalledWith({ id: 1, progress: 0.5 }, 'Download progress');
  });

  it('logs state transitions at info level', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('logs completion and queues for import when download completes with bookId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // Only 1 update call: download status to completed (import job handles the rest)
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { bookId: 42, downloadId: 1 },
      'Download completed, queued for import',
    );
  });

  it('does not update book when download completes without bookId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // Only 1 update call: download status
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ bookId: expect.anything() }),
      'Book status updated from monitor',
    );
  });

  it('handles adapter errors gracefully per download', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading' },
      { id: 2, externalId: 'ext-2', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ progress: 25, status: 'downloading' });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // First download errors, second still processes
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'Error monitoring download',
    );
    // Second download should still update
    expect(db.update).toHaveBeenCalled();
  });

  it('skips when adapter is null', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading' },
    ]));
    downloadClientService.getAdapter.mockResolvedValueOnce(null);

    await runMonitor();

    expect(adapter.getDownload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('maps seeding status to completed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 80,
      status: 'seeding',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // seeding maps to completed, which differs from 'downloading' → state change
    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('maps error status to failed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 30,
      status: 'error',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'failed' }, 'Download state changed');
  });

  it('maps paused status to paused', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'paused', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 60,
      status: 'paused',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // Status unchanged (paused → paused), so debug log
    expect(log.debug).toHaveBeenCalledWith({ id: 1, progress: 0.6 }, 'Download progress');
  });
});
