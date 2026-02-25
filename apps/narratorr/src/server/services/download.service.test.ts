import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import { type DownloadClientService } from './download-client.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

import { createMockDbBook } from '../__tests__/factories.js';

const now = new Date();
const mockBook = createMockDbBook();

const mockDownload = {
  id: 1,
  bookId: 1,
  indexerId: 1,
  downloadClientId: 1,
  title: 'The Way of Kings',
  protocol: 'torrent' as const,
  infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
  downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
  size: 1073741824,
  seeders: 42,
  status: 'downloading' as const,
  progress: 0,
  externalId: 'ext-123',
  errorMessage: null,
  addedAt: now,
  completedAt: null,
};

function createMockDownloadClientService(): DownloadClientService {
  return inject<DownloadClientService>({
    getAll: vi.fn(),
    getById: vi.fn(),
    getFirstEnabled: vi.fn(),
    getFirstEnabledForProtocol: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getAdapter: vi.fn(),
    getFirstEnabledAdapter: vi.fn(),
    test: vi.fn(),
  });
}

describe('DownloadService', () => {
  let db: ReturnType<typeof createMockDb>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let service: DownloadService;

  beforeEach(() => {
    db = createMockDb();
    clientService = createMockDownloadClientService();
    service = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('getAll', () => {
    it('returns downloads with books', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('The Way of Kings');
      expect(result[0].book?.title).toBe('The Way of Kings');
    });

    it('returns empty array when no downloads', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns download with book', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.title).toBe('The Way of Kings');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('getActive', () => {
    it('returns downloads with active statuses', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.getActive();
      expect(result).toHaveLength(1);
    });
  });

  describe('getCounts', () => {
    it('returns active and completed counts', async () => {
      db.select.mockReturnValue(
        mockDbChain([
          { isActive: 1, cnt: 3 },
          { isActive: 0, cnt: 5 },
        ]),
      );

      const result = await service.getCounts();
      expect(result).toEqual({ active: 3, completed: 5 });
    });

    it('returns zeros when no downloads', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getCounts();
      expect(result).toEqual({ active: 0, completed: 0 });
    });

    it('returns only active when no completed', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ isActive: 1, cnt: 2 }]),
      );

      const result = await service.getCounts();
      expect(result).toEqual({ active: 2, completed: 0 });
    });
  });

  describe('getActiveByBookId', () => {
    it('returns active downloads for a specific book', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, bookId: 1 }, book: mockBook }]),
      );

      const result = await service.getActiveByBookId(1);
      expect(result).toHaveLength(1);
      expect(result[0].bookId).toBe(1);
    });

    it('returns empty array when no active downloads for book', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getActiveByBookId(999);
      expect(result).toEqual([]);
    });
  });

  describe('grab', () => {
    it('adds download and creates download record', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };

      const enabledClient = { id: 1, name: 'qBit', enabled: true };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(enabledClient);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(mockAdapter.addDownload).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
      expect(result.title).toBe('The Way of Kings');
    });

    it('throws when no download client configured', async () => {
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(null);

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('No download client configured');
    });

    it('throws when adapter cannot be initialized', async () => {
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(null);

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('Could not initialize download client');
    });

    it('updates book status when bookId provided', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(db.update).toHaveBeenCalled();
    });

    it('allows duplicate downloads for the same bookId — BUG: see #240', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      // Both calls create separate download records
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const grabParams = {
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      };

      // BUG: see #240 — no unique constraint or dedup check prevents duplicate records
      // when auto-grab and manual grab race for the same book
      const [result1, result2] = await Promise.all([
        service.grab(grabParams),
        service.grab(grabParams),
      ]);

      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      // Two insert calls = two download records created
      expect(db.insert).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateProgress', () => {
    it('updates progress and keeps downloading status', async () => {
      db.update.mockReturnValue(mockDbChain());

      await service.updateProgress(1, 0.5);
      expect(db.update).toHaveBeenCalled();
    });

    it('auto-completes when progress >= 1', async () => {
      db.update.mockReturnValue(mockDbChain());

      await service.updateProgress(1, 1.0);
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('passes correct status value to set()', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateStatus(1, 'importing');

      expect(chain.set).toHaveBeenCalledWith({ status: 'importing' });
    });

    it('logs at info level', async () => {
      db.update.mockReturnValue(mockDbChain());
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.updateStatus(1, 'completed');

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, status: 'completed' }),
        expect.any(String),
      );
    });
  });

  describe('setError', () => {
    it('passes status failed and errorMessage to set()', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.setError(1, 'Connection refused');

      expect(chain.set).toHaveBeenCalledWith({ status: 'failed', errorMessage: 'Connection refused' });
    });

    it('logs at warn level', async () => {
      db.update.mockReturnValue(mockDbChain());
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.setError(1, 'Disk full');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, error: 'Disk full' }),
        expect.any(String),
      );
    });
  });

  describe('cancel', () => {
    it('removes torrent from client and updates status', async () => {
      const mockAdapter = {
        removeDownload: vi.fn().mockResolvedValue(undefined),
      };

      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      const result = await service.cancel(1);

      expect(result).toBe(true);
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(mockDownload.externalId, true);
      expect(db.update).toHaveBeenCalled();
    });

    it('returns false when download not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.cancel(999);
      expect(result).toBe(false);
    });

    it('still cancels when adapter removal fails', async () => {
      const mockAdapter = {
        removeDownload: vi.fn().mockRejectedValue(new Error('Connection failed')),
      };

      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      const result = await service.cancel(1);
      expect(result).toBe(true);
    });
  });

  describe('delete', () => {
    it('returns true when download exists', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.delete(999);
      expect(result).toBe(false);
    });
  });

  describe('grab edge cases', () => {
    it('proceeds when adapter.addDownload returns empty string', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(''),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
      });

      expect(result.title).toBe('The Way of Kings');
      expect(mockAdapter.addDownload).toHaveBeenCalled();
    });

    it('proceeds when adapter.addDownload returns null', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(null),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
      });

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test' }),
        expect.stringContaining('no external ID'),
      );
    });

    it('throws when DB insert fails after adapter succeeds', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-456'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockImplementation(() => { throw new Error('UNIQUE constraint failed'); });

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('UNIQUE constraint failed');
    });

    it('uses usenet protocol when specified', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('nzb-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 2, name: 'SABnzbd' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, protocol: 'usenet' }, book: mockBook }]),
      );

      const result = await service.grab({
        downloadUrl: 'https://nzb.example.com/download/123',
        title: 'Test NZB',
        protocol: 'usenet',
      });

      expect(clientService.getFirstEnabledForProtocol).toHaveBeenCalledWith('usenet');
      expect(result).toBeDefined();
    });

    it('passes category from client settings to adapter', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      const clientWithCategory = { id: 1, name: 'qBit', enabled: true, settings: { category: 'audiobooks' } };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(clientWithCategory);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        { category: 'audiobooks' },
      );
    });

    it('does not pass category when client has no category configured', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      const clientNoCategory = { id: 1, name: 'qBit', enabled: true, settings: { host: 'localhost' } };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(clientNoCategory);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        undefined,
      );
    });

    it('treats whitespace-only category as empty', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      const clientWhitespace = { id: 1, name: 'qBit', enabled: true, settings: { category: '   ' } };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(clientWhitespace);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        'magnet:?xt=urn:btih:abc',
        undefined,
      );
    });

    it('does not update book status when bookId is not provided', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, bookId: null }, book: null }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
      });

      // db.update should NOT have been called (no book status update)
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('cancel — path-aware book status recovery', () => {
    it('reverts book to wanted when book has no path', async () => {
      const bookNoPath = createMockDbBook({ id: 1, path: null, status: 'downloading' });
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: bookNoPath }]),
      );
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.cancel(1);

      const setCalls = (chain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ status: 'wanted' }));
    });

    it('reverts book to imported when book has a path', async () => {
      const bookWithPath = createMockDbBook({ id: 1, path: '/audiobooks/existing', status: 'downloading' });
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: bookWithPath }]),
      );
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.cancel(1);

      const setCalls = (chain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ status: 'imported' }));
    });

    it('does not touch existing files when cancelling upgrade download', async () => {
      const bookWithPath = createMockDbBook({ id: 1, path: '/audiobooks/existing', status: 'downloading' });
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: bookWithPath }]),
      );
      db.update.mockReturnValue(mockDbChain());

      await service.cancel(1);

      // No file operations should happen during cancel
      // (cancel only updates DB, doesn't touch filesystem)
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    it('re-adds failed download to client with original params', async () => {
      const failedDownload = {
        ...mockDownload,
        status: 'failed' as const,
        errorMessage: 'Connection refused',
      };
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-new'),
      };

      // getById for retry
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      // grab: getFirstEnabledForProtocol
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      // grab: insert new download
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      // grab: getById for return
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]),
      );
      // delete old download
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.retry(1);

      expect(mockAdapter.addDownload).toHaveBeenCalled();
      expect(result.id).toBe(99);
    });

    it('resets book status to downloading on retry', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-new') };

      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      await service.retry(1);

      // grab() updates book to downloading
      expect(db.update).toHaveBeenCalled();
    });

    it('preserves book path when retrying for imported book', async () => {
      const importedBook = createMockDbBook({ id: 1, path: '/audiobooks/existing', status: 'wanted' });
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-new') };

      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: importedBook }]),
      );
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99 }, book: importedBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      await service.retry(1);

      // book.path should NOT be cleared — grab only updates status
      const updateCalls = db.update.mock.results;
      const setCalls = updateCalls
        .map(r => (r.value as { set: ReturnType<typeof vi.fn> }).set)
        .filter(Boolean);
      const allSetArgs = setCalls.flatMap(s => s.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>));
      const pathUpdates = allSetArgs.filter(a => 'path' in a);
      expect(pathUpdates).toHaveLength(0); // path should never be set
    });

    it('throws when download is not in failed state', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await expect(service.retry(1)).rejects.toThrow('not in failed state');
    });

    it('throws when download has no downloadUrl', async () => {
      const failedNoUrl = { ...mockDownload, status: 'failed' as const, downloadUrl: null };
      db.select.mockReturnValue(
        mockDbChain([{ download: failedNoUrl, book: mockBook }]),
      );

      await expect(service.retry(1)).rejects.toThrow('no download URL');
    });

    it('propagates error when grab() throws during retry — db.delete() never called', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };

      // getById for retry
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      // grab: getFirstEnabledForProtocol throws
      (clientService.getFirstEnabledForProtocol as Mock).mockRejectedValue(
        new Error('No client available'),
      );

      await expect(service.retry(1)).rejects.toThrow('No client available');

      // db.delete should never have been called
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('propagates error when db.delete() throws after successful grab — BUG: see #239', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-new') };

      // getById for retry
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      // grab: insert new download
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      // grab: getById for return
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]),
      );
      // delete throws
      db.delete.mockImplementation(() => { throw new Error('SQLITE_BUSY'); });

      // BUG: see #239 — error propagates, leaving duplicate records (old + new)
      await expect(service.retry(1)).rejects.toThrow('SQLITE_BUSY');

      // New download was already created (grab succeeded)
      expect(mockAdapter.addDownload).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
    });

    it('succeeds with null externalId — old record deleted, log.info with both IDs', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue(null) };
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99, externalId: null, status: 'downloading' }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await svc.retry(1);

      expect(result.id).toBe(99);
      expect(db.delete).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ oldId: 1, newId: 99 }),
        'Download retried',
      );
    });

    it('deletes old failed download record after successful retry', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-new') };

      db.select.mockReturnValueOnce(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      await service.retry(1);

      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('cancel edge cases', () => {
    it('skips adapter removal when externalId is null', async () => {
      const downloadNoExtId = { ...mockDownload, externalId: null };
      db.select.mockReturnValue(
        mockDbChain([{ download: downloadNoExtId, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());

      const result = await service.cancel(1);

      expect(result).toBe(true);
      expect(clientService.getAdapter).not.toHaveBeenCalled();
    });

    it('skips adapter removal when downloadClientId is null', async () => {
      const downloadNoClient = { ...mockDownload, downloadClientId: null };
      db.select.mockReturnValue(
        mockDbChain([{ download: downloadNoClient, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());

      const result = await service.cancel(1);

      expect(result).toBe(true);
      expect(clientService.getAdapter).not.toHaveBeenCalled();
    });

    it('logs error when adapter.removeDownload throws', async () => {
      const mockAdapter = {
        removeDownload: vi.fn().mockRejectedValue(new Error('Connection refused')),
      };

      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      const result = await svc.cancel(1);

      expect(result).toBe(true);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        expect.stringContaining('Failed to remove'),
      );
    });

    it('resets book to wanted when cancel has bookId', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());

      await service.cancel(1);

      // Should have been called for both download status and book status reset
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('updateProgress edge cases', () => {
    it('sets completedAt to null when progress < 1', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 0.5, status: 'downloading', completedAt: null }),
      );
    });

    it('sets completedAt to a Date when progress >= 1', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 1.0);

      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 1.0, status: 'completed' }),
      );
      const setArgs = (chain.set as Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.completedAt).toBeInstanceOf(Date);
    });
  });
});
