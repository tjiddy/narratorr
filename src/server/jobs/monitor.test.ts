import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService, searchStatus, mockSearchAllWithStatus } from '../__tests__/helpers.js';
import { downloads } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { NotifierService } from '../services/notifier.service.js';
import type { RetryBudget } from '../services/retry-budget.js';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { monitorDownloads } from './monitor.js';

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
  });

  async function runMonitor() {
    await monitorDownloads(
      inject<Db>(db),
      inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService),
      inject<FastifyBaseLogger>(log),
    );
  }

  it('does nothing when no active downloads', async () => {
    db.select.mockReturnValueOnce(mockDbChain([]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips downloads without externalId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: null, downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle' },
    ]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('skips downloads without downloadClientId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: null, clientStatus: 'downloading', pipelineStage: 'idle' },
    ]));

    await runMonitor();

    expect(downloadClientService.getAdapter).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('marks download as failed when not found in client', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(adapter.getDownload).toHaveBeenCalledWith('ext-1');
    expect(db.update).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
  });

  // Pin id + the polled state tuple; an id-only guard would permit stale resurrection.
  describe('guarded transitions (#1857 F2/F14)', () => {
    it('main branch: guard miss suppresses completion side effects AND writes the exact guarded predicate', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 7, progress: 0.5 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed', savePath: '/dl', name: 'book', size: 1 });
      const chain = mockDbChain([]);
      db.update.mockReturnValue(chain);

      await runMonitor();

      expect((chain.where as Mock)).toHaveBeenCalledWith(
        and(eq(downloads.id, 1), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')),
      );
      expect(notifierService.notify).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith({ id: 1 }, 'Monitor update skipped — row changed since poll (guarded)');
    });

    it('main branch: an unchanged row (guard MATCHES) still lands and fires completion (proves the write is not dead)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 7, progress: 0.5 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed', savePath: '/dl', name: 'book', size: 1 });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(notifierService.notify).toHaveBeenCalled();
    });

    it('missing-item branch: guard miss returns before any failure/notify side effect AND writes the exact guarded predicate', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 7, title: 'Replaced Book' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([]);
      db.update.mockReturnValue(chain);

      await runMonitor();

      expect((chain.where as Mock)).toHaveBeenCalledWith(
        and(eq(downloads.id, 1), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')),
      );
      expect(notifierService.notify).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith({ id: 1 }, 'Missing-item handling skipped — row changed since poll (guarded)');
    });
  });

  it('updates progress and status from adapter', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 50,
      status: 'downloading',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(db.update).toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith({ id: 1, progress: 0.5 }, 'Download progress');
  });

  it('includes progressUpdatedAt in update payload when progress changes', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', progress: 0.3, completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    expect(setCalls).toContainEqual(expect.objectContaining({ progressUpdatedAt: expect.any(Date) }));
  });

  it('omits progressUpdatedAt from update payload when progress is unchanged', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', progress: 0.5, completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const progressUpdate = setCalls.find((c) => 'progress' in c);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate).not.toHaveProperty('progressUpdatedAt');
  });

  it('logs state transitions at info level', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('updates download status to completed when download completes with bookId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('does not update book when download completes without bookId', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('handles adapter errors gracefully per download', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle' },
      { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ progress: 25, status: 'downloading' });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'Error monitoring download',
    );
    expect(db.update).toHaveBeenCalled();
  });

  it('skips when adapter is null', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle' },
    ]));
    downloadClientService.getAdapter.mockResolvedValueOnce(null);

    await runMonitor();

    expect(adapter.getDownload).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('maps seeding status to completed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 80,
      status: 'seeding',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('maps error status to failed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 30,
      status: 'error',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'failed' }, 'Download state changed');
  });

  it('routes error + progress 100% to failure path — newStatus is failed not completed', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error' });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'failed' }, 'Download state changed');
  });

  it('does not set completedAt when status is error and progress is 100', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error' });
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();

    const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const progressUpdate = setCalls.find((c) => 'progress' in c);
    expect(progressUpdate).toBeDefined();
    expect(progressUpdate!.completedAt).toBeNull();
  });

  it('does not fire on_download_complete notification when status is error and progress is 100', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'Test Book' },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error', savePath: '/downloads/test', size: 1000 });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(notifierService.notify).not.toHaveBeenCalledWith('on_download_complete', expect.anything());
  });

  it('writes DownloadItemInfo.errorMessage to downloads.errorMessage on initial failure detection', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({ progress: 0, status: 'error', errorMessage: 'CRC mismatch in article 42' });
    const chain = mockDbChain([{ id: 1 }]);
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
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: existingCompletedAt, bookId: 42 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'completed' }, 'Download state changed');
  });

  it('handles download item with zero progress', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'queued', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 0,
      status: 'downloading',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(db.update).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith({ id: 1, status: 'downloading' }, 'Download state changed');
  });

  it('continues processing remaining downloads when one throws an error', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
      { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
      { id: 3, externalId: 'ext-3', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload
      .mockResolvedValueOnce({ progress: 50, status: 'downloading' })
      .mockRejectedValueOnce(new Error('Timeout'))
      .mockResolvedValueOnce({ progress: 75, status: 'downloading' });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(adapter.getDownload).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      'Error monitoring download',
    );
    expect(db.update).toHaveBeenCalledTimes(2);
  });

  it('sends failure notification when download not found in client', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', title: 'My Audiobook' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(notifierService.notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({
      event: 'on_failure',
      book: { title: 'My Audiobook' },
      error: { message: 'Download not found in download client', stage: 'download' },
    }));
  });

  it('sends download complete notification on completion', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'Finished Book' },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 100,
      status: 'completed',
      savePath: '/downloads/finished',
      size: 123456,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(notifierService.notify).toHaveBeenCalledWith('on_download_complete', expect.objectContaining({
      event: 'on_download_complete',
      book: { title: 'Finished Book' },
      download: { path: '/downloads/finished', size: 123456 },
    }));
  });

  it('maps paused status to paused', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'paused', pipelineStage: 'idle', completedAt: null, bookId: null },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 60,
      status: 'paused',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.debug).toHaveBeenCalledWith({ id: 1, progress: 0.6 }, 'Download progress');
  });

  describe('book status recovery', () => {
    it('restores the pre-grab snapshot (wanted) when a download with that snapshot fails', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        // Other active downloads, book, then the failed download's pre-grab snapshot.
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: '/audiobooks/test', status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'wanted' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('preserves a failed snapshot on revert — path presence no longer forces imported', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: '/audiobooks/test', status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'failed' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'failed' }),
        'Book status recovered after download failure',
      );
    });

    it('falls back to the conservative imported status when the snapshot is null (legacy rows)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: null }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'imported' }),
        'Book status recovered after download failure',
      );
    });

    it('restores the snapshot (missing) when the adapter reports an error', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: '/audiobooks/test', status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'missing' }]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 30,
        status: 'error',
      });
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

      await runMonitor();

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'missing' }),
        'Book status recovered after download failure',
      );
    });

    it('does not revert book status when other active downloads exist', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 2, bookId: 42, status: 'queued' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('stays downloading when one of multiple active downloads fails', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
          { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 2, bookId: 42, status: 'downloading' }]));
      adapter.getDownload
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

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
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 3, bookId: 42, status: 'queued' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('recovers when download fails but book has another download in paused status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 3, bookId: 42, status: 'paused' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in checking status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 5, bookId: 42, status: 'checking' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in pending_review status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 6, bookId: 42, status: 'pending_review' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in importing status', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 7, bookId: 42, status: 'importing' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('skips recovery when another download is in completed status (pre-import)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([{ id: 8, bookId: 42, status: 'completed' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitor();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, otherActiveCount: 1 }),
        'Skipping book status recovery — other active downloads exist',
      );
    });

    it('recovers when last active download fails (other downloads already failed)', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([
          { id: 3, externalId: 'ext-3', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'wanted' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

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
        indexerSearchService: { searchAllWithStatus: ReturnType<typeof vi.fn> };
        indexerService: { getLanAllowlist: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn>; grabForRetry: ReturnType<typeof vi.fn>; hasGrabBlocker: ReturnType<typeof vi.fn> };
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
          indexerSearchService: { searchAllWithStatus: mockSearchAllWithStatus([]) },
          indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }), grabForRetry: vi.fn().mockResolvedValue({ id: 99 }), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, path: null, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('blacklists release before retry search when infoHash is present', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    // already_active covers live, QG-completed, and pending-import blockers.
    it('already_active: does not delete the failed row or add a competing download', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      retryDeps.retrySearchDeps.downloadOrchestrator.hasGrabBlocker.mockResolvedValue(true);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(db.delete).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42 }),
        'Retry skipped — book already has a blocking download or import',
      );
    });

    it('blacklists by guid when infoHash is absent (Usenet)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: null, guid: 'https://indexer.com/details/abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ guid: 'https://indexer.com/details/abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('skips blacklist with warning when both infoHash and guid are absent', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: null, guid: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith({ downloadId: 1 }, 'Skipping blacklist — no infoHash or guid');
    });

    it('sets errorMessage to "No viable candidates" when search returns nothing', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);
      // recoverBookStatus: blockers, then book.
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'No viable candidates' }));
    });

    it('sets errorMessage to "Retries exhausted" when max attempts reached', async () => {
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);
      retryDeps.retrySearchDeps.retryBudget.consumeAttempt(42);

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);
      // recoverBookStatus: blockers, then book.
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retries exhausted' }));
    });

    it('sets errorMessage to "Retrying" when retry search succeeds', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([searchResult]));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retrying' }));
    });

    it('sets errorMessage to "Retry failed" on retry_error', async () => {
      retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus.mockRejectedValue(new Error('Indexer down'));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Retry failed - will retry next cycle' }));
    });

    it('deletes old failed record when retry search succeeds', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([searchResult]));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.retrySearchDeps.downloadOrchestrator.grabForRetry).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('does not corrupt book status on retry_error', async () => {
      retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus.mockRejectedValue(new Error('Indexer down'));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(log.info).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('writes adapter errorMessage before retry-state overwrite when retry succeeds via processDownloadUpdate', async () => {
      const searchResult = { title: 'New Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new123', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
      retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([searchResult]));

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'Test Book', infoHash: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 0, status: 'error', errorMessage: 'CRC mismatch' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

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
          { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
        ]))
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'wanted' }]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 42 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    // Use real retrySearch; path != null must short-circuit before consuming budget.
    it('failure handler inherits retrySearch imported-book guard — no grab, budget unchanged', async () => {
      retryDeps.retrySearchDeps.bookService.getById.mockResolvedValue({
        id: 42, title: 'Imported Book', duration: 3600,
        path: '/library/imported-book',
        author: { name: 'Author' },
      });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Imported Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      const budgetBefore = retryDeps.retrySearchDeps.retryBudget.hasRemaining(42);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.retrySearchDeps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.retryBudget.hasRemaining(42)).toBe(budgetBefore);
    });
  });

  describe('SSE emissions', () => {
    it('emits download_progress when bookId is present', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 1, percentage: 0.5, speed: null, eta: null,
      });
    });

    it('forwards adapter downloadSpeed into the SSE payload', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', downloadSpeed: 2_000_000 });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 1, percentage: 0.5, speed: 2_000_000, eta: null,
      });
    });

    it('preserves downloadSpeed=0 (stalled) rather than coercing to null', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', downloadSpeed: 0 });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 1, percentage: 0.5, speed: 0, eta: null,
      });
    });

    it('emits speed: null when adapter does not report downloadSpeed (undefined)', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 1, percentage: 0.5, speed: null, eta: null,
      });
    });

    it('emits download_status_change when status transitions', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

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
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await expect(
        monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster)),
      ).resolves.not.toThrow();

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: sseError.message, type: 'Error' }) }),
        'SSE emit failed for download_progress',
      );
    });

    it('still emits download_status_change when download_progress throws', async () => {
      const sseError = new Error('progress broken');
      const broadcaster = {
        emit: vi.fn()
          .mockImplementationOnce(() => { throw sseError; }) // download_progress throws
          .mockImplementationOnce(() => {}), // status emit
      };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 1 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).toHaveBeenCalledTimes(2);
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', expect.objectContaining({
        download_id: 1, old_status: 'downloading', new_status: 'completed',
      }));
    });
  });

  describe('redownloadFailed setting', () => {
    let retryDeps: {
      blacklistService: { create: ReturnType<typeof vi.fn> };
      retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: ReturnType<typeof vi.fn> };
        indexerService: { getLanAllowlist: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn>; grabForRetry: ReturnType<typeof vi.fn>; hasGrabBlocker: ReturnType<typeof vi.fn> };
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
          indexerSearchService: { searchAllWithStatus: mockSearchAllWithStatus([]) },
          indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }), grabForRetry: vi.fn().mockResolvedValue({ id: 99 }), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, path: null, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('skips both blacklisting and retrySearch when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      // recoverBookStatus: blockers, then book.
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
    });

    it('still marks download as failed and calls recoverBookStatus when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'wanted' }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ clientStatus: 'failed' }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('sets errorMessage to "Redownload disabled" when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      const chain = mockDbChain([{ id: 1 }]);
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
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123' }),
      );
      expect(retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus).toHaveBeenCalled();
    });

    it('skips blacklist and retry via error-status transition path when redownloadFailed is false', async () => {
      retryDeps.retrySearchDeps.settingsService = createMockSettingsService({ import: { redownloadFailed: false } });

      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 30, status: 'error', errorMessage: 'CRC mismatch', savePath: '', size: 0 });
      const chain = mockDbChain([{ id: 42 }]);
      db.update.mockReturnValue(chain);
      // recoverBookStatus: blockers, book, then snapshot.
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([createMockDbBook({ id: 42, path: null, status: 'downloading' })]))
        .mockReturnValueOnce(mockDbChain([{ bookStatusAtGrab: 'wanted' }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
      expect(retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ errorMessage: 'Redownload disabled' }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 42, status: 'wanted' }),
        'Book status recovered after download failure',
      );
    });

    it('proceeds with retry as normal when redownloadFailed is true', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123' }),
      );
      expect(retryDeps.retrySearchDeps.indexerSearchService.searchAllWithStatus).toHaveBeenCalled();
    });
  });

  describe('auto-classification — infrastructure_error and download_failed', () => {
    let retryDeps: {
      blacklistService: { create: ReturnType<typeof vi.fn> };
      retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: ReturnType<typeof vi.fn> };
        indexerService: { getLanAllowlist: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn>; grabForRetry: ReturnType<typeof vi.fn>; hasGrabBlocker: ReturnType<typeof vi.fn> };
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
          indexerSearchService: { searchAllWithStatus: mockSearchAllWithStatus([]) },
          indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }) },
          downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }), grabForRetry: vi.fn().mockResolvedValue({ id: 99 }), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Test Book', duration: 3600, path: null, author: { name: 'Author' } }) },
          settingsService: createMockSettingsService(),
          retryBudget: new RetryBudget(),
          log: createMockLogger(),
        },
      };
    });

    it('adapter.getDownload() throws → blacklists with reason infrastructure_error, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'infrastructure_error', blacklistType: 'temporary' }),
      );
    });

    /**
     * #2420 — this creator wrote infoHash and no guid, which is invisible while every adapter
     * carries a hash at search time. ABB's results no longer do, so the whole blacklist load moves
     * to the guid arm: without the guid the entry can never match an ABB result again.
     */
    it('carries the download row\'s guid onto the infrastructure_error entry', async () => {
      const guid = 'abb:/audio-books/murder-in-the-new-forest/';
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123', guid },
      ]));
      adapter.getDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', guid, reason: 'infrastructure_error' }),
      );
    });

    // The fix must not make guid required: a Usenet or pre-#2420 row carries only a hash.
    it('still blacklists on infoHash alone when the download row has a null guid', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123', guid: null },
      ]));
      adapter.getDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      const created = retryDeps.blacklistService.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.infoHash).toBe('abc123');
      expect(created.guid).toBeUndefined();
    });

    // Guid-only rows (Usenet, post-#2420 ABB) must not skip the infra-error blacklist: the gate
    // matches blacklistRelease's either-identity rule, not infoHash-only.
    it('blacklists a guid-only row (no infoHash) on infrastructure_error', async () => {
      const guid = 'https://audiobookbay.test/audio-books/murder-in-the-new-forest/';
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: null, guid },
      ]));
      adapter.getDownload.mockRejectedValueOnce(new Error('Connection refused'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ guid, reason: 'infrastructure_error', blacklistType: 'temporary' }),
      );
      const created = retryDeps.blacklistService.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.infoHash).toBeUndefined();
    });

    it('adapter.getDownload() returns null → blacklists with reason download_failed, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('download item status is error → blacklists with reason download_failed, type temporary', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 30, status: 'error' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
      );
    });

    it('adapter throw + blacklist insert failure logs warning and continues monitoring', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
        { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
      ]));
      adapter.getDownload
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      retryDeps.blacklistService.create.mockRejectedValueOnce(new Error('DB constraint error'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        'Failed to blacklist release on infrastructure error',
      );
      expect(db.update).toHaveBeenCalled();
    });

    it('handleDownloadFailure blacklist insert failure logs warning and proceeds with retry', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      retryDeps.blacklistService.create.mockRejectedValueOnce(new Error('DB constraint error'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1 }),
        'Failed to blacklist release — proceeding with retry',
      );
    });

    it('null-download path blacklists with full payload including title and bookId', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Test Book', infoHash: 'abc123' },
      ]));
      adapter.getDownload.mockResolvedValueOnce(null);
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.delete.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), retryDeps as never);

      expect(retryDeps.blacklistService.create).toHaveBeenCalledWith({
        infoHash: 'abc123',
        title: 'Test Book',
        bookId: 42,
        reason: 'download_failed',
        blacklistType: 'temporary',
      });
    });
  });

  describe('processDownloadUpdate — outputPath persistence', () => {
    // path.join uses platform separators.
    const normPath = (s: string) => s.split('\\').join('/');

    it('sets outputPath to join(item.savePath, item.name) on first poll when outputPath is null', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', savePath: '/downloads', name: 'my-book', size: 1000 });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const outputPaths = setCalls.filter((c) => 'outputPath' in c).map((c) => normPath(c.outputPath as string));
      expect(outputPaths).toContain('/downloads/my-book');
    });

    it('applies remote path mapping to outputPath when mappings are available', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', savePath: '/remote/downloads', name: 'my-book', size: 1000 });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockResolvedValue([{ remotePath: '/remote/downloads', localPath: '/local/downloads' }]),
      };

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, remotePathMappingService as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ outputPath: '/local/downloads/my-book' }));
    });

    it('skips outputPath persistence when remote path mapping lookup fails (#263 trust model)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', savePath: '/downloads', name: 'my-book', size: 1000 });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      };

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, remotePathMappingService as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const progressUpdate = setCalls.find((c) => 'progress' in c);
      expect(progressUpdate).toBeDefined();
      expect(progressUpdate).not.toHaveProperty('outputPath');
    });

    it('does not overwrite outputPath when it is already set', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: '/already/set' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading', savePath: '/downloads', name: 'my-book', size: 1000 });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const progressUpdate = setCalls.find((c) => 'progress' in c);
      expect(progressUpdate).toBeDefined();
      expect(progressUpdate).not.toHaveProperty('outputPath');
    });

    it('sets outputPath on transition-to-completed poll (adapter returns completed, DB status still pre-completed)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed', savePath: '/downloads', name: 'my-book', size: 1000 });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log));

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const outputPaths = setCalls.filter((c) => 'outputPath' in c).map((c) => normPath(c.outputPath as string));
      expect(outputPaths).toContain('/downloads/my-book');
    });
  });

  describe('resolveOutputPath trust model', () => {
    // path.join uses platform separators.
    const normPath = (s: string) => s.split('\\').join('/');
    const baseDownload = { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, outputPath: null, pendingCleanup: null };
    const baseItem = { progress: 50, status: 'downloading', savePath: '/remote/downloads', name: 'my-book', size: 1000 };

    it('returns mapped path when getByClientId returns mappings', async () => {
      db.select.mockReturnValueOnce(mockDbChain([baseDownload]));
      adapter.getDownload.mockResolvedValueOnce(baseItem);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockResolvedValue([{ remotePath: '/remote/downloads', localPath: '/local/downloads' }]),
      };

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, remotePathMappingService as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ outputPath: '/local/downloads/my-book' }));
    });

    it('returns undefined when getByClientId throws (lookup failure)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([baseDownload]));
      adapter.getDownload.mockResolvedValueOnce(baseItem);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      };

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, remotePathMappingService as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const progressUpdate = setCalls.find((c) => 'progress' in c);
      expect(progressUpdate).toBeDefined();
      expect(progressUpdate).not.toHaveProperty('outputPath');
    });

    it('returns raw joined path when getByClientId returns empty array', async () => {
      db.select.mockReturnValueOnce(mockDbChain([baseDownload]));
      adapter.getDownload.mockResolvedValueOnce(baseItem);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockResolvedValue([]),
      };

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, remotePathMappingService as never);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const outputPaths = setCalls.filter((c) => 'outputPath' in c).map((c) => normPath(c.outputPath as string));
      expect(outputPaths).toContain('/remote/downloads/my-book');
    });

    it('returns raw path when remotePathMappingService is undefined', async () => {
      db.select.mockReturnValueOnce(mockDbChain([baseDownload]));
      adapter.getDownload.mockResolvedValueOnce(baseItem);
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, undefined, undefined);

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      const outputPaths = setCalls.filter((c) => 'outputPath' in c).map((c) => normPath(c.outputPath as string));
      expect(outputPaths).toContain('/remote/downloads/my-book');
    });
  });

  describe('#324/#358 — book status on download completion (delegated to processOneDownload)', () => {
    it('monitor no longer promotes book status directly — only 1 DB update on completion', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 5 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      // Poller owns clientStatus; processOneDownload owns pipelineStage.
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).not.toContainEqual(expect.objectContaining({ pipelineStage: 'importing' }));
    });

    it('monitor no longer emits book_status_change SSE directly', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 5 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).not.toHaveBeenCalledWith('book_status_change', expect.anything());
    });

    it('when download has no bookId, no book status change emitted', async () => {
      const broadcaster = { emit: vi.fn() };
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await monitorDownloads(inject<Db>(db), inject<DownloadClientService>(downloadClientService), inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log), undefined, inject<EventBroadcasterService>(broadcaster));

      expect(broadcaster.emit).not.toHaveBeenCalledWith('book_status_change', expect.anything());
    });
  });

  describe('inline import on completion (#358)', () => {
    let qualityGateOrchestrator: { processOneDownload: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      qualityGateOrchestrator = { processOneDownload: vi.fn().mockResolvedValue(undefined) };
    });

    async function runMonitorWithQG() {
      await monitorDownloads(
        inject<Db>(db),
        inject<DownloadClientService>(downloadClientService),
        inject<NotifierService>(notifierService),
        inject<FastifyBaseLogger>(log),
        undefined, // retryDeps
        undefined, // broadcaster
        undefined, // remotePathMappingService
        inject(qualityGateOrchestrator),
      );
    }

    it('calls processOneDownload via fireAndForget when download completes', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'The Stranger [2026]' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).toHaveBeenCalledWith(1, expect.anything());
    });

    // The polled snapshot is the only provenance left if the row vanishes before the gate re-reads it (#2307).
    it('hands the polled book id and release title to the quality gate', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, title: 'The Stranger [2026]' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).toHaveBeenCalledWith(1, { bookId: 42, releaseTitle: 'The Stranger [2026]' });
    });

    it('forwards a null book id rather than dropping the provenance argument', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: null, title: 'Orphan Release' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).toHaveBeenCalledWith(1, { bookId: null, releaseTitle: 'Orphan Release' });
    });

    it('does not call processOneDownload when progress < 1', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).not.toHaveBeenCalled();
    });

    it('does not call processOneDownload when download is error', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'error', errorMessage: 'disk full' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).not.toHaveBeenCalled();
    });

    it('does not call processOneDownload when download already completed', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'completed', pipelineStage: 'idle', completedAt: new Date(), bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).not.toHaveBeenCalled();
    });

    it('continues processing other downloads when processOneDownload throws', async () => {
      qualityGateOrchestrator.processOneDownload.mockRejectedValue(new Error('QG exploded'));
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
        { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 43 },
      ]));
      adapter.getDownload
        .mockResolvedValueOnce({ progress: 100, status: 'completed' })
        .mockResolvedValueOnce({ progress: 50, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(db.update).toHaveBeenCalledTimes(2);
    });

    it('does not write book status directly on completion (handleBookStatusOnCompletion removed)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      expect(db.update).toHaveBeenCalledTimes(1);
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls.every((c) => c.status !== 'importing')).toBe(true);
    });
  });

  describe('adapter status authority — completion detection', () => {
    let qualityGateOrchestrator: { processOneDownload: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      qualityGateOrchestrator = { processOneDownload: vi.fn().mockResolvedValue(undefined) };
    });

    async function runMonitorWithQG() {
      await monitorDownloads(
        inject<Db>(db),
        inject<DownloadClientService>(downloadClientService),
        inject<NotifierService>(notifierService),
        inject<FastifyBaseLogger>(log),
        undefined, // retryDeps
        undefined, // broadcaster
        undefined, // remotePathMappingService
        inject(qualityGateOrchestrator),
      );
    }

    it('does NOT transition to completed when adapter returns downloading + progress 100%', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'downloading' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.clientStatus).toBe('downloading');
    });

    it('transitions to completed when adapter returns completed + progress 100%', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.clientStatus).toBe('completed');
    });

    it('transitions to completed when adapter returns seeding + progress 100%', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'seeding' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.clientStatus).toBe('completed');
    });

    it('transitions to completed when adapter returns completed + progress 99% (adapter is sole authority)', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 99, status: 'completed' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.clientStatus).toBe('completed');
    });

    it('does NOT transition to completed when adapter returns paused + progress 100%', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'paused' });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitorWithQG();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.clientStatus).toBe('paused');
    });

    it('does NOT fire quality gate when adapter returns downloading + progress 100%', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'downloading' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).not.toHaveBeenCalled();
    });

    it('fires quality gate when adapter returns completed status', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({ progress: 100, status: 'completed' });
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

      await runMonitorWithQG();

      expect(qualityGateOrchestrator.processOneDownload).toHaveBeenCalledWith(1, expect.anything());
    });
  });

  describe('outputPath re-resolution on completion', () => {
    it('re-resolves outputPath on completion transition even if previously set', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, outputPath: '/old/stale/path' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 100,
        status: 'completed',
        savePath: '/downloads/complete',
        name: 'My Audiobook',
      });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitor();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(String(setCalls[0]?.outputPath).split('\\').join('/')).toBe('/downloads/complete/My Audiobook');
    });

    it('resolves outputPath normally when no previous value exists', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42 },
      ]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 50,
        status: 'downloading',
        savePath: '/downloads/incomplete',
        name: 'My Audiobook',
      });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitor();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(String(setCalls[0]?.outputPath).split('\\').join('/')).toBe('/downloads/incomplete/My Audiobook');
    });

    it('preserves previous outputPath when remote path mapping lookup fails during completion transition', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, outputPath: '/old/stale/path' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 100,
        status: 'completed',
        savePath: '/downloads/complete',
        name: 'My Audiobook',
      });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      const remotePathMappingService = {
        getByClientId: vi.fn().mockRejectedValue(new Error('DB unavailable')),
      };

      await monitorDownloads(
        inject<Db>(db),
        inject<DownloadClientService>(downloadClientService),
        inject<NotifierService>(notifierService),
        inject<FastifyBaseLogger>(log),
        undefined,
        undefined,
        remotePathMappingService as never,
      );

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]).not.toHaveProperty('outputPath');
    });

    it('preserves previous outputPath when adapter returns empty savePath on completion', async () => {
      db.select.mockReturnValueOnce(mockDbChain([
        { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', completedAt: null, bookId: 42, outputPath: '/existing/path' },
      ]));
      adapter.getDownload.mockResolvedValueOnce({
        progress: 100,
        status: 'completed',
        savePath: '',
        name: 'My Audiobook',
      });
      const chain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(chain);

      await runMonitor();

      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls[0]?.outputPath).toBeUndefined();
    });
  });
});

