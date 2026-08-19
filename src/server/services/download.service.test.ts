import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService, searchStatus, mockSearchAllWithStatus } from '../__tests__/helpers.js';
import { DownloadService, DownloadError, DuplicateDownloadError } from './download.service.js';
import { type DownloadClientService } from './download-client.service.js';
import { DownloadUrl } from '@core/utils/download-url.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { createMockDbBook, createMockDbIndexer } from '../__tests__/factories.js';
import * as statusRegistry from '@shared/download-status-registry.js';
import { deriveDisplayStatus } from '@shared/download-status-registry.js';

const dialect = new SQLiteSyncDialect();
function toSQL(expr: unknown): { sql: string; params: unknown[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL());
}

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
  clientStatus: 'downloading' as const,
  pipelineStage: 'idle' as const,
  progress: 0,
  externalId: 'ext-123',
  errorMessage: null,
  addedAt: now,
  completedAt: null,
  guid: null, outputPath: null, progressUpdatedAt: null, pendingCleanup: null,
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
      expect(result.data[0]!.title).toBe('The Way of Kings');
      expect(result.data[0]!.book?.title).toBe('The Way of Kings');
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
      expect(result.data[0]!.book).toBeUndefined();
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

    it('derives the display status from the (clientStatus, pipelineStage) tuple (#1445 F1 seam)', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'pending_review' }, book: mockBook }]),
      );

      const result = await service.getById(1);
      expect(result!.status).toBe('pending_review');
      expect(result!.clientStatus).toBe('completed');
      expect(result!.pipelineStage).toBe('pending_review');
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
      expect(result[0]!.bookId).toBe(1);
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
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
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
          downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
          title: 'Test',
        }),
      ).rejects.toThrow('No download client configured');
    });

    it('throws when adapter cannot be initialized', async () => {
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1 });
      (clientService.getAdapter as Mock).mockResolvedValue(null);

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
          title: 'Test',
        }),
      ).rejects.toThrow('Could not initialize download client');
    });

    it('throws when bookId already has an active download', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await expect(
        service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
          title: 'The Way of Kings',
          bookId: 1,
        }),
      ).rejects.toThrow(DuplicateDownloadError);

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
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalledTimes(1);
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

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
        skipDuplicateCheck: true,
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalledTimes(1);
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
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'idle', externalId: null }, book: mockBook }]),
      );

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test Blackhole',
        bookId: 1,
        skipDuplicateCheck: true,
      });

      expect(result).toBeDefined();
      const insertCall = db.insert.mock.calls[0];
      expect(insertCall).toBeDefined();
    });

    it('includes indexerId in insert payload when provided in grab params', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };

      const enabledClient = { id: 1, name: 'qBit', enabled: true };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(enabledClient);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
        indexerId: 42,
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.indexerId).toBe(42);
    });

    it('persists bookStatusAtGrab to insert payload when provided in grab params', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
        bookStatusAtGrab: 'wanted',
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.bookStatusAtGrab).toBe('wanted');
    });

    it('defaults bookStatusAtGrab to null when omitted from grab params (orphan / legacy path)', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.bookStatusAtGrab).toBeNull();
    });

    it('writes a dl_-prefixed publicId to the downloads insert payload', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.publicId).toMatch(/^dl_/);
    });

    describe('LAN allowlist (#966)', () => {
      const httpTorrentUrl = 'http://192.168.0.22:9696/dl/foo.torrent';

      function setupCommonGrabMocks(): void {
        const mockAdapter = {
          addDownload: vi.fn().mockResolvedValue('ext-123'),
          removeDownload: vi.fn(),
        };
        (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
        (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
        db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
        db.update.mockReturnValue(mockDbChain());
        db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));
      }

      it('delegates LAN allowlist construction to IndexerService.getLanAllowlist for torrent HTTP grabs (#1149 shared builder)', async () => {
        setupCommonGrabMocks();
        const sharedAllowlist = {
          hostPort: new Set(['192.168.0.22:9696', 'prowlarr.lan:80']),
          hostname: new Set(['192.168.0.22', 'prowlarr.lan']),
        };
        const indexerService = {
          getLanAllowlist: vi.fn().mockResolvedValue(sharedAllowlist),
        };
        service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });

        const resolveSpy = vi.spyOn(DownloadUrl.prototype, 'resolve').mockResolvedValue({
          type: 'torrent-bytes', data: Buffer.from('x'), infoHash: 'a'.repeat(40),
        });

        await service.grab({ downloadUrl: httpTorrentUrl, title: 'Test', protocol: 'torrent' });

        expect(indexerService.getLanAllowlist).toHaveBeenCalledTimes(1);
        const allowlist = resolveSpy.mock.calls[0]![0]!;
        expect(allowlist).toBe(sharedAllowlist);

        resolveSpy.mockRestore();
      });

      it('does NOT call IndexerService.getLanAllowlist() for magnet grabs (allowlist undefined)', async () => {
        setupCommonGrabMocks();
        const indexerService = { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) };
        service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });

        const resolveSpy = vi.spyOn(DownloadUrl.prototype, 'resolve').mockResolvedValue({
          type: 'magnet-uri', uri: 'magnet:x', infoHash: 'a'.repeat(40),
        });

        await service.grab({
          downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
          title: 'Test',
        });

        expect(indexerService.getLanAllowlist).not.toHaveBeenCalled();
        expect(resolveSpy).toHaveBeenCalledWith(undefined);
        resolveSpy.mockRestore();
      });

      // Usenet HTTP grabs need the LAN allowlist for Blackhole to fetch private indexer NZBs (#1243).
      it('delegates LAN allowlist construction to IndexerService.getLanAllowlist for usenet HTTP grabs (#1243)', async () => {
        setupCommonGrabMocks();
        const sharedAllowlist = {
          hostPort: new Set(['192.168.0.22:9696']),
          hostname: new Set(['192.168.0.22']),
        };
        const indexerService = { getLanAllowlist: vi.fn().mockResolvedValue(sharedAllowlist) };
        service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });

        const resolveSpy = vi.spyOn(DownloadUrl.prototype, 'resolve').mockResolvedValue({
          type: 'nzb-url', url: 'https://nzb.example.com/dl',
        });

        await service.grab({
          downloadUrl: 'https://nzb.example.com/dl',
          title: 'Test',
          protocol: 'usenet',
        });

        expect(indexerService.getLanAllowlist).toHaveBeenCalledTimes(1);
        expect(resolveSpy.mock.calls[0]![0]!).toBe(sharedAllowlist);
        resolveSpy.mockRestore();
      });

      it('does NOT call IndexerService.getLanAllowlist() for data: URI grabs', async () => {
        setupCommonGrabMocks();
        const indexerService = { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) };
        service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });

        const resolveSpy = vi.spyOn(DownloadUrl.prototype, 'resolve').mockResolvedValue({
          type: 'torrent-bytes', data: Buffer.from('x'), infoHash: 'a'.repeat(40),
        });

        await service.grab({
          downloadUrl: 'data:application/x-bittorrent;base64,AA==',
          title: 'Test',
          protocol: 'torrent',
        });

        expect(indexerService.getLanAllowlist).not.toHaveBeenCalled();
        expect(resolveSpy).toHaveBeenCalledWith(undefined);
        resolveSpy.mockRestore();
      });
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

  describe('setError', () => {
    it('writes the sanctioned failure tuple (failed, idle) with errorMessage', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.setError(1, 'Connection refused');

      // Reset pipelineStage so a prior stage cannot override the failed display status.
      expect(chain.set).toHaveBeenCalledWith({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Connection refused' });
      expect(deriveDisplayStatus('failed', 'idle')).toBe('failed');
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
    it('removes torrent from client and writes the failure tuple (failed, idle)', async () => {
      const mockAdapter = {
        removeDownload: vi.fn().mockResolvedValue(undefined),
      };
      const chain = mockDbChain();

      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      db.update.mockReturnValue(chain);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      const result = await service.cancel(1);

      expect(result).toBe(true);
      expect(mockAdapter.removeDownload).toHaveBeenCalledWith(mockDownload.externalId, true);
      expect(chain.set).toHaveBeenCalledWith({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Cancelled by user' });
    });

    it.each(['pending_review', 'importing', 'checking'] as const)(
      'resets pipelineStage to idle when cancelling a download in %s (display derives as failed)',
      async (stage) => {
        const chain = mockDbChain();
        db.select.mockReturnValue(
          mockDbChain([{ download: { ...mockDownload, pipelineStage: stage }, book: mockBook }]),
        );
        db.update.mockReturnValue(chain);
        (clientService.getAdapter as Mock).mockResolvedValue(null);

        const result = await service.cancel(1);

        expect(result).toBe(true);
        expect(chain.set).toHaveBeenCalledWith({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Cancelled by user' });
        expect(deriveDisplayStatus('failed', 'idle')).toBe('failed');
      },
    );

    it('uses a custom cancellation reason as the errorMessage', async () => {
      const chain = mockDbChain();
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, pipelineStage: 'importing' }, book: mockBook }]),
      );
      db.update.mockReturnValue(chain);
      (clientService.getAdapter as Mock).mockResolvedValue(null);

      const result = await service.cancel(1, 'some reason');

      expect(result).toBe(true);
      expect(chain.set).toHaveBeenCalledWith({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'some reason' });
    });

    it('returns false when download not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.cancel(999);
      expect(result).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
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
    it('returns true when download exists and has terminal status', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'idle' }, book: mockBook }]),
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

      // Capture the insert: empty externalId must become null rather than a permanent QG blocker (#1861).
      const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) });
      db.insert.mockReturnValue({ values: valuesSpy } as never);
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'idle', externalId: null }, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test',
      });

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Test', clientType: 'blackhole' }),
        expect.stringContaining('Handoff client'),
      );
      expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ externalId: null }));
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
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
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
          downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
          title: 'Test',
        }),
      ).rejects.toThrow('UNIQUE constraint failed');
    });

    // Once the client accepts a tracked download, DB failure requires best-effort external cleanup (#1857).
    it('compensates a tracked download with removeDownload(externalId, true) when insert fails, then rethrows', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-456'),
        removeDownload: vi.fn().mockResolvedValue(undefined),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockImplementation(() => { throw new Error('UNIQUE constraint failed'); });

      await expect(
        service.grab({ downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc', title: 'Test' }),
      ).rejects.toThrow('UNIQUE constraint failed');

      expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-456', true);
    });

    it('logs an operator-recoverable orphan (not absolute no-orphan) when compensation ALSO fails', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-789'),
        removeDownload: vi.fn().mockRejectedValue(new Error('client offline')),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockImplementation(() => { throw new Error('UNIQUE constraint failed'); });

      await expect(
        svc.grab({ downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc', title: 'Test' }),
      ).rejects.toThrow('UNIQUE constraint failed');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-789' }),
        expect.stringContaining('orphaned external download'),
      );
    });

    // Missing compensation adapters still leave operator-recoverable external orphans (#1857).
    it('logs the orphan when the compensation adapter is unavailable (getAdapter → null)', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock)
        .mockResolvedValueOnce({ addDownload: vi.fn().mockResolvedValue('ext-null') })
        .mockResolvedValueOnce(null);
      db.insert.mockImplementation(() => { throw new Error('UNIQUE constraint failed'); });

      await expect(
        svc.grab({ downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc', title: 'Test' }),
      ).rejects.toThrow('UNIQUE constraint failed');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-null' }),
        expect.stringContaining('orphaned external download'),
      );
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
      service.wire({ retrySearchDeps: {} as never, indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as never });

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
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'magnet-uri' }),
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
        expect.objectContaining({ type: 'magnet-uri' }),
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
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'magnet-uri' }),
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
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
      });

      expect(db.update).not.toHaveBeenCalled();
    });

    it('resolves data: URI and passes torrent-bytes artifact to adapter', async () => {
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

      // Minimal valid torrent lets the resolver extract an info hash.
      const inner = Buffer.from('d6:lengthi1024e4:name8:test.mp3e');
      const torrentContent = Buffer.from(`d8:announce5:x.com4:info${inner.toString()}e`);
      const dataUri = `data:application/x-bittorrent;base64,${torrentContent.toString('base64')}`;

      await service.grab({
        downloadUrl: dataUri,
        title: 'MAM Torrent',
      });

      expect(mockAdapter.addDownload).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'torrent-bytes', data: expect.any(Buffer) }),
        undefined,
      );
    });

    it('passes magnet-uri artifact for magnet URIs', async () => {
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
        expect.objectContaining({
          type: 'magnet-uri',
          uri: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
          infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        }),
        undefined,
      );
    });

    it('resolver failure prevents adapter call and DB insert', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      await expect(
        service.grab({
          downloadUrl: 'magnet:?dn=Test+File',
          title: 'Bad Magnet',
        }),
      ).rejects.toThrow(/info hash/i);

      expect(mockAdapter.addDownload).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('persists resolved infoHash to downloads row for data: URI', async () => {
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

      const { createHash: createHashFn } = await import('node:crypto');
      const inner = Buffer.from('d6:lengthi1024e4:name8:test.mp3e');
      const expectedHash = createHashFn('sha1').update(inner).digest('hex');
      const torrentContent = Buffer.from(`d8:announce5:x.com4:info${inner.toString()}e`);
      const dataUri = `data:application/x-bittorrent;base64,${torrentContent.toString('base64')}`;

      await service.grab({
        downloadUrl: dataUri,
        title: 'MAM Torrent',
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.infoHash).toBe(expectedHash);
    });

    it('persists null infoHash for nzb-url artifact', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('sab-123'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'SAB' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, protocol: 'usenet' }, book: mockBook }]),
      );
      service.wire({ retrySearchDeps: {} as never, indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as never });

      await service.grab({
        downloadUrl: 'https://indexer.test/nzb/12345',
        title: 'Usenet NZB',
        protocol: 'usenet',
      });

      const insertValues = db.insert.mock.results[0]!.value.values.mock.calls[0][0];
      expect(insertValues.infoHash).toBeNull();
    });

    it('logs truncated URL for data: URIs instead of full base64', async () => {
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

      const inner = Buffer.from('d6:lengthi1024e4:name8:test.mp3e');
      const torrentContent = Buffer.from(`d8:announce5:x.com4:info${inner.toString()}e`);
      const dataUri = `data:application/x-bittorrent;base64,${torrentContent.toString('base64')}`;

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: dataUri,
        title: 'MAM Torrent',
      });

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ downloadUrl: expect.stringContaining('data:application/x-bittorrent') }),
        expect.any(String),
      );
      const sendingCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('Sending download'),
      );
      expect(sendingCall).toBeTruthy();
      expect((sendingCall![0] as Record<string, unknown>).downloadUrl).not.toContain(torrentContent.toString('base64'));
    });

    it('logs sanitized URL for HTTP URL with credential query params', async () => {
      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-456'),
      };

      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'SABnzbd' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      svc.wire({ retrySearchDeps: {} as never, indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as never });

      await svc.grab({
        downloadUrl: 'https://indexer.example.com/api/v1/download/12345?apikey=SECRETKEY123',
        title: 'Test NZB',
        protocol: 'usenet',
      });

      const sendingCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('Sending download'),
      );
      expect(sendingCall).toBeTruthy();
      const debugCall = sendingCall![0] as Record<string, unknown>;
      expect(debugCall.downloadUrl).toBe('https://indexer.example.com/api/v1/download/12345');
      expect(debugCall.downloadUrl).not.toContain('SECRETKEY123');
    });

    it('logs magnet:[infoHash] for magnet URI', async () => {
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

      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      await svc.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d&dn=Test&tr=udp://tracker.example.com',
        title: 'Test Magnet',
      });

      const sendingCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls.find(
        c => typeof c[1] === 'string' && c[1].includes('Sending download'),
      );
      expect(sendingCall).toBeTruthy();
      const debugCall = sendingCall![0] as Record<string, unknown>;
      expect(debugCall.downloadUrl).toBe('magnet:[aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d]');
      expect(debugCall.downloadUrl).not.toContain('tracker.example.com');
    });
  });

  describe('cancel — download status only (book status reverted by orchestrator)', () => {
    it('sets download status to failed with cancelled message', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: mockBook }]),
      );
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.cancel(1);

      expect(chain.set).toHaveBeenCalledWith({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Cancelled by user' });
    });

    it('does not update book status (orchestrator responsibility)', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, downloadClientId: null, externalId: null }, book: mockBook }]),
      );
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.cancel(1);

      const setCalls = (chain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]).toEqual({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Cancelled by user' });
    });
  });

  describe('retry (search-based)', () => {
    it('DownloadError constructor sets name and code correctly', () => {
      const err = new DownloadError('test message', 'NOT_FOUND');
      expect(err.name).toBe('DownloadError');
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('test message');
      expect(err).toBeInstanceOf(Error);
    });

    it('throws DownloadError NOT_FOUND when download not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      await expect(service.retry(999)).rejects.toSatisfy(
        (e: unknown) => e instanceof DownloadError && e.code === 'NOT_FOUND',
      );
    });

    it('throws DownloadError INVALID_STATUS when download is not in failed state', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: mockDownload, book: mockBook }]),
      );
      await expect(service.retry(1)).rejects.toSatisfy(
        (e: unknown) => e instanceof DownloadError && e.code === 'INVALID_STATUS',
      );
    });

    it('throws DownloadError NO_BOOK_LINKED when download has no bookId', async () => {
      const failedNoBook = { ...mockDownload, clientStatus: 'failed' as const, pipelineStage: 'idle' as const, bookId: null };
      db.select.mockReturnValue(
        mockDbChain([{ download: failedNoBook, book: null }]),
      );
      await expect(service.retry(1)).rejects.toSatisfy(
        (e: unknown) => e instanceof DownloadError && e.code === 'NO_BOOK_LINKED',
      );
    });

    it('throws ServiceWireError when retry() invoked before wire() (required-wiring contract)', async () => {
      const failedDownload = { ...mockDownload, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
      db.select.mockReturnValue(
        mockDbChain([{ download: failedDownload, book: mockBook }]),
      );
      await expect(service.retry(1)).rejects.toThrow(/DownloadService used before wire/);
    });

    describe('with retrySearchDeps', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let retryBudget: any;
      let retryService: DownloadService;
      let retryLog: ReturnType<typeof createMockLogger>;
      let retryServiceLog: ReturnType<typeof createMockLogger>;
      let mockRetryDeps: {
        indexerSearchService: { searchAllWithStatus: ReturnType<typeof vi.fn> };
        indexerService: { getLanAllowlist: ReturnType<typeof vi.fn> };
        downloadOrchestrator: { grab: ReturnType<typeof vi.fn>; grabForRetry: ReturnType<typeof vi.fn>; hasGrabBlocker: ReturnType<typeof vi.fn> };
        blacklistService: { getBlacklistedHashes: ReturnType<typeof vi.fn>; getBlacklistedIdentifiers: ReturnType<typeof vi.fn> };
        bookService: { getById: ReturnType<typeof vi.fn> };
        settingsService: ReturnType<typeof createMockSettingsService>;
        retryBudget: unknown;
        // retrySearch records held/blocked events through this; omitting it makes the recorder
        // throw and every such outcome surface as retry_error instead.
        eventHistory: { create: ReturnType<typeof vi.fn> };
        log: ReturnType<typeof createMockLogger>;
      };

      beforeEach(async () => {
        const { RetryBudget } = await import('../services/retry-budget.js');
        retryBudget = new RetryBudget();
        retryLog = createMockLogger();
        mockRetryDeps = {
          indexerSearchService: { searchAllWithStatus: mockSearchAllWithStatus([]) },
          indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) },
          downloadOrchestrator: {
            grab: vi.fn().mockResolvedValue({ id: 99, title: 'New Download', bookId: 1, book: mockBook }),
            grabForRetry: vi.fn().mockResolvedValue({ id: 99, title: 'New Download', bookId: 1, book: mockBook }),
            hasGrabBlocker: vi.fn().mockResolvedValue(false),
          },
          blacklistService: { getBlacklistedHashes: vi.fn().mockResolvedValue(new Set()), getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set(), blacklistedGuids: new Set() }) },
          bookService: { getById: vi.fn().mockResolvedValue({ id: 1, title: 'The Way of Kings', duration: 3600, path: null, author: { name: 'Sanderson' } }) },
          settingsService: createMockSettingsService(),
          retryBudget,
          eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
          log: retryLog,
        };
        retryServiceLog = createMockLogger();
        retryService = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(retryServiceLog));
        retryService.wire({ retrySearchDeps: mockRetryDeps as never, indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as never });
      });

      it('returns retried and deletes old record on successful retry', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        const searchResult = { title: 'Better Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:00000000000000000000000000000000000000ee', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
        mockRetryDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([searchResult]));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.delete.mockReturnValue(mockDbChain());
        db.update.mockReturnValue(mockDbChain());

        const result = await retryService.retry(1);

        expect(result.status).toBe('retried');
        expect(db.delete).toHaveBeenCalled();
      });

      it('returns no_candidates and updates errorMessage when no results found', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        mockRetryDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([]));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('no_candidates');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'No viable candidates' });
      });

      // #2322 introduces no new RetryOutcome variant, so no new status can leak to routes/activity.
      it('returns no_candidates and the existing errorMessage when every candidate is at the unsatisfied limit', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        const atLimit = {
          title: 'MAM Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:00000000000000000000000000000000000000ff',
          infoHash: 'mam123', size: 500000000, seeders: 5, indexer: 'MyAnonamouse', unsatisfied: { count: 150, limit: 150 },
        };
        mockRetryDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([atLimit]));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('no_candidates');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'No viable candidates' });
        expect(mockRetryDeps.downloadOrchestrator.grabForRetry).not.toHaveBeenCalled();
      });

      // Any grab blocker maps to already_active without deleting or rewriting the failed row (#1857, #1861).
      it('returns already_active and preserves the old failed row (not deleted, errorMessage untouched)', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const, errorMessage: 'Original failure' };
        mockRetryDeps.downloadOrchestrator.hasGrabBlocker.mockResolvedValue(true);

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('already_active');
        expect(db.delete).not.toHaveBeenCalled();
        expect(chain.set).not.toHaveBeenCalled();
        expect(mockRetryDeps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
        expect(retryServiceLog.info).toHaveBeenCalledWith(
          { id: 1 },
          'Manual retry: book already has a blocking download or import — not retrying',
        );
      });

      it('returns no_candidates and updates errorMessage when budget exhausted', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        retryBudget.consumeAttempt(1);
        retryBudget.consumeAttempt(1);
        retryBudget.consumeAttempt(1);
        // Suppress retry's reset so retrySearch observes the pre-exhausted budget.
        vi.spyOn(retryBudget, 'reset').mockImplementation(() => {
          // Preserve the exhausted state.
        });

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('no_candidates');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'No viable candidates' });
      });

      it('returns retry_error and updates errorMessage when search throws', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        mockRetryDeps.indexerSearchService.searchAllWithStatus.mockRejectedValue(new Error('Indexer down'));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        const chain = mockDbChain();
        db.update.mockReturnValue(chain);

        const result = await retryService.retry(1);

        expect(result.status).toBe('retry_error');
        expect((result as { error: string }).error).toBe('Indexer down');
        expect(chain.set).toHaveBeenCalledWith({ errorMessage: 'Retry failed - will retry next cycle' });
      });

      it('resets retry budget for the book before searching', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        const resetSpy = vi.spyOn(retryBudget, 'reset');

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.update.mockReturnValue(mockDbChain());

        await retryService.retry(1);

        expect(resetSpy).toHaveBeenCalledWith(1);
      });

      it('logs warning but still returns retried when old record deletion fails', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        const searchResult = { title: 'Better Release', protocol: 'torrent', downloadUrl: 'magnet:?xt=urn:btih:00000000000000000000000000000000000000ee', infoHash: 'new123', size: 500000000, seeders: 5, indexer: 'Test' };
        mockRetryDeps.indexerSearchService.searchAllWithStatus.mockResolvedValue(searchStatus([searchResult]));

        db.select.mockReturnValue(mockDbChain([{ download: failedDownload, book: mockBook }]));
        db.delete.mockImplementation(() => { throw new Error('FK constraint'); });
        db.update.mockReturnValue(mockDbChain());

        const retryLogLocal = createMockLogger();
        const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(retryLogLocal));
        svc.wire({ retrySearchDeps: mockRetryDeps as never, indexerService: { getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }) } as never });

        const result = await svc.retry(1);

        expect(result.status).toBe('retried');
        expect(retryLogLocal.warn).toHaveBeenCalledWith(
          expect.objectContaining({ oldId: 1 }),
          expect.stringContaining('Failed to delete old download'),
        );
      });

      it('throws DownloadError IMPORTED_BOOK_NO_RETRY when linked book has been imported (book.path != null)', async () => {
        const failedDownload = { ...mockDownload, id: 1, clientStatus: 'failed' as const, pipelineStage: 'idle' as const };
        db.select
          .mockReturnValueOnce(mockDbChain([{ download: failedDownload, book: mockBook }]))
          .mockReturnValueOnce(mockDbChain([{ path: '/library/imported-book' }]));
        const resetSpy = vi.spyOn(retryBudget, 'reset');

        await expect(retryService.retry(1)).rejects.toSatisfy(
          (e: unknown) => e instanceof DownloadError && e.code === 'IMPORTED_BOOK_NO_RETRY',
        );

        expect(resetSpy).not.toHaveBeenCalled();
        expect(mockRetryDeps.indexerSearchService.searchAllWithStatus).not.toHaveBeenCalled();
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

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('updateProgress edge cases', () => {
    it('sets completedAt to null when progress < 1', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 0.5, clientStatus: 'downloading', completedAt: null }),
      );
    });

    it('sets completedAt to a Date when progress >= 1', async () => {
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 1.0);

      expect(chain.set).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 1.0, clientStatus: 'completed' }),
      );
      const setArgs = (chain.set as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(setArgs.completedAt).toBeInstanceOf(Date);
    });

    it('includes progressUpdatedAt when progress changes', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ progress: 0.3 }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      const setArgs = (chain.set as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(setArgs.progressUpdatedAt).toBeInstanceOf(Date);
    });

    it('omits progressUpdatedAt when progress is unchanged', async () => {
      db.select.mockReturnValueOnce(mockDbChain([{ progress: 0.5 }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);

      await service.updateProgress(1, 0.5);

      const setArgs = (chain.set as Mock).mock.calls[0]![0] as Record<string, unknown>;
      expect(setArgs).not.toHaveProperty('progressUpdatedAt');
    });
  });

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

    it('combines section with pagination, windowing the data query but not the count', async () => {
      const countChain = mockDbChain([{ value: 20 }]);
      const dataChain = mockDbChain([{ download: mockDownload, book: mockBook }]);
      db.select.mockReturnValueOnce(countChain).mockReturnValueOnce(dataChain);

      const result = await service.getAll(undefined, { limit: 10, offset: 5 }, 'queue');

      expect(result.total).toBe(20);
      expect(result.data).toHaveLength(1);
      expect(dataChain.limit).toHaveBeenCalledWith(10);
      expect(dataChain.offset).toHaveBeenCalledWith(5);
      expect(countChain.limit).not.toHaveBeenCalled();
      expect(countChain.offset).not.toHaveBeenCalled();
    });
  });


  describe('delete — history guard', () => {
    it('succeeds and returns true when status is completed', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'idle' }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });

    it('succeeds and returns true when status is imported', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', pipelineStage: 'imported' }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });

    it('succeeds and returns true when status is failed', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'failed', pipelineStage: 'idle' }, book: mockBook }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });

    it.each(['downloading', 'queued', 'paused', 'checking', 'pending_review', 'importing'] as const)(
      'throws when status is %s',
      async (status) => {
        db.select.mockReturnValue(
          mockDbChain([{ download: { ...mockDownload, status }, book: mockBook }]),
        );

        await expect(service.delete(1)).rejects.toThrow();
        expect(db.delete).not.toHaveBeenCalled();
      },
    );

    it('throws DownloadError with code INVALID_STATUS for non-terminal status (not a plain Error)', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, clientStatus: 'downloading', pipelineStage: 'idle' }, book: mockBook }]),
      );

      const error = await service.delete(1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadError);
      expect((error as DownloadError).code).toBe('INVALID_STATUS');
    });

    it('returns false when id does not exist', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.delete(999);
      expect(result).toBe(false);
    });

    it('succeeds for orphaned download (bookId = null)', async () => {
      db.select.mockReturnValue(
        mockDbChain([{ download: { ...mockDownload, bookId: null, clientStatus: 'completed', pipelineStage: 'idle' }, book: null }]),
      );
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });
  });

  describe('deleteHistory', () => {
    it('deletes all terminal-status downloads and returns exact count', async () => {
      const deleted = [{ id: 1 }, { id: 2 }, { id: 3 }];
      db.delete.mockReturnValue(mockDbChain(deleted));

      const result = await service.deleteHistory();
      expect(result).toEqual({ deleted: 3 });
    });

    it('returns { deleted: 0 } when no history items exist', async () => {
      db.delete.mockReturnValue(mockDbChain([]));

      const result = await service.deleteHistory();
      expect(result).toEqual({ deleted: 0 });
    });

    it('filters deletes to terminal statuses via getTerminalStatuses()', async () => {
      const chain = mockDbChain([]);
      db.delete.mockReturnValue(chain);

      const spy = vi.spyOn(statusRegistry, 'getTerminalStatuses');

      await service.deleteHistory();

      expect(spy).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalledOnce();
    });
  });

  describe('grab — duplicate download conflict (#1103: replaceExisting removed)', () => {
    let mockAdapter: { addDownload: ReturnType<typeof vi.fn>; removeDownload: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-new'),
        removeDownload: vi.fn().mockResolvedValue(undefined),
      };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
    });

    // Duplicate checks read raw download rows, then auto-import jobs, before aggregate classification (#1861).
    it('throws DuplicateDownloadError with code ACTIVE_DOWNLOAD_EXISTS when replaceable active download exists', async () => {
      const replaceableDownload = { ...mockDownload, id: 5, clientStatus: 'queued' as const, pipelineStage: 'idle' as const };
      db.select.mockReturnValueOnce(mockDbChain([replaceableDownload]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('ACTIVE_DOWNLOAD_EXISTS');
      expect((err as DuplicateDownloadError).details).toEqual({ active: { title: replaceableDownload.title, count: 1 } });
      expect(db.insert).not.toHaveBeenCalled();
      expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
    });

    it('throws DuplicateDownloadError with PIPELINE_ACTIVE code when only importing downloads exist', async () => {
      const pipelineDownload = { ...mockDownload, id: 5, clientStatus: 'completed' as const, pipelineStage: 'importing' as const };
      db.select.mockReturnValueOnce(mockDbChain([pipelineDownload]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect((err as DuplicateDownloadError).details).toEqual({ reason: 'processing' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('throws DuplicateDownloadError with code ACTIVE_DOWNLOAD_EXISTS for replaceable-active duplicate', async () => {
      const replaceableDownload = { ...mockDownload, id: 5, clientStatus: 'queued' as const, pipelineStage: 'idle' as const };
      db.select.mockReturnValueOnce(mockDbChain([replaceableDownload]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('ACTIVE_DOWNLOAD_EXISTS');
      expect((err as DuplicateDownloadError).name).toBe('DuplicateDownloadError');
    });

    it('throws DuplicateDownloadError with code PIPELINE_ACTIVE for pipeline-active duplicate', async () => {
      const pipelineDownload = { ...mockDownload, id: 5, clientStatus: 'completed' as const, pipelineStage: 'importing' as const };
      db.select.mockReturnValueOnce(mockDbChain([pipelineDownload]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect((err as DuplicateDownloadError).name).toBe('DuplicateDownloadError');
    });

    it('throws PIPELINE_ACTIVE (not ACTIVE_DOWNLOAD_EXISTS) for a checking-stage active row', async () => {
      const checkingRow = { ...mockDownload, id: 5, clientStatus: 'completed' as const, pipelineStage: 'checking' as const };
      db.select.mockReturnValueOnce(mockDbChain([checkingRow]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
    });

    it('throws PIPELINE_ACTIVE (not admitted) for a QG-eligible completed row — closes the dupe window (#1861)', async () => {
      // A completed row with externalId remains QG-eligible and must block a second live download.
      const qgRow = { ...mockDownload, id: 5, clientStatus: 'completed' as const, pipelineStage: 'idle' as const, externalId: 'ext-tracked' };
      db.select.mockReturnValueOnce(mockDbChain([qgRow]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('admits the grab (clear) for a Blackhole handoff completed row (externalId null) — unchanged', async () => {
      const blackholeRow = { ...mockDownload, id: 5, clientStatus: 'completed' as const, pipelineStage: 'idle' as const, externalId: null };
      db.select.mockReturnValueOnce(mockDbChain([blackholeRow]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.insert.mockReturnValue(mockDbChain([{ id: 7 }]));
      db.select.mockReturnValue(mockDbChain([{ download: { ...mockDownload, id: 7 }, book: mockBook }]));

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      });

      expect(result.id).toBe(7);
      expect(db.insert).toHaveBeenCalled();
    });

    it('throws PIPELINE_ACTIVE when no active downloads but a pending auto import job exists for the same book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const importJobsChain = mockDbChain([{ id: 77 }]);
      db.select.mockReturnValueOnce(importJobsChain);

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect(db.insert).not.toHaveBeenCalled();

      expect(importJobsChain.where).toHaveBeenCalledOnce();
      const whereArg = (importJobsChain.where as Mock).mock.calls[0]![0];
      const { sql, params } = toSQL(whereArg);
      expect(sql).toContain('"book_id" = ?');
      expect(sql).toContain('"type" = ?');
      expect(sql).toMatch(/"status" in \(\?, \?\)/i);
      expect(params).toEqual([1, 'auto', 'pending', 'processing']);
    });

    it('throws PIPELINE_ACTIVE when a processing auto import job exists for the same book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const importJobsChain = mockDbChain([{ id: 88 }]);
      db.select.mockReturnValueOnce(importJobsChain);

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 42,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect(db.insert).not.toHaveBeenCalled();

      const whereArg = (importJobsChain.where as Mock).mock.calls[0]![0];
      const { sql, params } = toSQL(whereArg);
      expect(sql).toMatch(/"status" in \(\?, \?\)/i);
      expect(params).toEqual([42, 'auto', 'pending', 'processing']);
    });

    // Mixed blockers prove aggregate classification gives PIPELINE_ACTIVE precedence over replaceable rows (#1861).
    it('throws PIPELINE_ACTIVE (not ACTIVE_DOWNLOAD_EXISTS) when a replaceable row AND a pipeline row both exist', async () => {
      const replaceableRow = { ...mockDownload, id: 5, clientStatus: 'queued' as const, pipelineStage: 'idle' as const };
      const pipelineRow = { ...mockDownload, id: 6, clientStatus: 'completed' as const, pipelineStage: 'importing' as const };
      db.select.mockReturnValueOnce(mockDbChain([replaceableRow, pipelineRow]));
      db.select.mockReturnValueOnce(mockDbChain([]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('throws PIPELINE_ACTIVE (not ACTIVE_DOWNLOAD_EXISTS) when a replaceable row AND a pending auto job both exist', async () => {
      const replaceableRow = { ...mockDownload, id: 5, clientStatus: 'queued' as const, pipelineStage: 'idle' as const };
      db.select.mockReturnValueOnce(mockDbChain([replaceableRow]));
      db.select.mockReturnValueOnce(mockDbChain([{ id: 91 }]));

      const err = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DuplicateDownloadError);
      expect((err as DuplicateDownloadError).code).toBe('PIPELINE_ACTIVE');
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('proceeds when no active downloads and no pending auto import jobs exist for the book', async () => {
      db.select.mockReturnValueOnce(mockDbChain([]));
      const importJobsChain = mockDbChain([]);
      db.select.mockReturnValueOnce(importJobsChain);
      db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));
      db.insert.mockReturnValue(mockDbChain([{ id: 10 }]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:0000000000000000000000000000000000000abc',
        title: 'Test',
        bookId: 1,
      });

      expect(result).toBeDefined();
      expect(db.insert).toHaveBeenCalledTimes(1);

      // Even an empty result must use the scoped import-job predicate.
      const whereArg = (importJobsChain.where as Mock).mock.calls[0]![0];
      const { sql, params } = toSQL(whereArg);
      expect(sql).toContain('"book_id" = ?');
      expect(sql).toContain('"type" = ?');
      expect(sql).toMatch(/"status" in \(\?, \?\)/i);
      expect(params).toEqual([1, 'auto', 'pending', 'processing']);
    });

  });

  describe('cancel — reason param', () => {
    it('sets errorMessage to custom reason when reason param provided', async () => {
      const mockAdapter = { removeDownload: vi.fn().mockResolvedValue(undefined) };
      db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      await service.cancel(1, 'Replaced by new download');

      expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
        clientStatus: 'failed',        errorMessage: 'Replaced by new download',
      }));
    });

    it('defaults errorMessage to "Cancelled by user" when no reason provided', async () => {
      const mockAdapter = { removeDownload: vi.fn().mockResolvedValue(undefined) };
      db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));
      const chain = mockDbChain();
      db.update.mockReturnValue(chain);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      await service.cancel(1);

      expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
        clientStatus: 'failed',        errorMessage: 'Cancelled by user',
      }));
    });
  });

  describe('indexer name projection (#57)', () => {
    const mockIndexer = createMockDbIndexer();
    const mockDownloadNoIndexer = { ...mockDownload, indexerId: null };

    describe('getAll', () => {
      it('returns indexerName for downloads with an existing indexer', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
          .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook, indexer: mockIndexer }]));

        const result = await service.getAll();
        expect(result.data[0]!.indexerName).toBe('AudioBookBay');
      });

      it('returns null indexerName for downloads whose indexer was deleted (null FK)', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
          .mockReturnValueOnce(mockDbChain([{ download: mockDownloadNoIndexer, book: mockBook, indexer: null }]));

        const result = await service.getAll();
        expect(result.data[0]!.indexerName).toBeNull();
      });

      it('handles mixed batch: some downloads with indexer, some without', async () => {
        db.select
          .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
          .mockReturnValueOnce(mockDbChain([
            { download: mockDownload, book: mockBook, indexer: mockIndexer },
            { download: mockDownloadNoIndexer, book: mockBook, indexer: null },
          ]));

        const result = await service.getAll();
        expect(result.data[0]!.indexerName).toBe('AudioBookBay');
        expect(result.data[1]!.indexerName).toBeNull();
      });
    });

    describe('getById', () => {
      it('returns indexerName for downloads with an existing indexer', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownload, book: mockBook, indexer: mockIndexer }]),
        );

        const result = await service.getById(1);
        expect(result?.indexerName).toBe('AudioBookBay');
      });

      it('returns null indexerName for deleted-indexer case', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownloadNoIndexer, book: null, indexer: null }]),
        );

        const result = await service.getById(1);
        expect(result?.indexerName).toBeNull();
      });
    });

    describe('getActive', () => {
      it('returns indexerName for downloads with an existing indexer', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownload, book: mockBook, indexer: mockIndexer }]),
        );

        const result = await service.getActive();
        expect(result[0]!.indexerName).toBe('AudioBookBay');
      });

      it('returns null indexerName for deleted-indexer case', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownloadNoIndexer, book: null, indexer: null }]),
        );

        const result = await service.getActive();
        expect(result[0]!.indexerName).toBeNull();
      });
    });

    describe('getActiveByBookId', () => {
      it('returns indexerName for downloads with an existing indexer', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownload, book: mockBook, indexer: mockIndexer }]),
        );

        const result = await service.getActiveByBookId(1);
        expect(result[0]!.indexerName).toBe('AudioBookBay');
      });

      it('returns null indexerName for deleted-indexer case', async () => {
        db.select.mockReturnValue(
          mockDbChain([{ download: mockDownloadNoIndexer, book: mockBook, indexer: null }]),
        );

        const result = await service.getActiveByBookId(1);
        expect(result[0]!.indexerName).toBeNull();
      });
    });
  });

  // #2341: an adapter that can stage has no control channel to compensate through, so the grab
  // path publishes after the row instead of before it. Absence of the hook is the discriminator.
  describe('staged-handoff capability dispatch', () => {
    const MAGNET_URL = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

    function stagingAdapter(over?: Record<string, unknown>) {
      return {
        stageDownload: vi.fn().mockResolvedValue({ commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) }),
        addDownload: vi.fn().mockResolvedValue('ext-should-not-be-used'),
        removeDownload: vi.fn(),
        ...over,
      };
    }

    function primeGrab(adapter: unknown, client?: Record<string, unknown>) {
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'Blackhole', type: 'blackhole', settings: {}, ...client });
      (clientService.getAdapter as Mock).mockResolvedValue(adapter);
      const valuesSpy = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 1 }]) });
      db.insert.mockReturnValue({ values: valuesSpy } as never);
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([{ download: { ...mockDownload, clientStatus: 'completed', externalId: null }, book: mockBook }]));
      return valuesSpy;
    }

    const grab = () => service.grab({ downloadUrl: MAGNET_URL, title: 'Test', skipDuplicateCheck: true });

    it('stages the artifact, never adds it, and records no external id', async () => {
      const adapter = stagingAdapter();
      const valuesSpy = primeGrab(adapter);

      await grab();

      expect(adapter.stageDownload).toHaveBeenCalledTimes(1);
      expect(adapter.stageDownload.mock.calls[0]![0]).toMatchObject({ type: 'magnet-uri' });
      expect(adapter.addDownload).not.toHaveBeenCalled();
      expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ externalId: null }));
    });

    it('publishes the staged artifact once the record has landed', async () => {
      const handoff = { commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
      const adapter = stagingAdapter({ stageDownload: vi.fn().mockResolvedValue(handoff) });
      primeGrab(adapter);

      await grab();

      expect(handoff.commit).toHaveBeenCalledTimes(1);
      expect(handoff.abort).not.toHaveBeenCalled();
    });

    it('hands staging the same category options addDownload would have received', async () => {
      const adapter = stagingAdapter();
      primeGrab(adapter, { settings: { category: 'audiobooks' } });

      await grab();

      expect(adapter.stageDownload).toHaveBeenCalledWith(expect.anything(), { category: 'audiobooks' });
    });

    it('adds exactly as before when the adapter cannot stage', async () => {
      const adapter = { addDownload: vi.fn().mockResolvedValue('ext-123'), removeDownload: vi.fn() };
      const valuesSpy = primeGrab(adapter);

      await grab();

      expect(adapter.addDownload).toHaveBeenCalledWith(expect.objectContaining({ type: 'magnet-uri' }), undefined);
      expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'ext-123' }));
    });

    it('rejects the grab and inserts no partial row when staging fails', async () => {
      const adapter = stagingAdapter({ stageDownload: vi.fn().mockRejectedValue(new Error('ENOSPC')) });
      primeGrab(adapter);

      await expect(grab()).rejects.toThrow('ENOSPC');

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('reports staging as staged rather than sent, so a failed publish cannot leave a delivery claim', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      primeGrab(stagingAdapter());

      await svc.grab({ downloadUrl: MAGNET_URL, title: 'Test', skipDuplicateCheck: true });

      expect(log.debug).not.toHaveBeenCalledWith(expect.anything(), 'Download sent to client');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ clientName: 'Blackhole' }),
        expect.stringContaining('staged'),
      );
    });

    it('claims no delivery at all when the publish fails after the record landed', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      const handoff = { commit: vi.fn().mockRejectedValue(new Error('EXDEV')), abort: vi.fn().mockResolvedValue(undefined) };
      primeGrab(stagingAdapter({ stageDownload: vi.fn().mockResolvedValue(handoff) }));

      await expect(svc.grab({ downloadUrl: MAGNET_URL, title: 'Test', skipDuplicateCheck: true })).rejects.toThrow('EXDEV');

      expect(log.debug).not.toHaveBeenCalledWith(expect.anything(), 'Download sent to client');
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Download initiated');
    });
  });

  describe('logging improvements (#229)', () => {
    it('addDownload success logged at debug with { externalId, clientName, bookId }', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));

      const mockAdapter = {
        addDownload: vi.fn().mockResolvedValue('ext-123'),
        removeDownload: vi.fn(),
      };
      const enabledClient = { id: 1, name: 'qBit', type: 'qbittorrent', enabled: true, settings: {} };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue(enabledClient);
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);

      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([]));
      db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: mockBook }]));

      await svc.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'The Way of Kings',
        bookId: 1,
      });

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-123', clientName: 'qBit', bookId: 1 }),
        'Download sent to client',
      );
    });
  });

  describe('required-wiring contract', () => {
    it('wire() called twice throws ServiceWireError', () => {
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(createMockLogger()));
      const deps = { retrySearchDeps: {} as never, indexerService: { getAll: vi.fn().mockResolvedValue([]) } as never };
      svc.wire(deps);
      expect(() => svc.wire(deps)).toThrow(/DownloadService\.wire\(\) called more than once/);
    });
  });

  describe('#1156 — resolveDownloadUrl adapter hook', () => {
    function makeIndexerServiceMock(adapter: { resolveDownloadUrl?: ReturnType<typeof vi.fn> }) {
      return {
        getById: vi.fn().mockResolvedValue({ id: 1, name: 'MAM', type: 'myanonamouse', settings: {} } as never),
        getAdapter: vi.fn().mockResolvedValue(adapter as never),
        getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set(), hostname: new Set() }),
        getAll: vi.fn().mockResolvedValue([]),
      };
    }

    function setupGrabHappyPath(svc: DownloadService) {
      const mockAdapter = { addDownload: vi.fn().mockResolvedValue('ext-1') };
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });
      (clientService.getAdapter as Mock).mockResolvedValue(mockAdapter);
      db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
      db.update.mockReturnValue(mockDbChain());
      db.select.mockReturnValue(mockDbChain([{ download: mockDownload, book: mockBook }]));
      return { mockAdapter, svc };
    }

    it('invokes adapter.resolveDownloadUrl with explicit ctx including isFreeleech coerced from params', async () => {
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', wedgeRequested: false }) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(service);

      await service.grab({
        downloadUrl: 'mam-torrent://12345',
        title: 'Test',
        indexerId: 1,
        guid: '12345',
        protocol: 'torrent',
        isFreeleech: true,
        skipDuplicateCheck: true,
      });

      expect(indexerAdapter.resolveDownloadUrl).toHaveBeenCalledTimes(1);
      const ctx = (indexerAdapter.resolveDownloadUrl as Mock).mock.calls[0]![0];
      expect(ctx).toMatchObject({
        guid: '12345',
        downloadUrl: 'mam-torrent://12345',
        protocol: 'torrent',
        isFreeleech: true,
      });
    });

    it('coerces missing/undefined isFreeleech to false in ctx', async () => {
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d' }) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(service);

      await service.grab({
        downloadUrl: 'mam-torrent://12345',
        title: 'Test',
        indexerId: 1,
        guid: '12345',
        skipDuplicateCheck: true,
      });

      const ctx = (indexerAdapter.resolveDownloadUrl as Mock).mock.calls[0]![0];
      expect(ctx.isFreeleech).toBe(false);
    });

    it('replaces params.downloadUrl with the hook-returned URL for the rest of the pipeline', async () => {
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'magnet:?xt=urn:btih:bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434d' }) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(service);

      await service.grab({
        downloadUrl: 'mam-torrent://12345',
        title: 'Test',
        indexerId: 1,
        skipDuplicateCheck: true,
      });

      const insertCall = (db.insert.mock.results[0]!.value as ReturnType<typeof mockDbChain>).values.mock.calls[0]![0];
      expect(insertCall.downloadUrl).toBe('magnet:?xt=urn:btih:bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('skips the hook entirely when indexerId is not provided', async () => {
      const indexerAdapter = { resolveDownloadUrl: vi.fn() };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(service);

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test',
        skipDuplicateCheck: true,
      });

      expect(indexerAdapter.resolveDownloadUrl).not.toHaveBeenCalled();
    });

    it('passes through params.downloadUrl unchanged when adapter does not implement resolveDownloadUrl', async () => {
      const indexerAdapter = {};
      const indexerService = makeIndexerServiceMock(indexerAdapter as never);
      service.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(service);

      await service.grab({
        downloadUrl: 'magnet:?xt=urn:btih:ccf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
        title: 'Test',
        indexerId: 1,
        skipDuplicateCheck: true,
      });

      const insertCall = (db.insert.mock.results[0]!.value as ReturnType<typeof mockDbChain>).values.mock.calls[0]![0];
      expect(insertCall.downloadUrl).toBe('magnet:?xt=urn:btih:ccf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });

    it('emits a debug "&fl sent" log and no info/warn when wedgeRequested is true', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', wedgeRequested: true }) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      svc.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(svc);

      await svc.grab({
        downloadUrl: 'mam-torrent://12345',
        title: 'Book',
        indexerId: 1,
        skipDuplicateCheck: true,
      });

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ wedgeRequested: true }),
        expect.stringMatching(/wedge requested.*&fl sent/i),
      );
      expect(log.info).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/wedge/i),
      );
    });

    it('emits nothing wedge-specific when wedgeRequested is false', async () => {
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', wedgeRequested: false }) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      svc.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      setupGrabHappyPath(svc);

      await svc.grab({
        downloadUrl: 'mam-torrent://12345',
        title: 'Book',
        indexerId: 1,
        skipDuplicateCheck: true,
      });

      const wedgeDebug = (log.debug as Mock).mock.calls.find(c => /wedge requested/i.test(String(c[1])));
      expect(wedgeDebug).toBeUndefined();
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/wedge/i),
      );
    });

    it('thrown IndexerError emits warn-level log', async () => {
      const { IndexerError } = await import('@core/index.js');
      const log = createMockLogger();
      const svc = new DownloadService(inject<Db>(db), clientService, inject<FastifyBaseLogger>(log));
      const err = new IndexerError('MAM', 'torrent fetch failed');
      const indexerAdapter = { resolveDownloadUrl: vi.fn().mockRejectedValue(err) };
      const indexerService = makeIndexerServiceMock(indexerAdapter);
      svc.wire({ retrySearchDeps: {} as never, indexerService: indexerService as never });
      (clientService.getFirstEnabledForProtocol as Mock).mockResolvedValue({ id: 1, name: 'qBit' });

      await expect(
        svc.grab({
          downloadUrl: 'mam-torrent://12345',
          title: 'Book',
          indexerId: 1,
          skipDuplicateCheck: true,
        }),
      ).rejects.toBeInstanceOf(IndexerError);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'torrent fetch failed' }),
        expect.stringMatching(/resolveDownloadUrl failed/i),
      );
    });
  });
});

