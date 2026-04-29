import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { SettingsService } from './settings.service.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockIndexer = createMockDbIndexer();

describe('IndexerService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: IndexerService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
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

    it('preserves existing encrypted secret fields when sentinel values are submitted', async () => {
      const { encrypt } = await import('../utils/secret-codec.js');
      const encryptedApiKey = encrypt('real-api-key', TEST_KEY);
      const encryptedApiUrl = encrypt('http://user:pw@prowlarr:9696/1/', TEST_KEY);
      const encryptedFlareSolverrUrl = encrypt('http://flaresolverr:8191', TEST_KEY);
      const existingRow = {
        ...mockIndexer,
        settings: { apiKey: encryptedApiKey, apiUrl: encryptedApiUrl, hostname: 'old-host', flareSolverrUrl: encryptedFlareSolverrUrl },
      };

      // Sentinel lookup returns existing row
      db.select.mockReturnValue(mockDbChain([existingRow]));
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      await service.update(1, {
        settings: { apiKey: '********', apiUrl: '********', hostname: 'new-host', flareSolverrUrl: '********' },
      });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(setArg.settings.hostname).toBe('new-host');
      // Secret fields must be exactly the stored ciphertext, not re-encrypted sentinels
      expect(setArg.settings.apiKey).toBe(encryptedApiKey);
      expect(setArg.settings.apiUrl).toBe(encryptedApiUrl);
      expect(setArg.settings.flareSolverrUrl).toBe(encryptedFlareSolverrUrl);
    });

    it('encrypts a freshly-supplied apiUrl on create (#742)', async () => {
      const insertChain = mockDbChain([mockIndexer]);
      db.insert.mockReturnValue(insertChain);

      await service.create({
        name: 'Tracker',
        type: 'torznab',
        enabled: true,
        priority: 50,
        settings: { apiUrl: 'http://user:pw@host/1/', apiKey: 'plain' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0] as { settings: Record<string, string> };
      expect(isEncrypted(valuesArg.settings.apiUrl)).toBe(true);
      expect(isEncrypted(valuesArg.settings.apiKey)).toBe(true);
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

    it('#317 persists isVip metadata on successful MAM test', async () => {
      const mamIndexer = createMockDbIndexer({
        id: 5, type: 'myanonamouse',
        settings: { mamId: 'test-id', searchLanguages: [1], searchType: 'active' },
      });
      db.select.mockReturnValue(mockDbChain([mamIndexer]));

      const mockAdapter = {
        test: vi.fn().mockResolvedValue({ success: true, message: 'Connected as VipUser', metadata: { username: 'VipUser', classname: 'VIP', isVip: true } }),
        search: vi.fn(),
        type: 'myanonamouse',
        name: 'MyAnonamouse',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);

      const result = await service.test(5);
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ username: 'VipUser', classname: 'VIP', isVip: true });
      expect(updateSpy).toHaveBeenCalledWith(5, {
        settings: { mamId: 'test-id', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
      });
    });

    it('#317 does not persist metadata on failed test', async () => {
      const mamIndexer = createMockDbIndexer({
        id: 5, type: 'myanonamouse',
        settings: { mamId: 'bad-id', searchLanguages: [1], searchType: 'active' },
      });
      db.select.mockReturnValue(mockDbChain([mamIndexer]));

      const mockAdapter = {
        test: vi.fn().mockResolvedValue({ success: false, message: 'Auth failed' }),
        search: vi.fn(),
        type: 'myanonamouse',
        name: 'MyAnonamouse',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update');

      const result = await service.test(5);
      expect(result.success).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('#317 returns test result even if metadata persistence fails', async () => {
      const mamIndexer = createMockDbIndexer({
        id: 5, type: 'myanonamouse',
        settings: { mamId: 'test-id', searchLanguages: [1], searchType: 'active' },
      });
      db.select.mockReturnValue(mockDbChain([mamIndexer]));

      const mockAdapter = {
        test: vi.fn().mockResolvedValue({ success: true, message: 'Connected', metadata: { isVip: false } }),
        search: vi.fn(),
        type: 'myanonamouse',
        name: 'MyAnonamouse',
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'getAdapter').mockResolvedValue(mockAdapter as never);
      vi.spyOn(service, 'update').mockRejectedValue(new Error('DB error'));

      const result = await service.test(5);
      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected');
    });
  });

  describe('testConfig', () => {
    it('creates adapter from config and returns test result', async () => {
      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2 },
      });
      expect(result.success).toBe(true);
      expect(result.message).toBe('OK');
    });

    it('#339 resolves sentinel mamId against saved indexer when id is provided', async () => {
      const savedIndexer = createMockDbIndexer({
        id: 5,
        type: 'myanonamouse',
        settings: { mamId: 'real-mam-id', baseUrl: '' },
      });
      db.select.mockReturnValue(mockDbChain([savedIndexer]));

      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '' },
        id: 5,
      });

      expect(result.success).toBe(true);
      // Verify the adapter received the resolved (real) mamId, not the sentinel
      const fakeRow = createSpy.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(fakeRow.settings.mamId).toBe('real-mam-id');
    });

    it('#339 uses provided mamId directly when id is present but mamId is not sentinel', async () => {
      const savedIndexer = createMockDbIndexer({
        id: 5,
        type: 'myanonamouse',
        settings: { mamId: 'old-mam-id', baseUrl: '' },
      });
      db.select.mockReturnValue(mockDbChain([savedIndexer]));

      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'myanonamouse',
        settings: { mamId: 'new-mam-id', baseUrl: '' },
        id: 5,
      });

      expect(result.success).toBe(true);
      const fakeRow = createSpy.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(fakeRow.settings.mamId).toBe('new-mam-id');
    });

    it('#339 skips sentinel resolution when id is absent (create mode)', async () => {
      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '' },
      });

      expect(result.success).toBe(true);
      // Without id, sentinel passes through as-is (no resolution)
      const fakeRow = createSpy.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(fakeRow.settings.mamId).toBe('********');
      // getById should not have been called
      expect(db.select).not.toHaveBeenCalled();
    });

    it('#339 returns error when id is provided but indexer does not exist', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.testConfig({
        type: 'myanonamouse',
        settings: { mamId: '********', baseUrl: '' },
        id: 999,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
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

  describe('getRssCapableIndexers', () => {
    it('returns only newznab and torznab enabled indexers', async () => {
      const newznab = createMockDbIndexer({ id: 1, name: 'Newznab', type: 'newznab', enabled: true });
      const torznab = createMockDbIndexer({ id: 2, name: 'Torznab', type: 'torznab', enabled: true });
      const abb = createMockDbIndexer({ id: 3, name: 'ABB', type: 'abb', enabled: true });
      db.select.mockReturnValue(mockDbChain([newznab, torznab, abb]));

      const result = await service.getRssCapableIndexers();
      expect(result).toHaveLength(2);
      expect(result.map((i: { name: string }) => i.name)).toEqual(['Newznab', 'Torznab']);
    });

    it('returns empty array when no RSS-capable indexers are enabled', async () => {
      const abb = createMockDbIndexer({ id: 1, name: 'ABB', type: 'abb', enabled: true });
      db.select.mockReturnValue(mockDbChain([abb]));

      const result = await service.getRssCapableIndexers();
      expect(result).toEqual([]);
    });
  });

  describe('pollRss', () => {
    it('calls adapter.search with empty query and parses release names', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.pollRss(torznabIndexer);

      expect(mockAdapter.search).toHaveBeenCalledWith('');
      expect(results).toHaveLength(1);
      expect(results[0].author).toBe('Brandon Sanderson');
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('returns empty array when feed has no items', async () => {
      const newznabIndexer = createMockDbIndexer({ id: 1, name: 'Newznab', type: 'newznab', settings: { apiUrl: 'https://nzb.test', apiKey: 'key' } });
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.pollRss(newznabIndexer);
      expect(results).toEqual([]);
    });

    it('populates indexerId from indexer row on all returned results', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 7, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.pollRss(torznabIndexer);

      expect(results).toHaveLength(1);
      expect(results[0].indexerId).toBe(7);
    });

    it('populates indexerId on multiple results (all stamped, not just first)', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 3, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue([
          { title: 'Author A - Book One', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Author B - Book Two', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Author C - Book Three', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.pollRss(torznabIndexer);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.indexerId).toBe(3);
      }
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

    it('populates indexerId on results from the indexer row id', async () => {
      const mockResult = {
        title: 'The Way of Kings',
        indexer: 'AudioBookBay',
        protocol: 'torrent' as const,
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
      };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([mockResult]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('sanderson');
      expect(results[0].indexerId).toBe(mockIndexer.id);
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

  describe('FlareSolverr proxy support', () => {
    it('passes flareSolverrUrl to ABB adapter config', async () => {
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter');
      const proxyIndexer = createMockDbIndexer({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, flareSolverrUrl: 'http://proxy:8191' },
      });

      const adapter = await service.getAdapter(proxyIndexer);
      expect(adapter.type).toBe('abb');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ flareSolverrUrl: 'http://proxy:8191' }),
        }),
        undefined,
      );
    });

    it('passes flareSolverrUrl to torznab adapter config', async () => {
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter');
      const proxyIndexer = createMockDbIndexer({
        type: 'torznab',
        settings: { apiUrl: 'https://tracker.test', apiKey: 'key', flareSolverrUrl: 'http://proxy:8191' },
      });

      const adapter = await service.getAdapter(proxyIndexer);
      expect(adapter.type).toBe('torznab');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ flareSolverrUrl: 'http://proxy:8191' }),
        }),
        undefined,
      );
    });

    it('passes flareSolverrUrl to newznab adapter config', async () => {
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter');
      const proxyIndexer = createMockDbIndexer({
        type: 'newznab',
        settings: { apiUrl: 'https://nzb.test', apiKey: 'key', flareSolverrUrl: 'http://proxy:8191' },
      });

      const adapter = await service.getAdapter(proxyIndexer);
      expect(adapter.type).toBe('newznab');
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ flareSolverrUrl: 'http://proxy:8191' }),
        }),
        undefined,
      );
    });

    it('searchAll catches thrown proxy errors and continues to next indexer', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const proxyErrorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('FlareSolverr proxy unreachable at http://proxy:8191')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue([{ title: 'Found Book', indexer: 'Indexer2', protocol: 'torrent' }]),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(proxyErrorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await service.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Found Book');
    });

    it('testConfig passes flareSolverrUrl through settings', async () => {
      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, flareSolverrUrl: 'http://proxy:8191' },
      });
      expect(result.success).toBe(true);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ flareSolverrUrl: 'http://proxy:8191' }),
        }),
        undefined,
      );
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

    it('returns stringified value for non-Error thrown values', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const mockAdapter = { test: vi.fn().mockRejectedValue('string thrown'), search: vi.fn() };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('string thrown');
    });
  });

  describe('proxy integration', () => {
    let proxyDb: ReturnType<typeof createMockDb>;
    let proxyService: IndexerService;
    let mockSettingsService: ReturnType<typeof createMockSettingsService>;

    beforeEach(() => {
      proxyDb = createMockDb();
      mockSettingsService = createMockSettingsService({ network: { proxyUrl: 'socks5://proxy:1080' } });
      proxyService = new IndexerService(
        inject<Db>(proxyDb),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(mockSettingsService),
      );
    });

    it('createAdapter passes proxyUrl when indexer has useProxy true and global proxy is set', async () => {
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxyService as any, 'createAdapter');
      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });

      await proxyService.getAdapter(proxyIndexer);

      expect(createSpy).toHaveBeenCalledWith(proxyIndexer, 'socks5://proxy:1080');
    });

    it('createAdapter omits proxyUrl when indexer has useProxy false', async () => {
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxyService as any, 'createAdapter');
      const noProxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: false },
      });

      await proxyService.getAdapter(noProxyIndexer);

      // createAdapter is called with the proxyUrl from settings, but internally
      // it checks useProxy and passes undefined to the factory
      expect(createSpy).toHaveBeenCalledWith(noProxyIndexer, 'socks5://proxy:1080');
      // Verify the adapter was created without proxy by checking the factory wasn't given proxyUrl
      // We need to check the actual adapter creation — spy on INDEXER_ADAPTER_FACTORIES
      const { INDEXER_ADAPTER_FACTORIES } = await import('../../core/index.js');
      const factorySpy = vi.spyOn(INDEXER_ADAPTER_FACTORIES, 'abb');

      // Clear cache and create again
      proxyService.clearAdapterCache();
      await proxyService.getAdapter(noProxyIndexer);

      expect(factorySpy).toHaveBeenCalledWith(
        expect.objectContaining({ useProxy: false }),
        'AudioBookBay',
        undefined,
      );
      factorySpy.mockRestore();
    });

    it('createAdapter omits proxyUrl when useProxy true but no global proxy URL configured', async () => {
      mockSettingsService = createMockSettingsService({ network: { proxyUrl: '' } });
      proxyService = new IndexerService(
        inject<Db>(proxyDb),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(mockSettingsService),
      );
      const { INDEXER_ADAPTER_FACTORIES } = await import('../../core/index.js');
      const factorySpy = vi.spyOn(INDEXER_ADAPTER_FACTORIES, 'abb');

      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });

      await proxyService.getAdapter(proxyIndexer);

      expect(factorySpy).toHaveBeenCalledWith(
        expect.objectContaining({ useProxy: true }),
        'AudioBookBay',
        undefined,
      );
      factorySpy.mockRestore();
    });

    it('searchAll uses proxy for proxy-enabled indexers', async () => {
      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });
      proxyDb.select.mockReturnValue(mockDbChain([proxyIndexer]));

      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([{ title: 'Proxied Book', indexer: 'ABB', protocol: 'torrent' }]),
        test: vi.fn(),
      };
      // Spy on createAdapter to verify proxyUrl is passed, but return our mock adapter
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxyService as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const results = await proxyService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Proxied Book');
      // getAdapter calls getProxyUrl which calls settingsService.get('network')
      expect(mockSettingsService.get).toHaveBeenCalledWith('network');
      expect(createSpy).toHaveBeenCalledWith(proxyIndexer, 'socks5://proxy:1080');
    });

    it('searchAll catches ProxyError and continues with other indexers', async () => {
      const { ProxyError } = await import('../../core/indexers/errors.js');
      const indexer1 = createMockDbIndexer({
        id: 1,
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });
      const indexer2 = createMockDbIndexer({ id: 2, name: 'Indexer2' });
      proxyDb.select.mockReturnValue(mockDbChain([indexer1, indexer2]));

      const proxyErrorAdapter = {
        search: vi.fn().mockRejectedValue(new ProxyError('SOCKS5 proxy connection refused')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue([{ title: 'Good Book', indexer: 'Indexer2', protocol: 'torrent' }]),
        test: vi.fn(),
      };

      vi.spyOn(proxyService, 'getAdapter')
        .mockResolvedValueOnce(proxyErrorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await proxyService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Good Book');
    });

    it('test routes through proxy when indexer has useProxy enabled', async () => {
      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });
      proxyDb.select.mockReturnValue(mockDbChain([proxyIndexer]));

      const mockAdapter = {
        test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }),
        search: vi.fn(),
      };
      vi.spyOn(proxyService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const result = await proxyService.test(1);
      expect(result.success).toBe(true);
      expect(proxyService.getAdapter).toHaveBeenCalledWith(proxyIndexer);
    });

    it('testConfig routes through proxy when useProxy is true in config', async () => {
      const mockAdapter = { test: vi.fn().mockResolvedValue({ success: true, message: 'OK' }), search: vi.fn() };
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxyService as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await proxyService.testConfig({
        type: 'abb',
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });

      expect(result.success).toBe(true);
      // testConfig calls getProxyUrl then passes it to createAdapter
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ useProxy: true }),
        }),
        'socks5://proxy:1080',
      );
    });

    it('clearAdapterCache invalidates all cached adapters', async () => {
      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });

      const adapter1 = await proxyService.getAdapter(proxyIndexer);
      proxyService.clearAdapterCache();
      const adapter2 = await proxyService.getAdapter(proxyIndexer);

      expect(adapter2).not.toBe(adapter1);
    });

  });

  describe('Prowlarr upsert logic', () => {
    describe('findByProwlarrSource', () => {
      it('returns matching row when source=prowlarr and sourceIndexerId match', async () => {
        const prowlarrIndexer = createMockDbIndexer({ source: 'prowlarr', sourceIndexerId: 42 });
        db.select.mockReturnValue(mockDbChain([prowlarrIndexer]));

        const result = await service.findByProwlarrSource(42);
        expect(result).not.toBeNull();
        expect(result!.sourceIndexerId).toBe(42);
      });

      it('returns null when no matching prowlarr-sourced row exists', async () => {
        db.select.mockReturnValue(mockDbChain([]));

        const result = await service.findByProwlarrSource(999);
        expect(result).toBeNull();
      });
    });

    describe('createOrUpsertProwlarr', () => {
      it('inserts new row when no existing prowlarr-sourced row matches sourceIndexerId', async () => {
        // findByProwlarrSource returns nothing
        db.select.mockReturnValue(mockDbChain([]));
        const newRow = createMockDbIndexer({ id: 5, source: 'prowlarr', sourceIndexerId: 10 });
        db.insert.mockReturnValue(mockDbChain([newRow]));

        const result = await service.createOrUpsertProwlarr({
          name: 'New Indexer',
          type: 'torznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'http://prowlarr/10/', apiKey: 'key' },
          sourceIndexerId: 10,
        });

        expect(result.upserted).toBe(false);
        expect(result.row.id).toBe(5);
        expect(db.insert).toHaveBeenCalled();
      });

      it('updates existing row when prowlarr-sourced row with same sourceIndexerId exists', async () => {
        const existing = createMockDbIndexer({ id: 3, source: 'prowlarr', sourceIndexerId: 10, priority: 25, enabled: false });
        db.select.mockReturnValue(mockDbChain([existing]));
        const updatedRow = { ...existing, name: 'Updated Name', settings: { apiUrl: 'http://new/', apiKey: 'newkey' } };
        db.update.mockReturnValue(mockDbChain([updatedRow]));

        const result = await service.createOrUpsertProwlarr({
          name: 'Updated Name',
          type: 'torznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'http://new/', apiKey: 'newkey' },
          sourceIndexerId: 10,
        });

        expect(result.upserted).toBe(true);
        expect(result.row.id).toBe(3);
        expect(db.update).toHaveBeenCalled();
      });

      it('preserves local-only fields (priority, enabled) on upsert', async () => {
        const existing = createMockDbIndexer({ id: 3, source: 'prowlarr', sourceIndexerId: 10, priority: 25, enabled: false });
        db.select.mockReturnValue(mockDbChain([existing]));
        const updateChain = mockDbChain([existing]);
        db.update.mockReturnValue(updateChain);

        await service.createOrUpsertProwlarr({
          name: 'New Name',
          type: 'torznab',
          enabled: true, // This should NOT be written on upsert
          priority: 99,  // This should NOT be written on upsert
          settings: { apiUrl: 'http://prowlarr/10/', apiKey: 'key' },
          sourceIndexerId: 10,
        });

        // Verify update was called and .set() payload excludes priority and enabled
        expect(db.update).toHaveBeenCalled();
        const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(setPayload).not.toHaveProperty('priority');
        expect(setPayload).not.toHaveProperty('enabled');
        expect(setPayload).toHaveProperty('name', 'New Name');
        expect(setPayload).toHaveProperty('settings');
        expect(setPayload).toHaveProperty('source', 'prowlarr');
      });

      it('preserves local-only settings keys on upsert', async () => {
        const existing = createMockDbIndexer({
          id: 3,
          source: 'prowlarr',
          sourceIndexerId: 10,
          settings: {
            apiUrl: 'http://old/',
            apiKey: 'oldkey',
            flareSolverrUrl: 'http://flaresolverr:8191',
            useProxy: true,
            proxyUrl: 'socks5://proxy:1080',
          },
        });
        db.select.mockReturnValue(mockDbChain([existing]));
        const updateChain = mockDbChain([existing]);
        db.update.mockReturnValue(updateChain);

        await service.createOrUpsertProwlarr({
          name: 'Synced Name',
          type: 'torznab',
          enabled: true,
          priority: 99,
          settings: { apiUrl: 'http://new/', apiKey: 'newkey' },
          sourceIndexerId: 10,
        });

        const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // Prowlarr-managed secret settings are encrypted (apiUrl + apiKey, #742)
        expect(isEncrypted(setPayload.settings.apiUrl)).toBe(true);
        expect(isEncrypted(setPayload.settings.apiKey)).toBe(true);
        // Local-only settings keys are preserved from existing row (secret fields encrypted)
        expect(isEncrypted(setPayload.settings.flareSolverrUrl)).toBe(true);
        expect(setPayload.settings.useProxy).toBe(true);
        expect(setPayload.settings.proxyUrl).toBe('socks5://proxy:1080');
      });

      it('always inserts when sourceIndexerId is null', async () => {
        const newRow = createMockDbIndexer({ id: 7, source: 'prowlarr', sourceIndexerId: null });
        db.insert.mockReturnValue(mockDbChain([newRow]));

        const result = await service.createOrUpsertProwlarr({
          name: 'No ID Indexer',
          type: 'torznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'http://example.com/', apiKey: 'key' },
          sourceIndexerId: null,
        });

        expect(result.upserted).toBe(false);
        expect(db.insert).toHaveBeenCalled();
        // Should NOT call select (no lookup when sourceIndexerId is null)
        expect(db.select).not.toHaveBeenCalled();
      });

      it('returns the row with existing id on upsert', async () => {
        const existing = createMockDbIndexer({ id: 42, source: 'prowlarr', sourceIndexerId: 5 });
        db.select.mockReturnValue(mockDbChain([existing]));
        db.update.mockReturnValue(mockDbChain([existing]));

        const result = await service.createOrUpsertProwlarr({
          name: 'Updated',
          type: 'torznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'http://prowlarr/5/', apiKey: 'key' },
          sourceIndexerId: 5,
        });

        expect(result.upserted).toBe(true);
        expect(result.row.id).toBe(42);
      });
    });

    describe('sourceIndexerId extraction', () => {
      // These test the extractSourceIndexerId utility exported from prowlarr-compat
      // but we test the integration through createOrUpsertProwlarr calls above.
      // Unit tests for the extraction function are in prowlarr-compat.test.ts.

      it('extracts numeric id from baseUrl like http://prowlarr:9696/1/', async () => {
        const { extractSourceIndexerId } = await import('../routes/prowlarr-compat.js');
        expect(extractSourceIndexerId('http://prowlarr:9696/1/')).toBe(1);
      });

      it('extracts numeric id from baseUrl like http://prowlarr:9696/42/api', async () => {
        const { extractSourceIndexerId } = await import('../routes/prowlarr-compat.js');
        expect(extractSourceIndexerId('http://prowlarr:9696/42/api')).toBe(42);
      });

      it('returns null for baseUrl with no numeric path segment', async () => {
        const { extractSourceIndexerId } = await import('../routes/prowlarr-compat.js');
        expect(extractSourceIndexerId('http://example.com/no-numeric-path')).toBeNull();
      });

      it('returns null for baseUrl like http://example.com/', async () => {
        const { extractSourceIndexerId } = await import('../routes/prowlarr-compat.js');
        expect(extractSourceIndexerId('http://example.com/')).toBeNull();
      });
    });
  });

  // ── #229 Observability — logging improvements ───────────────────────────
  describe('logging improvements (#229)', () => {
    it('per-indexer search logs { indexer, resultCount, elapsedMs } at debug', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const mockResult = { title: 'Book', indexer: 'AudioBookBay', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockResolvedValue([mockResult]), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await svc.searchAll('test');

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexer: 'AudioBookBay', resultCount: 1, elapsedMs: expect.any(Number) }),
        'Indexer search completed',
      );
    });

    it('per-indexer search that throws does not emit elapsed time log', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockRejectedValue(new Error('timeout')), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await svc.searchAll('test');

      expect(log.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ indexer: 'AudioBookBay', elapsedMs: expect.any(Number) }),
        'Indexer search completed',
      );
    });

    it('parseReleaseNames debug log includes indexerName field', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const unparseable = { title: 'Some Random Title Without Author Delimiter', indexer: 'AudioBookBay', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockResolvedValue([unparseable]), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await svc.searchAll('test');

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexerName: 'AudioBookBay' }),
        'Unparsed release name',
      );
    });

    it('parseReleaseNames called from pollRss passes indexer name', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const torznabIndexer = createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const unparseable = { title: 'UnparseableTitle', indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'torznab', name: 'Torznab', search: vi.fn().mockResolvedValue([unparseable]), test: vi.fn() };
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await svc.pollRss(torznabIndexer);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexerName: 'Torznab' }),
        'Unparsed release name',
      );
    });
  });

  describe('searchAll — concurrent execution', () => {
    it('invokes second adapter before first resolves (proves concurrent fan-out)', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      // Adapter1 blocks on a deferred promise — if execution is sequential,
      // adapter2.search will never be called until adapter1 resolves.
      let resolveAdapter1!: (value: unknown[]) => void;
      const adapter1Promise = new Promise<unknown[]>((resolve) => { resolveAdapter1 = resolve; });

      const adapter1 = {
        search: vi.fn().mockReturnValue(adapter1Promise),
        test: vi.fn(),
      };
      const adapter2 = {
        search: vi.fn().mockImplementation(async () => {
          // Assert adapter1.search was already called but NOT yet resolved
          expect(adapter1.search).toHaveBeenCalledTimes(1);
          return [{ title: 'Book2', indexer: 'Indexer2' }];
        }),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(adapter1 as never)
        .mockResolvedValueOnce(adapter2 as never);

      const searchPromise = service.searchAll('test');

      // Wait a tick to let both adapter.search calls be initiated
      await new Promise(resolve => setTimeout(resolve, 0));

      // At this point, adapter2 should already have been called (concurrent)
      expect(adapter2.search).toHaveBeenCalledTimes(1);

      // Now resolve adapter1 so searchAll can complete
      resolveAdapter1([{ title: 'Book1', indexer: 'ABB' }]);
      const results = await searchPromise;
      expect(results).toHaveLength(2);
    });

    it('collects results from fulfilled indexers when one rejects', async () => {
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

    it('returns empty array when all indexers reject', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const err1 = { search: vi.fn().mockRejectedValue(new Error('Timeout')), test: vi.fn() };
      const err2 = { search: vi.fn().mockRejectedValue(new Error('DNS')), test: vi.fn() };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(err1 as never)
        .mockResolvedValueOnce(err2 as never);

      const results = await service.searchAll('test');
      expect(results).toEqual([]);
    });

    it('logs warning with err key for rejected indexers (Pino serialization)', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const failError = new Error('Connection refused');
      const errorAdapter = { search: vi.fn().mockRejectedValue(failError), test: vi.fn() };
      const goodAdapter = { search: vi.fn().mockResolvedValue([]), test: vi.fn() };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const log = inject<FastifyBaseLogger>(createMockLogger());
      const svc = new IndexerService(inject<Db>(db), log);
      vi.spyOn(svc, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      await svc.searchAll('test');
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: failError.message }),
          indexer: mockIndexer.name,
        }),
        expect.stringContaining('Error searching indexer'),
      );
    });

    it('applies match scoring and sorting after concurrent collection', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const adapter1 = {
        search: vi.fn().mockResolvedValue([{ title: 'Wrong Book', indexer: 'ABB' }]),
        test: vi.fn(),
      };
      const adapter2 = {
        search: vi.fn().mockResolvedValue([{ title: 'The Way of Kings', indexer: 'Indexer2', author: 'Sanderson' }]),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(adapter1 as never)
        .mockResolvedValueOnce(adapter2 as never);

      const results = await service.searchAll('sanderson', { title: 'The Way of Kings', author: 'Sanderson' });
      // Better match should be sorted first
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('works correctly with a single enabled indexer', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const adapter = {
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'ABB' }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const results = await service.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Book');
    });
  });

  describe('searchAllStreaming', () => {
    const mockIndexer2 = createMockDbIndexer({ id: 2, name: 'MAM', type: 'myanonamouse' });

    it('calls onComplete for each successful indexer', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer, mockIndexer2]));

      const adapter1 = { search: vi.fn().mockResolvedValue([{ title: 'Book1', indexer: 'ABB' }]), test: vi.fn() };
      const adapter2 = { search: vi.fn().mockResolvedValue([{ title: 'Book2', indexer: 'MAM' }]), test: vi.fn() };
      let callCount = 0;
      vi.spyOn(service, 'getAdapter').mockImplementation(async () => {
        callCount++;
        return (callCount === 1 ? adapter1 : adapter2) as never;
      });

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());
      controllers.set(2, new AbortController());

      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError });

      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name, 1, expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(2, 'MAM', 1, expect.any(Number));
      expect(onError).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('calls onError for failed indexer and continues', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer, mockIndexer2]));

      const adapter1 = { search: vi.fn().mockRejectedValue(new Error('Timeout')), test: vi.fn() };
      const adapter2 = { search: vi.fn().mockResolvedValue([{ title: 'Book2', indexer: 'MAM' }]), test: vi.fn() };
      let callCount = 0;
      vi.spyOn(service, 'getAdapter').mockImplementation(async () => {
        callCount++;
        return (callCount === 1 ? adapter1 : adapter2) as never;
      });

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());
      controllers.set(2, new AbortController());

      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError });

      expect(onError).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name, 'Timeout', expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(2, 'MAM', 1, expect.any(Number));
      expect(results).toHaveLength(1);
    });

    it('excludes cancelled indexer results and calls onCancelled', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const controller = new AbortController();
      controller.abort();
      const adapter = { search: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')), test: vi.fn() };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, controller);

      const onComplete = vi.fn();
      const onError = vi.fn();
      const onCancelled = vi.fn();

      const results = await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError, onCancelled });

      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled(); // Cancelled, not errored
      expect(onCancelled).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name);
      expect(results).toHaveLength(0);
    });

    it('scores results when title provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const adapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'The Way of Kings', author: 'Brandon Sanderson', indexer: 'ABB' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());

      const results = await service.searchAllStreaming(
        'way of kings',
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        controllers,
        { onComplete: vi.fn(), onError: vi.fn() },
      );

      expect(results[0].matchScore).toBeDefined();
      expect(results[0].matchScore).toBeGreaterThan(0);
    });
  });

  describe('#372 — pre-search refresh (searchAll)', () => {
    const mamIndexer = createMockDbIndexer({
      id: 10, name: 'MAM', type: 'myanonamouse',
      settings: { mamId: 'test', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
    });

    it('calls refreshStatus() before search() for MAM adapter', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const callOrder: string[] = [];
      const mockAdapter = {
        type: 'myanonamouse',
        name: 'MAM',
        refreshStatus: vi.fn().mockImplementation(() => { callOrder.push('refresh'); return Promise.resolve({ isVip: true, classname: 'VIP' }); }),
        search: vi.fn().mockImplementation(() => { callOrder.push('search'); return Promise.resolve([]); }),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      await service.searchAll('test');
      expect(callOrder).toEqual(['refresh', 'search']);
    });

    it('skips search when refreshStatus() returns Mouse class', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const results = await service.searchAll('test');
      expect(mockAdapter.search).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it('proceeds with search when refreshStatus() throws (network error)', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockRejectedValue(new Error('Network error')),
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await service.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('proceeds with search when refreshStatus() returns null', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue(null),
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await service.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('calls search() directly for non-MAM adapter (no refreshStatus method)', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await service.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('persists updated isVip/classname when class changes (VIP → Power User)', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Power User' }),
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);
      const results = await service.searchAll('test');
      expect(updateSpy).toHaveBeenCalledWith(10, {
        settings: expect.objectContaining({ isVip: false, classname: 'Power User' }),
      });
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('does not write to DB when refreshStatus() returns same class as stored', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: true, classname: 'VIP' }),
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);
      const results = await service.searchAll('test');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('other indexers still return results when Mouse indexer is skipped', async () => {
      const abbIndexer = createMockDbIndexer({ id: 2, name: 'ABB', type: 'abb' });
      db.select.mockReturnValue(mockDbChain([mamIndexer, abbIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      const abbAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mouseAdapter as never)
        .mockResolvedValueOnce(abbAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));
      const results = await service.searchAll('test');
      expect(mouseAdapter.search).not.toHaveBeenCalled();
      expect(abbAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });
  });

  describe('#372 — searchAllStreaming Mouse error', () => {
    const mamIndexer = createMockDbIndexer({
      id: 10, name: 'MAM', type: 'myanonamouse',
      settings: { mamId: 'test', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
    });

    it('fires onError callback with "Searches disabled — Mouse class" message', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mouseAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));

      const onError = vi.fn();
      const onComplete = vi.fn();
      const controllers = new Map([[10, new AbortController()]]);
      await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(onError).toHaveBeenCalledWith(10, 'MAM', 'Searches disabled — Mouse class', expect.any(Number));
      expect(mouseAdapter.search).not.toHaveBeenCalled();
    });

    it('other indexers in same streaming search still complete normally', async () => {
      const abbIndexer = createMockDbIndexer({ id: 2, name: 'ABB', type: 'abb' });
      db.select.mockReturnValue(mockDbChain([mamIndexer, abbIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      const abbAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mouseAdapter as never)
        .mockResolvedValueOnce(abbAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));

      const onError = vi.fn();
      const onComplete = vi.fn();
      const controllers = new Map([[10, new AbortController()], [2, new AbortController()]]);
      const results = await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
    });
  });

  describe('#372 — warning propagation through service test methods', () => {
    it('test() passes through warning field from adapter result', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        test: vi.fn().mockResolvedValue({
          success: true, message: 'OK', warning: 'Account is ratio-locked',
          metadata: { isVip: false, classname: 'Mouse' },
        }),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      db.update.mockReturnValue(mockDbChain([mockIndexer]));
      const result = await service.test(1);
      expect(result.warning).toBe('Account is ratio-locked');
    });

    it('testConfig() passes through warning field from adapter result', async () => {
      const mockAdapter = {
        test: vi.fn().mockResolvedValue({
          success: true, message: 'Connected', warning: 'Account is ratio-locked',
          metadata: { isVip: false, classname: 'Mouse' },
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);
      const result = await service.testConfig({ type: 'myanonamouse', settings: { mamId: 'test-id' } });
      expect(result.warning).toBe('Account is ratio-locked');
      expect(result.success).toBe(true);
    });
  });

  // ===== #386 — Language injection into searchAll / searchAllStreaming =====

  describe('searchAll() language injection', () => {
    let settingsService: ReturnType<typeof createMockSettingsService>;
    let langService: IndexerService;

    beforeEach(() => {
      settingsService = createMockSettingsService({ metadata: { audibleRegion: 'us', languages: ['english', 'french'] } });
      langService = new IndexerService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(settingsService),
      );
    });

    it('reads metadata.languages from settingsService when options.languages absent', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await langService.searchAll('sanderson');

      expect(settingsService.get).toHaveBeenCalledWith('metadata');
      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['english', 'french'] }),
      );
    });

    it('preserves explicit caller-supplied options.languages', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await langService.searchAll('sanderson', { languages: ['german'] });

      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['german'] }),
      );
    });
  });

  describe('searchAllStreaming() language injection', () => {
    let settingsService: ReturnType<typeof createMockSettingsService>;
    let langService: IndexerService;

    beforeEach(() => {
      settingsService = createMockSettingsService({ metadata: { audibleRegion: 'us', languages: ['english', 'french'] } });
      langService = new IndexerService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(settingsService),
      );
    });

    it('injects metadata.languages into adapter options', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controllers = new Map([[mockIndexer.id, new AbortController()]]);
      const onComplete = vi.fn();
      const onError = vi.fn();

      await langService.searchAllStreaming('sanderson', undefined, controllers, { onComplete, onError });

      expect(settingsService.get).toHaveBeenCalledWith('metadata');
      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['english', 'french'] }),
      );
    });

    it('preserves per-indexer abort signal alongside injected languages', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([]),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controller = new AbortController();
      const controllers = new Map([[mockIndexer.id, controller]]);
      const onComplete = vi.fn();
      const onError = vi.fn();

      await langService.searchAllStreaming('sanderson', undefined, controllers, { onComplete, onError });

      const searchCall = mockAdapter.search.mock.calls[0][1];
      expect(searchCall.languages).toEqual(['english', 'french']);
      expect(searchCall.signal).toBe(controller.signal);
    });
  });

  describe('#372 — test() persists classname alongside isVip', () => {
    it('persists classname alongside isVip on successful test', async () => {
      const mamRow = createMockDbIndexer({
        id: 10, name: 'MAM', type: 'myanonamouse',
        settings: { mamId: 'test', searchLanguages: [1], searchType: 'active' },
      });
      db.select.mockReturnValue(mockDbChain([mamRow]));
      const mockAdapter = {
        test: vi.fn().mockResolvedValue({
          success: true, message: 'Connected as user',
          metadata: { username: 'user', classname: 'VIP', isVip: true },
        }),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamRow as never);

      await service.test(10);
      expect(updateSpy).toHaveBeenCalledWith(10, {
        settings: expect.objectContaining({ isVip: true, classname: 'VIP' }),
      });
    });
  });

  describe('indexerPriority mapping (#394)', () => {
    it('searchAll attaches indexerPriority from the indexer record to each mapped result', async () => {
      const highPriorityIndexer = createMockDbIndexer({ id: 5, priority: 10 });
      db.select.mockReturnValue(mockDbChain([highPriorityIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([
          { title: 'Book One', indexer: 'AudioBookBay', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('test');
      expect(results[0].indexerPriority).toBe(10);
    });

    it('searchAllStreaming attaches indexerPriority from the indexer record to each mapped result', async () => {
      const streamIndexer = createMockDbIndexer({ id: 3, priority: 25 });
      db.select.mockReturnValue(mockDbChain([streamIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue([
          { title: 'Book One', indexer: 'ABB', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(3, new AbortController());
      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await service.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(results[0].indexerPriority).toBe(25);
    });

    it('pollRss attaches indexerPriority from the indexer record to each mapped result', async () => {
      const rssIndexer = createMockDbIndexer({ id: 7, priority: 75, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue([
          { title: 'Author A - Book One', indexer: 'Torznab', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.pollRss(rssIndexer);
      expect(results[0].indexerPriority).toBe(75);
    });

    it('indexer with default priority (50) produces results with indexerPriority: 50', async () => {
      // mockIndexer uses createMockDbIndexer() which defaults to priority: 50
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue([
          { title: 'Book One', indexer: 'AudioBookBay', protocol: 'torrent' },
        ]),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await service.searchAll('test');
      expect(results[0].indexerPriority).toBe(50);
    });
  });
});