describe('#537 monitor download_failed event recording', () => {
  let db: ReturnType<typeof createMockDb>;
  let downloadClientService: { getAdapter: ReturnType<typeof vi.fn> };
  let notifierService: { notify: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let adapter: { getDownload: ReturnType<typeof vi.fn> };
  let eventHistory: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    adapter = { getDownload: vi.fn() };
    downloadClientService = { getAdapter: vi.fn().mockResolvedValue(adapter) };
    notifierService = { notify: vi.fn().mockResolvedValue(undefined) };
    eventHistory = { create: vi.fn().mockResolvedValue(undefined) };
  });

  it('records download_failed event with correct fields when download is missing from client', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 1, externalId: 'ext-1', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 42, title: 'Missing Book' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await monitorDownloads(
      inject<Db>(db), inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log),
      undefined, undefined, undefined, undefined, inject<EventHistoryService>(eventHistory),
    );

    expect(eventHistory.create).toHaveBeenCalledWith({
      bookId: 42, bookTitle: 'Missing Book', downloadId: 1,
      eventType: 'download_failed', source: 'auto',
      reason: { error: 'Download not found in download client' },
    });
  });

  it('records download_failed event with adapter error message on failed-status transition', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 2, externalId: 'ext-2', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 7, title: 'Error Book', completedAt: null, progress: 0.5 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 50, status: 'error', savePath: '/tmp', name: 'file', size: 1000, errorMessage: 'Disk full',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await monitorDownloads(
      inject<Db>(db), inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log),
      undefined, undefined, undefined, undefined, inject<EventHistoryService>(eventHistory),
    );

    expect(eventHistory.create).toHaveBeenCalledWith({
      bookId: 7, bookTitle: 'Error Book', downloadId: 2,
      eventType: 'download_failed', source: 'auto',
      reason: { error: 'Disk full' },
    });
  });

  it('records download_failed event with fallback message when adapter errorMessage is absent', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 3, externalId: 'ext-3', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: 9, title: 'Fallback Book', completedAt: null, progress: 0.1 },
    ]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 10, status: 'error', savePath: '/tmp', name: 'file', size: 500,
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await monitorDownloads(
      inject<Db>(db), inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log),
      undefined, undefined, undefined, undefined, inject<EventHistoryService>(eventHistory),
    );

    expect(eventHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { error: 'Download failed' } }),
    );
  });

  it('skips event recording when bookId is null (orphan download)', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      { id: 4, externalId: 'ext-4', downloadClientId: 10, clientStatus: 'downloading', pipelineStage: 'idle', bookId: null, title: 'Orphan' },
    ]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await monitorDownloads(
      inject<Db>(db), inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log),
      undefined, undefined, undefined, undefined, inject<EventHistoryService>(eventHistory),
    );

    expect(eventHistory.create).not.toHaveBeenCalled();
  });
});

