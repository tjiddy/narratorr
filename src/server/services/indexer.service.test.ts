import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { SettingsService } from './settings.service.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockIndexer = createMockDbIndexer();

/**
 * Spin up a real in-memory libsql DB with the `indexers` table CREATEd from
 * its drizzle schema definition. Used to prove SQL WHERE-predicate behavior
 * for the #958 Prowlarr-compat filtering helpers — mockDbChain doesn't
 * evaluate the where() expression, so a regression in the predicate would
 * pass mocked tests.
 *
 * Schema kept inline so a column-name drift in src/db/schema.ts surfaces here
 * (the rows we insert below would fail to bind), instead of silently breaking
 * the predicate proof.
 */
async function loadProwlarrPredicateDb() {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client);
  await client.execute(`
    CREATE TABLE indexers (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 50,
      settings TEXT NOT NULL,
      source TEXT,
      source_indexer_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  return { db, close: () => client.close() };
}

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
      expect(result[0]!.name).toBe('AudioBookBay');
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

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(setArg.settings.hostname).toBe('new-host');
      // Secret fields must be exactly the stored ciphertext, not re-encrypted sentinels
      expect(setArg.settings.apiKey).toBe(encryptedApiKey);
      expect(setArg.settings.apiUrl).toBe(encryptedApiUrl);
      expect(setArg.settings.flareSolverrUrl).toBe(encryptedFlareSolverrUrl);
    });

    // #844 — entity-aware allowlist on resolveSentinelFields
    it('rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const existingRow = {
        ...mockIndexer,
        settings: { apiKey: 'real-key', hostname: 'persisted-host' },
      };
      db.select.mockReturnValue(mockDbChain([existingRow]));
      db.update.mockReturnValue(mockDbChain([existingRow]));

      // hostname is NOT in the indexer secret allowlist — must throw, not be
      // silently overwritten with the persisted value.
      await expect(
        service.update(1, {
          settings: { hostname: '********', apiKey: 'still-real' },
        }),
      ).rejects.toThrow(/non-secret field: hostname/);
    });

    it('testConfig surfaces a typed error for sentinel on a non-secret field', async () => {
      const existingRow = {
        ...mockIndexer,
        settings: { hostname: 'persisted', apiKey: 'real-key' },
      };
      db.select.mockReturnValue(mockDbChain([existingRow]));

      const result = await service.testConfig({
        type: 'abb',
        settings: { hostname: '********' },
        id: 1,
      });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/non-secret field: hostname/);
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

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, string> };
      expect(isEncrypted(valuesArg.settings.apiUrl!)).toBe(true);
      expect(isEncrypted(valuesArg.settings.apiKey!)).toBe(true);
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
      const fakeRow = createSpy.mock.calls[0]![0] as { settings: Record<string, unknown> };
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
      const fakeRow = createSpy.mock.calls[0]![0] as { settings: Record<string, unknown> };
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
      const fakeRow = createSpy.mock.calls[0]![0] as { settings: Record<string, unknown> };
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

    // #958 — filtered helpers backing the Prowlarr-compat GET surface. The
    // chained where() filters source = 'prowlarr' so manual rows (source: null)
    // and rows from other origins never reach the response.
    //
    // These suites are split across two backings:
    //   - mockDbChain — ergonomic for shape/decryption assertions, but does NOT
    //     evaluate the WHERE expression. A helper that omitted the source
    //     predicate would still satisfy a mock-only test.
    //   - real in-memory libsql + Drizzle (loadProwlarrPredicateDb) — actually
    //     applies the SQL WHERE. This is what proves the predicate excludes a
    //     persisted manual (source: null) row, satisfying the F1 contract.
    describe('getAllProwlarrManaged', () => {
      it('decrypts settings on returned rows (matches getAll behavior)', async () => {
        const { encrypt } = await import('../utils/secret-codec.js');
        const encryptedKey = encrypt('real-api-key', TEST_KEY);
        const prowlarrRow = createMockDbIndexer({
          id: 1,
          source: 'prowlarr',
          sourceIndexerId: 1,
          settings: { apiKey: encryptedKey, hostname: 'tracker' },
        });
        db.select.mockReturnValue(mockDbChain([prowlarrRow]));

        const result = await service.getAllProwlarrManaged();

        expect((result[0]!.settings as { apiKey: string }).apiKey).toBe('real-api-key');
      });
    });

    describe('getByIdProwlarrManaged', () => {
      it('returns null when no row exists at the id', async () => {
        db.select.mockReturnValue(mockDbChain([]));

        const result = await service.getByIdProwlarrManaged(999);
        expect(result).toBeNull();
      });

      it('decrypts settings on the returned row (matches getById behavior)', async () => {
        const { encrypt } = await import('../utils/secret-codec.js');
        const encryptedKey = encrypt('real-api-key', TEST_KEY);
        const prowlarrRow = createMockDbIndexer({
          id: 7,
          source: 'prowlarr',
          sourceIndexerId: 3,
          settings: { apiKey: encryptedKey },
        });
        db.select.mockReturnValue(mockDbChain([prowlarrRow]));

        const result = await service.getByIdProwlarrManaged(7);

        expect((result!.settings as { apiKey: string }).apiKey).toBe('real-api-key');
      });
    });

    // #958 F1 — predicate proof against a real SQL engine. mockDbChain ignores
    // the where() expression, so a helper that drops `eq(source, 'prowlarr')`
    // would still satisfy mocked tests. These tests run the helpers against an
    // in-memory libsql DB seeded with both a manual (source: null) and a
    // prowlarr row; the SQLite engine evaluates the WHERE clause for real, so
    // any regression in the predicate fails the assertion.
    describe('Prowlarr-managed helpers — real DB predicate proof (#958 F1)', () => {
      type TestDb = Awaited<ReturnType<typeof loadProwlarrPredicateDb>>['db'];
      let realDb: TestDb;
      let realService: IndexerService;
      let close: () => void;

      beforeEach(async () => {
        const loaded = await loadProwlarrPredicateDb();
        realDb = loaded.db;
        close = loaded.close;
        realService = new IndexerService(
          inject<Db>(realDb),
          inject<FastifyBaseLogger>(createMockLogger()),
        );
      });

      afterEach(() => {
        close();
      });

      it('getAllProwlarrManaged excludes a persisted manual (source: null) row', async () => {
        const { indexers } = await import('../../db/schema.js');
        await realDb.insert(indexers).values([
          {
            name: 'Prowlarr Tracker',
            type: 'torznab',
            enabled: true,
            priority: 50,
            settings: { apiUrl: 'http://prowlarr/1/', apiKey: 'k' },
            source: 'prowlarr',
            sourceIndexerId: 1,
          },
          {
            name: 'Manually Added',
            type: 'torznab',
            enabled: true,
            priority: 50,
            settings: { apiUrl: 'http://manual/', apiKey: 'k' },
            source: null,
            sourceIndexerId: null,
          },
        ]);

        const result = await realService.getAllProwlarrManaged();

        // The SQL engine evaluated `WHERE source = 'prowlarr'` — only the
        // Prowlarr row comes back. If the helper dropped the predicate we'd
        // get both rows here.
        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe('Prowlarr Tracker');
        expect(result[0]!.source).toBe('prowlarr');
      });

      it('getAllProwlarrManaged excludes rows with non-prowlarr source values', async () => {
        const { indexers } = await import('../../db/schema.js');
        await realDb.insert(indexers).values([
          {
            name: 'Prowlarr', type: 'torznab', enabled: true, priority: 50,
            settings: { apiUrl: 'http://x/', apiKey: 'k' },
            source: 'prowlarr', sourceIndexerId: 1,
          },
          // A row with a non-null but non-'prowlarr' source must also be
          // excluded — proves the predicate is `eq(...)`, not just IS NOT NULL.
          {
            name: 'Sonarr Synced', type: 'torznab', enabled: true, priority: 50,
            settings: { apiUrl: 'http://x/', apiKey: 'k' },
            source: 'sonarr', sourceIndexerId: 2,
          },
        ]);

        const result = await realService.getAllProwlarrManaged();

        expect(result).toHaveLength(1);
        expect(result[0]!.source).toBe('prowlarr');
      });

      it('getByIdProwlarrManaged returns null for a persisted manual row at the requested id', async () => {
        const { indexers } = await import('../../db/schema.js');
        const inserted = await realDb
          .insert(indexers)
          .values({
            name: 'Manually Added',
            type: 'torznab',
            enabled: true,
            priority: 50,
            settings: { apiUrl: 'http://manual/', apiKey: 'k' },
            source: null,
            sourceIndexerId: null,
          })
          .returning();
        const manualId = inserted[0]!.id;

        const result = await realService.getByIdProwlarrManaged(manualId);

        // The id exists in the table — but the WHERE predicate filters it out
        // because source !== 'prowlarr'. If the predicate were missing, this
        // call would return the manual row.
        expect(result).toBeNull();
      });

      it('getByIdProwlarrManaged returns the row when id matches AND source = prowlarr', async () => {
        const { indexers } = await import('../../db/schema.js');
        const inserted = await realDb
          .insert(indexers)
          .values({
            name: 'Prowlarr Tracker',
            type: 'torznab',
            enabled: true,
            priority: 50,
            settings: { apiUrl: 'http://prowlarr/3/', apiKey: 'k' },
            source: 'prowlarr',
            sourceIndexerId: 3,
          })
          .returning();
        const prowlarrId = inserted[0]!.id;

        const result = await realService.getByIdProwlarrManaged(prowlarrId);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(prowlarrId);
        expect(result!.source).toBe('prowlarr');
        expect(result!.name).toBe('Prowlarr Tracker');
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
        const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0];
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

        const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0];
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
});
