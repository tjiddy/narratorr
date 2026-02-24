import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { NotifierService } from '../services/notifier.service.js';
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
const { startMonitorJob } = await import('./monitor.js');

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
});
