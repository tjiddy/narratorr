import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { IndexerService } from './indexer.service.js';

const now = new Date();

const mockIndexer = {
  id: 1,
  name: 'AudioBookBay',
  type: 'abb' as const,
  enabled: true,
  priority: 50,
  settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
  createdAt: now,
};

describe('IndexerService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: IndexerService;

  beforeEach(() => {
    db = createMockDb();
    service = new IndexerService(db as any, createMockLogger() as any);
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
      const badIndexer = { ...mockIndexer, type: 'unknown' as any };

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
      // testConfig creates a real ABB adapter, so we just verify it doesn't throw for valid type
      // The actual adapter.test() would make a network call, but we can test the error path
      const result = await service.testConfig({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
      });
      // Will fail since no real network, but should return a result (not throw)
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
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
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as any);

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
        .mockResolvedValueOnce(errorAdapter as any)
        .mockResolvedValueOnce(goodAdapter as any);

      const results = await service.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Book');
    });
  });
});
