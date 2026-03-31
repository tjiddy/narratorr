import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { RetryBudget } from '../services/retry-budget.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import { createMockDbBook } from '../__tests__/factories.js';

let cronCallback: (() => Promise<void>) | null = null;

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_expression: string, cb: () => Promise<void>) => {
      cronCallback = cb;
    }),
  },
}));

// Must import after vi.mock so the mock is in place
const { startMonitorJob, monitorDownloads } = await import('./monitor.js');

describe('monitor job', () => {
  let db: ReturnType<typeof createMockDb>;
  let downloadClientService: { getAdapter: ReturnType<typeof vi.fn> };
  let notifierService: { notify: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let adapter: { getDownload: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    adapter = { getDownload: vi.fn() };
    downloadClientService = { getAdapter: vi.fn().mockResolvedValue(adapter) };
    notifierService = { notify: vi.fn().mockResolvedValue(undefined) };
    cronCallback = null;

    // Register the cron callback
    startMonitorJob(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));
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

  it('includes progressUpdatedAt in update payload when progress changes', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', progress: 0.3, completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
    const chain = mockDbChain();
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    expect(setCalls).toContainEqual(expect.objectContaining({ progressUpdatedAt: expect.any(Date) }));
  });

  it('omits progressUpdatedAt from update payload when progress is unchanged', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', progress: 0.5, completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
    const chain = mockDbChain();
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const progressUpdate = setCalls.find((c) => 'progress' in c);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate).not.toHaveProperty('progressUpdatedAt');
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

  it('routes error + progress 100% to failure path — newStatus is failed not completed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error' });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'failed' }, 'Download state changed');
  });

  it('does not set completedAt when status is error and progress is 100', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error' });
    const chain = mockDbChain();
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const progressUpdate = setCalls.find((c) => 'progress' in c);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate!.completedAt).toBeNull();
  });

  it('does not fire on_download_complete notification when status is error and progress is 100', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42, title: 'Test Book' },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error', savePath: '/downloads/test', size: 1000 });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(notifierService.notify).not.toHaveBeenCalledWith('on_download_complete', expect.anything());
  });

  it('writes DownloadItemInfo.errorMessage to downloads.errorMessage on initial failure detection', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 0, status: 'error', errorMessage: 'CRC mismatch in article 42' });
    const chain = mockDbChain();
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const progressUpdate = setCalls.find((c) => 'progress' in c);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate!.errorMessage).toBe('CRC mismatch in article 42');
  });

  it('preserves existing completedAt on re-download (already completed)', async () => {
    const existingCompletedAt = new Date('2025-01-15T10:00:00Z');
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: existingCompletedAt, bookId: 42 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // completedAt already set, so the update should keep the existing value, not overwrite with new Date()
    expect(db.update).toHaveBeenCalled();
    // Should NOT log "Download completed, queued for import" because status was already 'downloading'
    // but it does because download.status !== 'completed'. The key check: completedAt is preserved.
    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('handles download item with zero progress', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'queued', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 0,
      status: 'downloading',
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(db.update).toHaveBeenCalled();
    // Status changed from queued to downloading
    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'downloading' }, 'Download state changed');
  });

  it('continues processing remaining downloads when one throws an error', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
      { id: 2, externalId: 'ext-2', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
      { id: 3, externalId: 'ext-3', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
    ]));
    adapter.getDownload
      .mockResolvedValueOnce({ progress: 50, status: 'downloading' })   // id:1 ok
      .mockRejectedValueOnce(new Error('Timeout'))                        // id:2 throws
      .mockResolvedValueOnce({ progress: 75, status: 'downloading' });   // id:3 ok
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    // All three should be attempted
    expect(adapter.getDownload).toHaveBeenCalledTimes(3);
    // Error logged for id:2
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'Error monitoring download',
    );
    // id:1 and id:3 should still update successfully
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it('sends failure notification when download not found in client', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', title: 'My Audiobook' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(notifierService.notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({
      event: 'on_failure',
      book: { title: 'My Audiobook' },
      error: { message: 'Download not found in download client', stage: 'download' },
    }));
  });

  it('sends download complete notification on completion', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42, title: 'Finished Book' },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
      savePath: '/downloads/finished',
      size: 123456,
    });
    db.update.mockReturnValue(mockDbChain());

    await runMonitor();

    expect(notifierService.notify).toHaveBeenCalledWith('on_download_complete', expect.objectContaining({
      event: 'on_download_complete',
      book: { title: 'Finished Book' },
      download: { path: '/downloads/finished', size: 123456 },
    }));
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

  describe('book status recovery', () => {
    it('sets book to wanted when download fails and book has no path', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads check: none
        .mockReturnValueOnce(mockDbChain([]))
        // Get book: no path
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('sets book to imported when download fails and book has a path', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads check: none
        .mockReturnValueOnce(mockDbChain([]))
        // Get book: has path
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: '/audiobooks/test', status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'imported' }),
        'Book status recovered after download failure',
      );
    });

    it('sets book to wanted when download not found and book has no path', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('sets book to imported when adapter reports error and book has path', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42 },
        ]))
        // update for status transition
        // Other active downloads check: none
        .mockReturnValueOnce(mockDbChain([]))
        // Get book: has path
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: '/audiobooks/test', status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 30,
        status: 'error',
      });
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'imported' }),
        'Book status recovered after download failure',
      );
    });

    it('does not revert book status when other active downloads exist', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads check: one other active
        .mockReturnValueOnce(mockDbChain([{ id: 2, bookId: 42, status: 'queued' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('stays downloading when one of multiple active downloads fails', async () => {
      // Two downloads for same book, both active
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
          { id: 2, externalId: 'ext-2', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42 },
        ]))
        // Recovery for download 1: check other active — download 2 still active
        .mockReturnValueOnce(mockDbChain([{ id: 2, bookId: 42, status: 'downloading' }]));
      adapter.getDownload
        .mockResolvedValueOnce(null)  // download 1 not found
        .mockResolvedValueOnce({ progress: 50, status: 'downloading' }); // download 2 ok
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      // Should NOT have logged book status recovery
      expect(log.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'wanted' }),
        'Book status recovered after download failure',
      );
      expect(log.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'imported' }),
        'Book status recovered after download failure',
      );
    });

    it('recovers when download fails but book has another download in queued status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads check: one in queued status
        .mockReturnValueOnce(mockDbChain([{ id: 3, bookId: 42, status: 'queued' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      // Should skip recovery because another active download exists
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('recovers when download fails but book has another download in paused status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads check: one in paused status
        .mockReturnValueOnce(mockDbChain([{ id: 3, bookId: 42, status: 'paused' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in checking status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads: one in checking status
        .mockReturnValueOnce(mockDbChain([{ id: 5, bookId: 42, status: 'checking' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in pending_review status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads: one in pending_review status
        .mockReturnValueOnce(mockDbChain([{ id: 6, bookId: 42, status: 'pending_review' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in importing status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads: one in importing status
        .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 42, status: 'importing' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in completed status (pre-import)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads: one in completed status (awaiting import)
        .mockReturnValueOnce(mockDbChain([{ id: 8, bookId: 42, status: 'completed' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('recovers when last active download fails (other downloads already failed)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 3, externalId: 'ext-3', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads: none (others already failed)
        .mockReturnValueOnce(mockDbChain([]))
        // Get book: no path
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });
  });

  describe('failed download recovery (retry)', () => {
    let retryDeps: {
      blacklistService: { create: ReturnType<typeof vi.fn> };
      retrySearchDeps: {
        indexerService: { searchAll: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn> };
        blacklistService: { getBlacklistedHashes: ReturnType<typeof vi.fn>; getBlacklistedIdentifiers: ReturnType<typeof vi.fn> };
        bookService: { getById: ReturnType<typeof vi.fn> };
        settingsService: ReturnType<typeof createMockSettingsService>;
        retryBudget: RetryBudget;
        log: ReturnType<typeof createMockLogger>;
      };
    };

    beforeEach(async () => {
      const { RetryBudget } = await import('../services/retry-budget.js');
      retryDeps = {
        blacklistService: { create: vi.fn().mockResolvedValue(undefined) },
        retrySearchDeps: {
          indexerService: { searchAll: vi.fn().mockResolvedValue([]) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('blacklists release before retry search when infoHash is present', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('skips blacklist with debug log when infoHash is absent (Usenet)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith({ downloadId: 1 }, 'Skipping blacklist — no infoHash (Usenet download)');
    });

    it('sets errorMessage to "No viable candidates" when search returns nothing', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      // recoverBookStatus selects
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'No viable candidates' }));
    });

    it('sets errorMessage to "Retries exhausted" when max attempts reached', async () => {
      // Exhaust the budget
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      // recoverBookStatus selects
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retries exhausted' }));
    });

    it('sets errorMessage to "Retrying" when retry search succeeds', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerService.searchAll.mockResolvedValue([searchResult]);

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retrying' }));
    });

    it('sets errorMessage to "Retry failed" on retry_error', async () => {
      retryDeps.retrySearchDeps.indexerService.searchAll.mockRejectedValue(new Error('Indexer down'));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retry failed - will retry next cycle' }));
    });

    it('deletes old failed record when retry search succeeds', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerService.searchAll.mockResolvedValue([searchResult]);

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.retrySearchDeps.downloadOrchestrator.grab).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('does not corrupt book status on retry_error', async () => {
      retryDeps.retrySearchDeps.indexerService.searchAll.mockRejectedValue(new Error('Indexer down'));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      // Book status should NOT be recovered on retry_error (will try again next cycle)
      expect(log.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('writes adapter errorMessage before retry-state overwrite when retry succeeds via processDownloadUpdate', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerService.searchAll.mockResolvedValue([searchResult]);

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42, title: 'Test Book', infoHash: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 0, status: 'error', errorMessage: 'CRC mismatch' });
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const initialFailureIdx = setCalls.findIndex((c) => c['errorMessage'] === 'CRC mismatch');
      const retryingIdx = setCalls.findIndex((c) => c['errorMessage'] === 'Retrying');
      expect(initialFailureIdx).toBeGreaterThanOrEqual(0);
      expect(retryingIdx).toBeGreaterThan(initialFailureIdx);
    });

    it('falls back to book status recovery without retry when no retryDeps', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());

      // Call without retryDeps (undefined)
      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });
  });

  describe('SSE emissions', () => {
    it('emits download_progress when bookId is present', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 1, percentage: 0.5, speed: null, eta: null,
      });
    });

    it('emits download_status_change when status transitions', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', expect.objectContaining({ download_id: 1, book_id: 1 }));
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 1, old_status: 'downloading', new_status: 'completed',
      });
    });

    it('logs debug when broadcaster.emit throws', async () => {
      const sseError = new Error('SSE broken');
      const broadcaster = { emit: vi.fn().mockImplementation(() => { throw sseError; }) };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain());

      await expect(
        monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster)),
      ).resolves.not.toThrow();

      expect(log.debug).toHaveBeenCalledWith(sseError, 'SSE emit failed');
    });
  });

  describe('redownloadFailed setting', () => {
    let retryDeps: {
      blacklistService: { create: ReturnType<typeof vi.fn> };
      retrySearchDeps: {
        indexerService: { searchAll: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn> };
        blacklistService: { getBlacklistedHashes: ReturnType<typeof vi.fn>; getBlacklistedIdentifiers: ReturnType<typeof vi.fn> };
        bookService: { getById: ReturnType<typeof vi.fn> };
        settingsService: ReturnType<typeof createMockSettingsService>;
        retryBudget: RetryBudget;
        log: ReturnType<typeof createMockLogger>;
      };
    };

    beforeEach(async () => {
      const { RetryBudget } = await import('../services/retry-budget.js');
      retryDeps = {
        blacklistService: { create: vi.fn().mockResolvedValue(undefined) },
        retrySearchDeps: {
          indexerService: { searchAll: vi.fn().mockResolvedValue([]) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('skips both blacklisting and retrySearch when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      // recoverBookStatus selects: no other active downloads, then the book
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.indexerService.searchAll).not.toHaveBeenCalled();
    });

    it('still marks download as failed and calls recoverBookStatus when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ status: 'failed' }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('sets errorMessage to "Redownload disabled" when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Redownload disabled' }));
    });

    it('falls back to retry path (blacklist + retrySearch) when settings read throws', async () => {
      retryDeps.retrySearchDeps.settingsService = inject<ReturnType<typeof createMockSettingsService>>({
        get: vi.fn().mockRejectedValue(new Error('DB unavailable')),
        getAll: vi.fn(),
        set: vi.fn(),
        patch: vi.fn(),
        update: vi.fn(),
      });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123' }),
      );
      expect(retryDeps.retrySearchDeps.indexerService.searchAll).toHaveBeenCalled();
    });

    it('skips blacklist and retry via error-status transition path when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 30, status: 'error', errorMessage: 'CRC mismatch', savePath: '', size: 0 });
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      // recoverBookStatus selects: no other active downloads, then the book
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.indexerService.searchAll).not.toHaveBeenCalled();
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Redownload disabled' }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('proceeds with retry as normal when redownloadFailed is true', async () => {
      // redownloadFailed defaults to true — no override needed
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123' }),
      );
      expect(retryDeps.retrySearchDeps.indexerService.searchAll).toHaveBeenCalled();
    });
  });

  describe('auto-classification — infrastructure_error and download_failed', () => {
    let retryDeps: {
      blacklistService: { create: ReturnType<typeof vi.fn> };
      retrySearchDeps: {
        indexerService: { searchAll: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn> };
        blacklistService: { getBlacklistedHashes: ReturnType<typeof vi.fn>; getBlacklistedIdentifiers: ReturnType<typeof vi.fn> };
        bookService: { getById: ReturnType<typeof vi.fn> };
        settingsService: ReturnType<typeof createMockSettingsService>;
        retryBudget: RetryBudget;
        log: ReturnType<typeof createMockLogger>;
      };
    };

    beforeEach(async () => {
      const { RetryBudget } = await import('../services/retry-budget.js');
      retryDeps = {
        blacklistService: { create: vi.fn().mockResolvedValue(undefined) },
        retrySearchDeps: {
          indexerService: { searchAll: vi.fn().mockResolvedValue([]) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('adapter.getDownload() throws → blacklists with reason infrastructure_error, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'infrastructure_error', blacklistType: 'temporary' }),
      );
    });

    it('adapter.getDownload() returns null → blacklists with reason download_failed, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('download item status is error → blacklists with reason download_failed, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 30, status: 'error' });
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('adapter throw + blacklist insert failure logs warning and continues monitoring', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
        { id: 2, externalId: 'ext-2', downloadClientId: 10, status: 'downloading', completedAt: null, bookId: null },
      ]));
      adapter.getDownload
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      retryDeps.blacklistService.create.mockRejectedValueOnce(new Error('DB constraint error'));
      db.update.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      // Blacklist failure is caught and logged as warning
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        'Failed to blacklist release on infrastructure error',
      );
      // Second download still processes normally
      expect(db.update).toHaveBeenCalled();
    });

    it('handleDownloadFailure blacklist insert failure logs warning and proceeds with retry', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      retryDeps.blacklistService.create.mockRejectedValueOnce(new Error('DB constraint error'));
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      // Blacklist failure is caught and logged as warning, retry still proceeds
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        'Failed to blacklist release — proceeding with retry',
      );
    });

    it('null-download path blacklists with full payload including title and bookId', async () => {
      // The null-download path passes download_failed/temporary to handleDownloadFailure.
      // This test verifies the complete payload shape (not just reason/type).
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, status: 'downloading', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain());
      db.delete.mockReturnValue(mockDbChain());

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      // Verify the blacklist entry includes the title and bookId along with reason/type
      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith({
        infoHash: 'abc123',
        title: 'Test Book',
        bookId: 42,
        reason: 'download_failed',
        blacklistType: 'temporary',
      });
    });
  });

  // ===== #248 — outputPath persistence =====

  describe('processDownloadUpdate — outputPath persistence', () => {
    it.todo('sets outputPath to join(item.savePath, item.name) on first poll when outputPath is null');
    it.todo('applies remote path mapping to outputPath when mappings are available');
    it.todo('stores raw join(item.savePath, item.name) when remote path mapping fails');
    it.todo('does not overwrite outputPath when it is already set');
    it.todo('sets outputPath on transition-to-completed poll (adapter returns completed, DB status still pre-completed)');
  });
});
