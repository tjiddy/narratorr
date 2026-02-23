import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

const mockIndexer = createMockDbIndexer();

describe('IndexerService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: IndexerService;

  beforeEach(() => {
    db = createMockDb();
    service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('getAll', () => {
    it('returns all indexers', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('AudioBookBay');
    });
  });

  describe('getById', () => {
    it('returns indexer when found', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('AudioBookBay');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts and returns new indexer', async () => {
      db.insert.mockReturnValue(mockDbChain([mockIndexer]));

      const result = await service.create({
        name: 'AudioBookBay',
        type: 'abb',
        enabled: true,
        priority: 50,
        settings: { hostname: 'audiobookbay.lu' },
      });

      expect(result.name).toBe('AudioBookBay');
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('updates and returns indexer', async () => {
      const updated = { ...mockIndexer, name: 'ABB Updated' };
      db.update.mockReturnValue(mockDbChain([updated]));

      const result = await service.update(1, { name: 'ABB Updated' });
      expect(result).not.toBeNull();
      expect(result!.name).toBe('ABB Updated');
    });

    it('clears adapter cache on update', async () => {
      // First, populate the cache by calling getAdapter
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const adapter1 = await service.getAdapter(mockIndexer);

      // Update should clear the cache
      db.update.mockReturnValue(mockDbChain([mockIndexer]));
      await service.update(1, { name: 'Changed' });

      // Next getAdapter should create a new adapter (not return cached)
      const adapter2 = await service.getAdapter(mockIndexer);
      expect(adapter2).not.toBe(adapter1);
    });

    it('returns null when indexer not found', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(999, { name: 'Nope' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when indexer exists', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
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

  describe('getAdapter', () => {
    it('creates ABB adapter from config', async () => {
      const adapter = await service.getAdapter(mockIndexer);

      expect(adapter.type).toBe('abb');
      expect(adapter.name).toBe('AudioBookBay');
    });

    it('caches adapter instances', async () => {
      const adapter1 = await service.getAdapter(mockIndexer);
      const adapter2 = await service.getAdapter(mockIndexer);

      expect(adapter1).toBe(adapter2);
    });

    it('throws for unknown indexer type', async () => {
      const badIndexer = { ...mockIndexer, type: 'unknown' as never };

      await expect(service.getAdapter(badIndexer)).rejects.toThrow('Unknown indexer type');
    });
  });

  describe('test', () => {
    it('returns failure when indexer not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.test(999);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Indexer not found');
    });
  });

  describe('testConfig', () => {
    it('creates adapter from config and returns test result', async () => {
      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      vi.spyOn(service as never, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
      });
      expect(result.success).toBe(true);
      expect(result.message).toBe('OK');
    });

    it('returns failure for unknown type', async () => {
      const result = await service.testConfig({
        type: 'unknown',
        settings: {},
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown indexer type');
    });
  });

  describe('searchAll', () => {
    it('searches enabled indexers and aggregates results', async () => {
      const mockResult = {
        title: 'The Way of Kings',
        indexer: 'AudioBookBay',
        protocol: 'torrent' as const,
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
      };

      // Mock the DB query for enabled indexers
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      // We need to mock the adapter's search method
      // Since getAdapter creates a real ABB adapter, we spy on the service
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([mockResult]),
        test: vi.fn(),
      };

      // Override getAdapter to return our mock
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('continues searching when one indexer errors', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const errorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('Connection failed')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'Indexer2' }]),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await service.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Book');
    });

    it('returns empty array when all indexers fail', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const errorAdapter1 = {
        search: vi.fn().mockRejectedValue(new Error('Timeout')),
        test: vi.fn(),
      };
      const errorAdapter2 = {
        search: vi.fn().mockRejectedValue(new Error('DNS failure')),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter1 as never)
        .mockResolvedValueOnce(errorAdapter2 as never);

      const results = await service.searchAll('test');
      expect(results).toEqual([]);
    });

    it('returns empty array when no enabled indexers', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const results = await service.searchAll('test');
      expect(results).toEqual([]);
    });

    it('returns partial results when one succeeds and one fails', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const goodAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Book A', indexer: 'ABB' },
          { title: 'Book B', indexer: 'ABB' },
        ]),
        test: vi.fn(),
      };
      const errorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('Network error')),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(goodAdapter as never)
        .mockResolvedValueOnce(errorAdapter as never);

      const results = await service.searchAll('test');
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Book A');
      expect(results[1].title).toBe('Book B');
    });
  });

  describe('release name parsing integration', () => {
    it('populates author and title from parsed release name on torznab results', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson');
      expect(results[0].author).toBe('Brandon Sanderson');
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('sets rawTitle to original indexer title before parsing', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson');
      expect(results[0].rawTitle).toBe('Brandon Sanderson - The Way of Kings');
    });

    it('does not overwrite author when adapter already set it (ABB case)', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'The Way of Kings', author: 'Brandon Sanderson', indexer: 'ABB', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson');
      expect(results[0].author).toBe('Brandon Sanderson');
      expect(results[0].rawTitle).toBeUndefined();
    });

    it('uses cleaned title even when parsing extracts no author', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Some Random Title', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('random');
      // Title unchanged by parser, so rawTitle is not set
      expect(results[0].title).toBe('Some Random Title');
      expect(results[0].author).toBeUndefined();
      expect(results[0].rawTitle).toBeUndefined();
    });

    it('sets rawTitle and cleans title when parser strips noise without extracting author', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Some Random Title [MP3] [ENG]', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('random');
      expect(results[0].title).toBe('Some Random Title');
      expect(results[0].rawTitle).toBe('Some Random Title [MP3] [ENG]');
      expect(results[0].author).toBeUndefined();
    });

    it('logs unparsed non-hash release names at debug level', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Some Random Title', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await svc.searchAll('random');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ rawTitle: 'Some Random Title' }),
        'Unparsed release name',
      );
    });
  });

  describe('fuzzy scoring', () => {
    it('sets matchScore on results when title context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson', { title: 'The Way of Kings', author: 'Brandon Sanderson' });
      expect(results[0].matchScore).toBeDefined();
      expect(results[0].matchScore).toBeGreaterThan(0.5);
    });

    it('sorts results by matchScore descending when context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Completely Wrong Book', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson', { title: 'The Way of Kings' });
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('does not score or sort when no context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Book B', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Book A', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('books');
      expect(results[0].matchScore).toBeUndefined();
      expect(results[0].title).toBe('Book B'); // order preserved
    });
  });

  describe('test edge cases', () => {
    it('catches adapter.test() throwing and returns failure', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const mockAdapter = { test: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')), search: vi.fn() };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('ECONNREFUSED');
    });

    it('returns "Unknown error" for non-Error thrown values', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const mockAdapter = { test: vi.fn().mockRejectedValue('string thrown'), search: vi.fn() };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unknown error');
    });
  });
});
