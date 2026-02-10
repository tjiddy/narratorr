import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import type { DownloadClientService } from './download-client.service.js';

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
  infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
  magnetUri: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
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

  describe('grab', () => {
    it('adds torrent and creates download record', async () => {
      const mockAdapter = {
        addTorrent: vi.fn().mockResolvedValue('ext-123'),
        removeTorrent: vi.fn(),
      };

      const enabledClient = { id: 1, name: 'qBit', enabled: true };
      (clientService.getFirstEnabled as any).mockResolvedValue(enabledClient);
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const result = await service.grab({
        magnetUri: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(mockAdapter.addTorrent).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
      expect(result.title).toBe('The Way of Kings');
    });

    it('throws when no download client configured', async () => {
      (clientService.getFirstEnabled as any).mockResolvedValue(null);

      await expect(
        service.grab({
          magnetUri: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('No download client configured');
    });

    it('throws when adapter cannot be initialized', async () => {
      (clientService.getFirstEnabled as any).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as any).mockResolvedValue(null);

      await expect(
        service.grab({
          magnetUri: 'magnet:?xt=urn:btih:abc',
          title: 'Test',
        }),
      ).rejects.toThrow('Could not initialize download client');
    });

    it('updates book status when bookId provided', async () => {
      const mockAdapter = {
        addTorrent: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabled as any).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        magnetUri: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
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

  describe('cancel', () => {
    it('removes torrent from client and updates status', async () => {
      const mockAdapter = {
        removeTorrent: vi.fn().mockResolvedValue(undefined),
      };

      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.update.mockReturnValue(mockDbChain());
      (clientService.getAdapter as any).mockResolvedValue(mockAdapter);

      const result = await service.cancel(1);

      expect(result).toBe(true);
      expect(mockAdapter.removeTorrent).toHaveBeenCalledWith(mockDownload.infoHash, true);
      expect(db.update).toHaveBeenCalled();
    });

    it('returns false when download not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.cancel(999);
      expect(result).toBe(false);
    });

    it('still cancels when adapter removal fails', async () => {
      const mockAdapter = {
        removeTorrent: vi.fn().mockRejectedValue(new Error('Connection failed')),
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
});