/**
 * #2423 Part B — a download the client has not registered yet is not a dead download. The observed
 * incident failed and blacklisted a hybrid torrent on the very first poll, 28s after the add.
 */
describe('#2423 missing-item grace window', () => {
  let db: ReturnType<typeof createMockDb>;
  let downloadClientService: { getAdapter: ReturnType<typeof vi.fn> };
  let notifierService: { notify: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;
  let adapter: { getDownload: ReturnType<typeof vi.fn> };
  let eventHistory: { create: ReturnType<typeof vi.fn> };
  let broadcaster: { emit: ReturnType<typeof vi.fn> };
  let retryDeps: {
    blacklistService: { create: ReturnType<typeof vi.fn> };
    retrySearchDeps: Record<string, unknown>;
  };

  const GRACE_MS = 120_000;
  const FROZEN_NOW = new Date('2026-08-17T23:09:30.000Z');
  const fresh = () => new Date(Date.now() - 5_000);
  const stale = () => new Date(Date.now() - 10 * 60_000);

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 1, externalId: 'ext-1', downloadClientId: 10,
      clientStatus: 'downloading', pipelineStage: 'idle',
      bookId: 42, title: 'Hybrid Book', infoHash: 'abc123', guid: null,
      completedAt: null, progress: 0.1, addedAt: fresh(),
      ...overrides,
    };
  }

  // Fixtures and monitorDownloads both read Date.now(), so the host clock would otherwise pick the
  // branch. Fake ONLY Date — full fake timers stall promise-driven job code and MSW-backed suites.
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
    const { RetryBudget } = await import('../services/retry-budget.js');
    db = createMockDb();
    log = createMockLogger();
    adapter = { getDownload: vi.fn() };
    downloadClientService = { getAdapter: vi.fn().mockResolvedValue(adapter) };
    notifierService = { notify: vi.fn().mockResolvedValue(undefined) };
    eventHistory = { create: vi.fn().mockResolvedValue(undefined) };
    broadcaster = { emit: vi.fn() };
    retryDeps = {
      blacklistService: { create: vi.fn().mockResolvedValue(undefined) },
      retrySearchDeps: {
        indexerSearchService: { searchAllWithStatus: mockSearchAllWithStatus([]) },
        indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }) },
        downloadOrchestrator: { grab: vi.fn().mockResolvedValue({ id: 99 }), grabForRetry: vi.fn().mockResolvedValue({ id: 99 }), hasGrabBlocker: vi.fn().mockResolvedValue(false) },
        blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
        bookService: { getById: vi.fn().mockResolvedValue({ id: 42, title: 'Hybrid Book', duration: 3600, path: null, author: { name: 'Author' } }) },
        settingsService: createMockSettingsService(),
        retryBudget: new RetryBudget(),
        log: createMockLogger(),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runMonitor() {
    await monitorDownloads(
      inject<Db>(db), inject<DownloadClientService>(downloadClientService),
      inject<NotifierService>(notifierService), inject<FastifyBaseLogger>(log),
      retryDeps as never, inject<EventBroadcasterService>(broadcaster),
      undefined, undefined, inject<EventHistoryService>(eventHistory),
    );
  }

  function expectNoFailureSideEffects() {
    expect(db.update).not.toHaveBeenCalled();
    expect(notifierService.notify).not.toHaveBeenCalled();
    expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
    expect((retryDeps.retrySearchDeps.indexerSearchService as { searchAllWithStatus: Mock }).searchAllWithStatus).not.toHaveBeenCalled();
    expect(eventHistory.create).not.toHaveBeenCalled();
    expect(broadcaster.emit).not.toHaveBeenCalled();
  }

  it('suppresses every failure side effect for a freshly-added missing download', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row()]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expectNoFailureSideEffects();
    expect(log.warn).not.toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'Download not yet in client — within add grace window',
    );
  });

  // The "a genuinely-vanished download still dies" arm.
  it('fails a missing download whose row is older than the window, exactly as before', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row({ addedAt: stale() })]));
    adapter.getDownload.mockResolvedValueOnce(null);
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();

    expect((chain.set as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ clientStatus: 'failed', errorMessage: 'Download not found in download client' }),
    );
    expect((chain.where as Mock)).toHaveBeenCalledWith(
      and(eq(downloads.id, 1), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')),
    );
    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      downloadId: 1, eventType: 'download_failed', reason: { error: 'Download not found in download client' },
    }));
    expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
      expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed', blacklistType: 'temporary' }),
    );
    expect(notifierService.notify).toHaveBeenCalledWith('on_failure', expect.objectContaining({
      event: 'on_failure', book: { title: 'Hybrid Book' },
    }));
  });

  // The ~40 legacy fixtures elsewhere in this suite carry no addedAt and must keep failing.
  it('fails a legacy row that carries no addedAt', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row({ addedAt: undefined })]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    expect(retryDeps.blacklistService.create).toHaveBeenCalled();
  });

  it('fails exactly at the window boundary', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row({ addedAt: new Date(Date.now() - GRACE_MS) })]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
  });

  // A reachable client reporting a real error is not an identity flap.
  it('does not suppress a returned item whose status is error', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row()]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 10, status: 'error', savePath: '/dl', name: 'book', size: 100, errorMessage: 'Disk full',
    });
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();

    expect(eventHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'download_failed', reason: { error: 'Disk full' },
    }));
    expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
      expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed' }),
    );
    expect(log.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      'Download not yet in client — within add grace window',
    );
  });

  it('does not suppress an adapter throw', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row()]));
    adapter.getDownload.mockRejectedValueOnce(new Error('qBittorrent unreachable'));

    await runMonitor();

    expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
      expect.objectContaining({ infoHash: 'abc123', reason: 'infrastructure_error', blacklistType: 'temporary' }),
    );
  });

  // A suppressed row must `continue`, not `return` out of the cycle.
  it('suppresses only the fresh row and still fails the stale one in the same cycle', async () => {
    db.select.mockReturnValueOnce(mockDbChain([
      row({ id: 1, addedAt: fresh() }),
      row({ id: 2, addedAt: stale(), title: 'Vanished Book', infoHash: 'def456', bookId: 43 }),
    ]));
    adapter.getDownload.mockResolvedValue(null);
    const chain = mockDbChain([{ id: 2 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();

    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1 }),
      'Download not yet in client — within add grace window',
    );
    expect(log.warn).toHaveBeenCalledWith({ id: 2 }, 'Download not found in client');
    expect(log.warn).not.toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    expect((chain.where as Mock)).toHaveBeenCalledWith(
      and(eq(downloads.id, 2), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')),
    );
    expect(retryDeps.blacklistService.create).toHaveBeenCalledTimes(1);
    expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(expect.objectContaining({ infoHash: 'def456' }));
  });

  // The SAME row polled twice, with only wall time moving — the frozen clock is what makes the
  // window's expiry (rather than a swapped fixture) the thing that flips the branch.
  it('suppresses the first poll then fails the row once the window has elapsed', async () => {
    const flapping = row();
    db.select.mockReturnValueOnce(mockDbChain([flapping]));
    adapter.getDownload.mockResolvedValueOnce(null);
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));

    await runMonitor();
    expectNoFailureSideEffects();

    vi.setSystemTime(new Date(FROZEN_NOW.getTime() + GRACE_MS));
    db.select.mockReturnValueOnce(mockDbChain([flapping]));
    adapter.getDownload.mockResolvedValueOnce(null);

    await runMonitor();

    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    expect(retryDeps.blacklistService.create).toHaveBeenCalledWith(
      expect.objectContaining({ infoHash: 'abc123', reason: 'download_failed' }),
    );
  });

  // The incident's happy ending: the hybrid resolves on a later poll and progresses normally.
  it('suppresses the flap then records progress once the client reports the download', async () => {
    db.select.mockReturnValueOnce(mockDbChain([row()]));
    adapter.getDownload.mockResolvedValueOnce(null);
    const chain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(chain);

    await runMonitor();
    expectNoFailureSideEffects();

    db.select.mockReturnValueOnce(mockDbChain([row()]));
    adapter.getDownload.mockResolvedValueOnce({
      progress: 25, status: 'downloading', savePath: '/dl', name: 'book', size: 100,
    });

    await runMonitor();

    expect((chain.set as Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ clientStatus: 'downloading', progress: 0.25 }),
    );
    const written = (chain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    expect(written.some((s) => s.clientStatus === 'failed')).toBe(false);
    expect(retryDeps.blacklistService.create).not.toHaveBeenCalled();
  });
});