// These schema-less responses require runtime removal of userClearedFields; assert key presence, not value (#2069).
describe('DownloadService — user_cleared_fields is projected out (#2069 AC16)', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: DownloadService;

  const seededBook = createMockDbBook({ userClearedFields: '["genres"]' });

  beforeEach(() => {
    db = createMockDb();
    service = new DownloadService(
      inject<Db>(db),
      createMockDownloadClientService(),
      inject<FastifyBaseLogger>(createMockLogger()),
    );
  });

  it('getAll: the joined book carries no userClearedFields key', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([{ value: 1 }]))
      .mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: seededBook }]));

    const { data } = await service.getAll();

    expect(data[0]!.book).toBeDefined();
    expect('userClearedFields' in data[0]!.book!).toBe(false);
    expect(JSON.stringify(data[0])).not.toContain('userClearedFields');
  });

  it('getById: the joined book carries no userClearedFields key', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: seededBook }]));

    const row = await service.getById(1);

    expect('userClearedFields' in row!.book!).toBe(false);
  });

  it('getActive: the joined book carries no userClearedFields key', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: seededBook }]));

    const rows = await service.getActive();

    expect('userClearedFields' in rows[0]!.book!).toBe(false);
  });

  it('getActiveByBookId: the joined book carries no userClearedFields key', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: seededBook }]));

    const rows = await service.getActiveByBookId(1);

    expect('userClearedFields' in rows[0]!.book!).toBe(false);
  });

  it('preserves every other book column while stripping only that one', async () => {
    db.select.mockReturnValueOnce(mockDbChain([{ download: mockDownload, book: seededBook }]));

    const row = await service.getById(1);

    expect(row!.book!.title).toBe(seededBook.title);
    expect(row!.book!.id).toBe(seededBook.id);
  });
});
