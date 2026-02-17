import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import { type DownloadClientService } from './download-client.service.js';

const now = new Date();

const mockBook = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  status: 'wanted' as const,
  createdAt: now,
  updatedAt: now,
};

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
  return {
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
  } as unknown as DownloadClientService;
}

describe('DownloadService', () => {
  let db: ReturnType<typeof createMockDb>;
  let clientService: ReturnType<typeof createMockDownloadClientService>;
  let service: DownloadService;

  beforeEach(() => {
    db = createMockDb();
    clientService = createMockDownloadClientService();
    service = new DownloadService(db as any, clientService, createMockLogger() as any);
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
      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue(enabledClient);
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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
      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue(null);

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('No download client configured');
    });

    it('throws when adapter cannot be initialized', async () => {
      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as any).mockResolvedValue(null);

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

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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
      const svc = new DownloadService(db as any, clientService, log as any);

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
      const svc = new DownloadService(db as any, clientService, log as any);

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
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(db as any, clientService, log as any);

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

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 2, name: 'SABnzbd' });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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

    it('does not update book status when bookId is not provided', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as any).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

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
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

      const log = createMockLogger();
      const svc = new DownloadService(db as any, clientService, log as any);

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
      const setArgs = (chain.set as any).mock.calls[0][0];
      expect(setArgs.completedAt).toBeInstanceOf(Date);
    });
  });
});
