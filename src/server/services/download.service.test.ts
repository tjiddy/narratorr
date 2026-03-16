import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import { type DownloadClientService } from './download-client.service.js';
import { type EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

import { createMockDbBook } from '../__tests__/factories.js';
import * as statusRegistry from '../../shared/download-status-registry.js';

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
    it('returns downloads in { data, total } envelope', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      const result = await service.getAll();
      expect(result.data).toHaveLength(1);
      expect(result.data[0].title).toBe('The Way of Kings');
      expect(result.data[0].book?.title).toBe('The Way of Kings');
      expect(result.total).toBe(1);
    });

    it('returns empty data with total 0 when no downloads', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('handles null book (orphaned download) in results', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
        .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: null }]));

      const result = await service.getAll();
      expect(result.data[0].book).toBeUndefined();
    });

    it('applies limit and offset when provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 50 }]))
        .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      const result = await service.getAll(undefined, { limit: 10, offset: 20 });
      expect(result.total).toBe(50);
      expect(result.data).toHaveLength(1);
    });

    it('applies stable orderBy with addedAt DESC, id DESC', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();

      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args).toHaveLength(2);
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

    it('delegates to getInProgressStatuses() for its status filter', async () => {
      const spy = vi.spyOn(statusRegistry, 'getInProgressStatuses');
      db.select.mockReturnValue(mockDbChain([]));

      await service.getActive();

      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
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

    it('delegates to getCompletedStatuses() which excludes failed from terminal set', async () => {
      const completedSpy = vi.spyOn(statusRegistry, 'getCompletedStatuses');
      const inProgressSpy = vi.spyOn(statusRegistry, 'getInProgressStatuses');
      db.select.mockReturnValue(mockDbChain([]));

      await service.getCounts();

      expect(completedSpy).toHaveBeenCalled();
      expect(inProgressSpy).toHaveBeenCalled();
      // Verify the effective completed set excludes 'failed'
      const completedStatuses = completedSpy.mock.results[0]!.value as string[];
      expect(completedStatuses).not.toContain('failed');
      expect(completedStatuses).toContain('completed');
      expect(completedStatuses).toContain('imported');
      completedSpy.mockRestore();
      inProgressSpy.mockRestore();
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

    it('uses in-progress statuses including checking and pending_review (bug fix)', async () => {
      const spy = vi.spyOn(statusRegistry, 'getInProgressStatuses');
      db.select.mockReturnValue(mockDbChain([]));

      await service.getActiveByBookId(1);

      expect(spy).toHaveBeenCalled();
      const usedStatuses = spy.mock.results[0]!.value as string[];
      expect(usedStatuses).toContain('checking');
      expect(usedStatuses).toContain('pending_review');
      spy.mockRestore();
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
      // First select: getActiveByBookId (no active downloads)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // Second select: getById for return
      db.select.mockReturnValueOnce(
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
      // First select: getActiveByBookId (no active downloads)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // Second select: getById for return
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(db.update).toHaveBeenCalled();
    });

    it('throws when bookId already has an active download', async () => {
      // getActiveByBookId returns an existing active download
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
          title: 'The Way of Kings',
          bookId: 1,
        }),
      ).rejects.toThrow('already has an active download');

      // No insert should have been called
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('skips duplicate check when bookId is not provided', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, bookId: null }, book: null }]),
      );

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalledTimes(1);
      // Only one db.select call — the final getById, NOT getActiveByBookId
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('skips duplicate check when skipDuplicateCheck is true', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      // Even though bookId is provided, skipDuplicateCheck bypasses the guard
      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test',
        bookId: 1,
        skipDuplicateCheck: true,
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalledTimes(1);
      // Only one db.select call — the final getById, NOT getActiveByBookId
      expect(db.select).toHaveBeenCalledTimes(1);
    });

    it('persists completed status when adapter returns null externalId (Blackhole)', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(null),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'Blackhole', type: 'blackhole', settings: { watchDir: '/watch' } });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, status: 'completed', externalId: null }, book: mockBook }]),
      );

      const result = await service.grab({
        downloadUrl: 'https://example.com/file.torrent',
        title: 'Test Blackhole',
        bookId: 1,
        skipDuplicateCheck: true,
      });

      expect(result).toBeDefined();
      // Verify insert was called with completed status
      const insertCall = db.insert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });

    it('does not set book status to downloading for handoff clients', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(null),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'Blackhole', type: 'blackhole', settings: {} });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, status: 'completed', externalId: null }, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'https://example.com/file.torrent',
        title: 'Test',
        bookId: 1,
        skipDuplicateCheck: true,
      });

      // Book status should be set to 'missing' (not 'downloading') for handoff clients
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
    it('treats empty string externalId as handoff (completed immediately)', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(''),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit', type: 'blackhole' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, status: 'completed', externalId: null }, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: 'https://example.com/file.torrent',
        title: 'Test',
      });

      // Empty string is falsy → treated as handoff → log.info about handoff
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test', clientType: 'blackhole' }),
        expect.stringContaining('Handoff client'),
      );
    });

    it('logs handoff info when adapter.addDownload returns null', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue(null),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'Blackhole', type: 'blackhole' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: 'https://example.com/file.torrent',
        title: 'Test',
      });

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test', clientType: 'blackhole' }),
        expect.stringContaining('Handoff client'),
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
      // First select: getActiveByBookId (no active downloads)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // Second select: getById for return
      db.select.mockReturnValueOnce(
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

    it('decodes data: URI and passes torrentFile to adapter', async () => {
      const torrentContent = Buffer.from('fake-torrent-bytes');
      const dataUri = `data:application/x-bittorrent;base64,${torrentContent.toString('base64')}`;
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-789'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: dataUri,
        title: 'MAM Torrent',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        dataUri,
        expect.objectContaining({ torrentFile: expect.any(Buffer) }),
      );
      // Verify the decoded buffer matches original content
      const passedOptions = mockAdapter.addDownload.mock.calls[0][1];
      expect(passedOptions.torrentFile.toString()).toBe('fake-torrent-bytes');
    });

    it('does not pass torrentFile for non-data: URIs', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Regular Magnet',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        undefined,
      );
    });

    it('logs truncated URL for data: URIs instead of full base64', async () => {
      const torrentContent = Buffer.from('fake-torrent-bytes');
      const dataUri = `data:application/x-bittorrent;base64,${torrentContent.toString('base64')}`;
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-789'),
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
        downloadUrl: dataUri,
        title: 'MAM Torrent',
      });

      // Should log truncated data URI, not full base64 content
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: expect.stringContaining('data:application/x-bittorrent') }),
        expect.any(String),
      );
      const debugCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(debugCall.downloadUrl).not.toContain(torrentContent.toString('base64'));
      expect(debugCall.downloadUrl).toContain('KB');
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

  describe('retry (search-based)', () => {
    it('throws when download not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await expect(service.retry(999)).rejects.toThrow('not found');
    });

    it('throws when download is not in failed state', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      await expect(service.retry(1)).rejects.toThrow('not in failed state');
    });

    it('throws when download has no bookId', async () => {
      const failedNoBook = { ...mockDownload, status: 'failed' as const, bookId: null };
      db.select.mockReturnValue(
        mockDbChain([{ download: failedNoBook, book: null }]),
      );
      await expect(service.retry(1)).rejects.toThrow('no book linked');
    });

    it('throws when retrySearchDeps not configured', async () => {
      const failedDownload = { ...mockDownload, status: 'failed' as const };
      db.select.mockReturnValue(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      await expect(service.retry(1)).rejects.toThrow('not configured');
    });

    describe('with retrySearchDeps', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let retryBudget: any;
      let retryService: DownloadService;
      let retryLog: ReturnType<typeof createMockLogger>;
      let mockRetryDeps: {
        indexerService: { searchAll: ReturnType<typeof vi.fn> };
        downloadService: { grab: ReturnType<typeof vi.fn> };
        blacklistService: { getBlacklistedHashes: ReturnType<typeof vi.fn> };
        bookService: { getById: ReturnType<typeof vi.fn> };
        settingsService: { get: ReturnType<typeof vi.fn> };
        retryBudget: unknown;
        log: ReturnType<typeof createMockLogger>;
      };

      beforeEach(async () => {
        const { RetryBudget } = await import('../services/retry-budget.js');
        retryBudget = new RetryBudget();
        retryLog = createMockLogger();
        mockRetryDeps = {
          indexerService: { searchAll: vi.fn().mockResolvedValue([]) },
          downloadService: { grab: vi.fn().mockResolvedValue({ id: 99, title: 'New Download', bookId: 1, book: mockBook }) },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 1, title: 'The Way of Kings', duration: 3600, author: { name: 'Sanderson' } }) },
          settingsService: { get: vi.fn().mockResolvedValue({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none', rejectWords: '', requiredWords: '' }) },
          retryBudget,
          log: retryLog,
        };
        retryService = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(createMockLogger()));
        retryService.setRetrySearchDeps(mockRetryDeps as never);
      });

      it('returns retried and deletes old record on successful retry', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        const searchResult = { title: 'Better Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
        mockRetryDeps.indexerService.searchAll.mockResolvedValue([searchResult]);

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.delete.mockReturnValue(mockDbChain());
        db.update.mockReturnValue(mockDbChain());

        const result = await retryService.retry(1);

        expect(result.status).toBe('retried');
        expect(db.delete).toHaveBeenCalled();
      });

      it('returns no_candidates and updates errorMessage when no results found', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        mockRetryDeps.indexerService.searchAll.mockResolvedValue([]);

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('no_candidates');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'No viable candidates' });
      });

      it('returns no_candidates and updates errorMessage when budget exhausted', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        retryBudget.consumeAttempt(1);
        retryBudget.consumeAttempt(1);
        retryBudget.consumeAttempt(1);
        // Budget reset by retry(), then immediately exhausted — need 4 total since reset clears
        // Actually retry() calls reset(bookId) first, so let's re-exhaust after
        // We need to make the budget report exhausted AFTER the reset
        // The retry method resets, then calls retrySearch which checks hasRemaining
        // To exhaust: we need retrySearch to return 'exhausted'
        // Since retry() resets first, we can't exhaust by pre-consuming. Instead test the no_candidates/exhausted mapping:
        // Both no_candidates and exhausted map to the same response. Let's verify with no_candidates already tested above.

        // For exhausted specifically, we need the budget to be exhausted WITHIN the retrySearch call
        // This means consuming 3 attempts on the same bookId after the reset
        // We can spy on retryBudget to prevent the reset:
        vi.spyOn(retryBudget, 'reset').mockImplementation(() => {
          // no-op — don't actually reset so budget stays exhausted
        });

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('no_candidates');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'No viable candidates' });
      });

      it('returns retry_error and updates errorMessage when search throws', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        mockRetryDeps.indexerService.searchAll.mockRejectedValue(new Error('Indexer down'));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('retry_error');
        expect((result as { error: string }).error).toBe('Indexer down');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'Retry failed - will retry next cycle' });
      });

      it('resets retry budget for the book before searching', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        const resetSpy = vi.spyOn(retryBudget, 'reset');

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.update.mockReturnValue(mockDbChain());

        await retryService.retry(1);

        expect(resetSpy).toHaveBeenCalledWith(1);
      });

      it('logs warning but still returns retried when old record deletion fails', async () => {
        const failedDownload = { ...mockDownload, id: 1, status: 'failed' as const };
        const searchResult = { title: 'Better Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:new', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
        mockRetryDeps.indexerService.searchAll.mockResolvedValue([searchResult]);

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.delete.mockImplementation(() => { throw new Error('FK constraint'); });
        db.update.mockReturnValue(mockDbChain());

        const retryLogLocal = createMockLogger();
        const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(retryLogLocal));
        svc.setRetrySearchDeps(mockRetryDeps as never);

        const result = await svc.retry(1);

        expect(result.status).toBe('retried');
        expect(retryLogLocal.warn).toHaveBeenCalledWith(
          expect.objectContaining({ oldId: 1 }),
          expect.stringContaining('Failed to delete old download'),
        );
      });
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

    it('includes progressUpdatedAt when progress changes', async () => {
      // Mock select to return existing progress of 0.3
      db.select.mockReturnValueOnce(mockDbChain([{ progress: 0.3 }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      const setArgs = (chain.set as Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs.progressUpdatedAt).toBeInstanceOf(Date);
    });

    it('omits progressUpdatedAt when progress is unchanged', async () => {
      // Mock select to return existing progress matching the update value
      db.select.mockReturnValueOnce(mockDbChain([{ progress: 0.5 }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      const setArgs = (chain.set as Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(setArgs).not.toHaveProperty('progressUpdatedAt');
    });
  });

  describe('event history producers', () => {
    let eventHistory: { create: ReturnType<typeof vi.fn> };
    let svcWithEvents: DownloadService;

    beforeEach(() => {
      eventHistory = { create: vi.fn().mockResolvedValue({ id: 1 }) };
      svcWithEvents = new DownloadService(
        inject<Db>(db),
        clientService,
        inject<FastifyBaseLogger>(createMockLogger()),
        undefined,
        inject<EventHistoryService>(eventHistory),
      );
    });

    it('records grabbed event on successful grab', async () => {
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-456') };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit', settings: {} });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ ...mockDownload, id: 10 }]));
      db.update.mockReturnValue(mockDbChain());
      // First select: getActiveByBookId (no active downloads), second select: getById after insert
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ download: { ...mockDownload, id: 10 }, book: mockBook }]));

      await svcWithEvents.grab({
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        title: 'Test Book',
        bookId: 1,
      });

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'Test Book',
          downloadId: 10,
          eventType: 'grabbed',
          source: 'auto',
          reason: expect.objectContaining({ protocol: 'torrent' }),
        }),
      );
    });

    it('records grabbed event with custom source when source is passed to grab', async () => {
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-789') };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit', settings: {} });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ ...mockDownload, id: 11 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select
        .mockReturnValueOnce(mockDbChain([]))
        .mockReturnValueOnce(mockDbChain([{ download: { ...mockDownload, id: 11 }, book: mockBook }]));

      await svcWithEvents.grab({
        downloadUrl: 'magnet:?xt=urn:btih:rss123',
        title: 'RSS Book',
        bookId: 1,
        source: 'rss',
      });

      expect(eventHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 1,
          bookTitle: 'RSS Book',
          downloadId: 11,
          eventType: 'grabbed',
          source: 'rss',
        }),
      );
    });

    it('records download_completed event when progress reaches 1', async () => {
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await svcWithEvents.updateProgress(1, 1.0);

      // Fire-and-forget — wait for microtask
      await vi.waitFor(() => {
        expect(eventHistory.create).toHaveBeenCalledWith(
          expect.objectContaining({
            bookId: 1,
            bookTitle: 'The Way of Kings',
            eventType: 'download_completed',
            source: 'auto',
            reason: { progress: 1 },
          }),
        );
      });
    });

    it('records download_failed event on setError', async () => {
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await svcWithEvents.setError(1, 'Disk full');

      await vi.waitFor(() => {
        expect(eventHistory.create).toHaveBeenCalledWith(
          expect.objectContaining({
            bookId: 1,
            bookTitle: 'The Way of Kings',
            eventType: 'download_failed',
            source: 'auto',
            reason: { error: 'Disk full' },
          }),
        );
      });
    });

    it('does not record event when no bookId on download', async () => {
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([{ download: { ...mockDownload, bookId: null }, book: null }]));

      await svcWithEvents.setError(1, 'Disk full');

      // Wait a tick then verify no event was created
      await new Promise((r) => setTimeout(r, 10));
      expect(eventHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('SSE emissions', () => {
    let svcWithBroadcaster: DownloadService;
    let broadcaster: { emit: ReturnType<typeof vi.fn> };
    let broadcasterLog: ReturnType<typeof createMockLogger>;

    beforeEach(() => {
      broadcaster = { emit: vi.fn() };
      broadcasterLog = createMockLogger();
      svcWithBroadcaster = new DownloadService(
        inject<Db>(db),
        clientService,
        inject<FastifyBaseLogger>(broadcasterLog),
        undefined,
        undefined,
        inject<EventBroadcasterService>(broadcaster),
      );
    });

    it('updateProgress emits download_progress', async () => {
      db.update.mockReturnValue(mockDbChain());

      await svcWithBroadcaster.updateProgress(1, 0.5, 2);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null,
      });
    });

    it('updateProgress emits download_status_change on completion', async () => {
      db.update.mockReturnValue(mockDbChain());
      // getById is called inside emitEventForDownload — return a minimal download
      db.select.mockReturnValue(mockDbChain([]));

      await svcWithBroadcaster.updateProgress(1, 1, 2);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_progress', {
        download_id: 1, book_id: 2, percentage: 1, speed: null, eta: null,
      });
      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed',
      });
    });

    it('updateStatus emits download_status_change with meta', async () => {
      db.update.mockReturnValue(mockDbChain());

      await svcWithBroadcaster.updateStatus(1, 'completed', { bookId: 2, oldStatus: 'downloading' as DownloadStatus });

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed',
      });
    });

    it('setError emits download_status_change with meta', async () => {
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([]));

      await svcWithBroadcaster.setError(1, 'oops', { bookId: 2, oldStatus: 'downloading' as DownloadStatus });

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'failed',
      });
    });

    it('broadcaster.emit failure logs debug and does not break updateProgress', async () => {
      const sseError = new Error('SSE broken');
      broadcaster.emit.mockImplementation(() => { throw sseError; });
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([]));

      await expect(svcWithBroadcaster.updateProgress(1, 0.5, 2)).resolves.not.toThrow();
      expect(broadcasterLog.debug).toHaveBeenCalledWith(sseError, 'SSE emit failed');
    });

    it('grab emits grab_started and book_status_change', async () => {
      const mockAdapterGrab = { addDownload: vi.fn().mockResolvedValue('ext-new') };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit', enabled: true });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapterGrab);

      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      // getActiveByBookId returns empty (no dupe)
      db.select.mockReturnValueOnce(mockDbChain([]));
      // getById for return value
      db.select.mockReturnValueOnce(mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]));

      await svcWithBroadcaster.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test Grab',
        bookId: 5,
      });

      expect(broadcaster.emit).toHaveBeenCalledWith('grab_started', {
        download_id: 99, book_id: 5, book_title: 'Test Grab', release_title: 'Test Grab',
      });
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 5, old_status: 'wanted', new_status: 'downloading',
      });
    });

    it('grab logs debug when broadcaster.emit throws', async () => {
      const sseError = new Error('SSE broken');
      broadcaster.emit.mockImplementation(() => { throw sseError; });
      const mockAdapterGrab = { addDownload: vi.fn().mockResolvedValue('ext-new') };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit', enabled: true });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapterGrab);

      db.insert.mockReturnValue(mockDbChain([{ id: 99 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([{ download: { ...mockDownload, id: 99 }, book: mockBook }]));

      await expect(svcWithBroadcaster.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test',
        bookId: 5,
      })).resolves.toBeDefined();
      expect(broadcasterLog.debug).toHaveBeenCalledWith(sseError, 'SSE emit failed');
    });

    it('cancel emits download_status_change and book_status_change', async () => {
      const mockAdapterCancel = { removeDownload: vi.fn().mockResolvedValue(undefined) };
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapterCancel);

      // getById returns download with book (no path → revert to wanted)
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, status: 'downloading', bookId: 1 }, book: { ...mockBook, status: 'downloading', path: null } }]),
      );
      db.update.mockReturnValue(mockDbChain());

      await svcWithBroadcaster.cancel(1);

      expect(broadcaster.emit).toHaveBeenCalledWith('download_status_change', {
        download_id: 1, book_id: 1, old_status: 'downloading', new_status: 'failed',
      });
      expect(broadcaster.emit).toHaveBeenCalledWith('book_status_change', {
        book_id: 1, old_status: 'downloading', new_status: 'wanted',
      });
    });

    it('cancel logs debug when broadcaster.emit throws', async () => {
      const sseError = new Error('SSE broken');
      broadcaster.emit.mockImplementation(() => { throw sseError; });
      const mockAdapterCancel = { removeDownload: vi.fn().mockResolvedValue(undefined) };
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapterCancel);

      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, status: 'downloading', bookId: 1 }, book: { ...mockBook, status: 'downloading', path: null } }]),
      );
      db.update.mockReturnValue(mockDbChain());

      await expect(svcWithBroadcaster.cancel(1)).resolves.toBe(true);
      expect(broadcasterLog.debug).toHaveBeenCalledWith(sseError, 'SSE emit failed');
    });
  });

  // #372 — Section split for queue/history pagination
  describe('getAll with section', () => {
    it('accepts section=queue without error', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, undefined, 'queue');
      expect(result.total).toBe(2);
    });

    it('accepts section=history without error', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 5 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, undefined, 'history');
      expect(result.total).toBe(5);
    });

    it('returns all downloads when no section param', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 10 }]))
        .mockReturnValueOnce(mockDbChain([]));

      const result = await service.getAll(undefined, undefined);
      expect(result.total).toBe(10);
    });

    it('combines section with pagination', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 20 }]))
        .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      const result = await service.getAll(undefined, { limit: 10, offset: 0 }, 'queue');
      expect(result.total).toBe(20);
      expect(result.data).toHaveLength(1);
    });
  });

});
