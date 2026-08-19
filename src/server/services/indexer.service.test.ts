import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { SettingsService } from './settings.service.js';
import { initializeKey, _resetKey, isEncrypted } from '../utils/secret-codec.js';
import { IndexerAuthError } from '@core/indexers/errors.js';
import {
  abortRejection,
  codedRejection,
  routeFetch,
  solverEnvelope,
  type RoutedFetch,
} from '@core/__tests__/solver-routes.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockIndexer = createMockDbIndexer();

/** Real SQLite proves WHERE behavior that `mockDbChain` ignores; the inline schema also exposes
 * column-name drift when fixtures fail to bind. */
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

  describe('#1404 decrypt-failure diagnostic threading', () => {
    const CORRUPT = '$ENC$not-valid-base64!!'; // `$ENC$`-prefixed, but decrypt fails and preserves passthrough.

    it('getById threads this.log: corrupt apiKey warns with entity/failedFields, passthrough preserved', async () => {
      const log = createMockLogger();
      const loggedService = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      db.select.mockReturnValue(mockDbChain([
        createMockDbIndexer({ settings: { apiKey: CORRUPT, hostname: 'audiobookbay.lu' } }),
      ]));

      const result = await loggedService.getById(1);

      expect(log.warn).toHaveBeenCalledWith(
        { entity: 'indexer', failedFields: ['apiKey'] },
        expect.stringContaining('secret.key'),
      );
      expect((result!.settings as Record<string, unknown>).apiKey).toBe(CORRUPT);
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
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const adapter1 = await service.getAdapter(mockIndexer);

      db.update.mockReturnValue(mockDbChain([mockIndexer]));
      await service.update(1, { name: 'Changed' });

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

      db.select.mockReturnValue(mockDbChain([existingRow]));
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      await service.update(1, {
        settings: { apiKey: '********', apiUrl: '********', hostname: 'new-host', flareSolverrUrl: '********' },
      });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(setArg.settings.hostname).toBe('new-host');
      expect(setArg.settings.apiKey).toBe(encryptedApiKey);
      expect(setArg.settings.apiUrl).toBe(encryptedApiUrl);
      expect(setArg.settings.flareSolverrUrl).toBe(encryptedFlareSolverrUrl);
    });

    it('rejects sentinel on a non-secret field rather than silently substituting it', async () => {
      const existingRow = {
        ...mockIndexer,
        settings: { apiKey: 'real-key', hostname: 'persisted-host' },
      };
      db.select.mockReturnValue(mockDbChain([existingRow]));
      db.update.mockReturnValue(mockDbChain([existingRow]));

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

    it('#1180 throws a Zod-flavored error naming the missing field when persisted settings are malformed', async () => {
      const badIndexer = createMockDbIndexer({ settings: { pageLimit: 2 } });

      await expect(service.getAdapter(badIndexer)).rejects.toThrow(/hostname/);
    });

    /**
     * #2392 AC15 — `createAdapter` reparses the decrypted row, so the schema's normalization is a
     * read-path behavior too. No migration rewrites the row; the two halves disagree by design and
     * the pair of cases below is what makes that legible.
     */
    describe('#2392 a persisted pasted URL', () => {
      const ABB_HOST = 'audiobookbay.test';
      let routed: RoutedFetch | undefined;

      afterEach(() => {
        routed?.restore();
        routed = undefined;
      });

      it('AC15b targets https://<host> on the very next search, with no operator action', async () => {
        const legacyRow = createMockDbIndexer({ settings: { hostname: `https://${ABB_HOST}`, pageLimit: 1 } });
        routed = routeFetch(() => new Response('<html><body></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        }));

        const adapter = await service.getAdapter(legacyRow);
        const response = await adapter.search('brandon sanderson');

        expect(response.requestUrl?.startsWith(`https://${ABB_HOST}/`)).toBe(true);
        expect(response.requestUrl?.match(/https:\/\//g)).toHaveLength(1);
        // AC15a, the other half of the same value: the row itself is untouched, which is what
        // `GET /api/indexers` serializes (asserted at the route boundary in indexers.test.ts).
        expect(legacyRow.settings.hostname).toBe(`https://${ABB_HOST}`);
      });

      it('AC15c fails at adapter construction naming hostname when the new rule rejects the stored value', async () => {
        const rejectedRow = createMockDbIndexer({ settings: { hostname: 'ftp://audiobookbay.lu', pageLimit: 1 } });

        await expect(service.getAdapter(rejectedRow)).rejects.toThrow(/hostname/);
      });

      it.each(['audiobookbay.lu', 'test', 'tracker', 'old-host', 'new-host', 'persisted-host', 'abb.test'])(
        'AC15c leaves the working bare-host fixture %s alone on the read path',
        async (hostname) => {
          const row = createMockDbIndexer({ settings: { hostname, pageLimit: 2 } });

          const adapter = await service.getAdapter(row);

          expect(adapter.type).toBe('abb');
        },
      );
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
      const persistSpy = vi.spyOn(service, 'persistObservedSettings').mockResolvedValue(mamIndexer as never);
      const updateSpy = vi.spyOn(service, 'update');

      const result = await service.test(5);
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ username: 'VipUser', classname: 'VIP', isVip: true });
      expect(persistSpy).toHaveBeenCalledWith(5, { mamId: 'test-id', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' });
      // #2376 AC17: the observation write must not travel through the clearing mutator.
      expect(updateSpy).not.toHaveBeenCalled();
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
      const persistSpy = vi.spyOn(service, 'persistObservedSettings');

      const result = await service.test(5);
      expect(result.success).toBe(false);
      expect(persistSpy).not.toHaveBeenCalled();
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
      vi.spyOn(service, 'persistObservedSettings').mockRejectedValue(new Error('DB error'));

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
      const fakeRow = createSpy.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(fakeRow.settings.mamId).toBe('********');
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

      // The service passes global proxy config inward; `useProxy` controls what reaches the factory.
      expect(createSpy).toHaveBeenCalledWith(noProxyIndexer, 'socks5://proxy:1080');
      const { INDEXER_ADAPTER_FACTORIES } = await import('@core/index.js');
      const factorySpy = vi.spyOn(INDEXER_ADAPTER_FACTORIES, 'abb');

      // Clear cache so creation runs again after installing the factory spy.
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
      const { INDEXER_ADAPTER_FACTORIES } = await import('@core/index.js');
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

    // Mock-backed cases prove shape/decryption; real SQLite cases below prove `source = 'prowlarr'`.
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
        const { indexers } = await import('@db/schema.js');
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

        expect(result).toHaveLength(1);
        expect(result[0]!.name).toBe('Prowlarr Tracker');
        expect(result[0]!.source).toBe('prowlarr');
      });

      it('getAllProwlarrManaged excludes rows with non-prowlarr source values', async () => {
        const { indexers } = await import('@db/schema.js');
        await realDb.insert(indexers).values([
          {
            name: 'Prowlarr', type: 'torznab', enabled: true, priority: 50,
            settings: { apiUrl: 'http://x/', apiKey: 'k' },
            source: 'prowlarr', sourceIndexerId: 1,
          },
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
        const { indexers } = await import('@db/schema.js');
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

        expect(result).toBeNull();
      });

      it('getByIdProwlarrManaged returns the row when id matches AND source = prowlarr', async () => {
        const { indexers } = await import('@db/schema.js');
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
          enabled: true,
          priority: 99,
          settings: { apiUrl: 'http://prowlarr/10/', apiKey: 'key' },
          sourceIndexerId: 10,
        });

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
        expect(isEncrypted(setPayload.settings.apiUrl)).toBe(true);
        expect(isEncrypted(setPayload.settings.apiKey)).toBe(true);
        expect(isEncrypted(setPayload.settings.flareSolverrUrl)).toBe(true);
        expect(setPayload.settings.useProxy).toBe(true);
        expect(setPayload.settings.proxyUrl).toBe('socks5://proxy:1080');
      });

      it('strips Readarr echo-only keys from a dirty existing row on upsert (#1198 layer 3)', async () => {
        // Echo-only keys from older rows would fail strict adapter parsing if merged forward.
        const existing = createMockDbIndexer({
          id: 3,
          source: 'prowlarr',
          sourceIndexerId: 10,
          settings: {
            apiUrl: 'http://old/',
            apiKey: 'oldkey',
            categories: [3030],
            minimumSeeders: 0,
            'seedCriteria.seedRatio': null,
            'seedCriteria.seedTime': null,
          },
        });
        db.select.mockReturnValue(mockDbChain([existing]));
        const updateChain = mockDbChain([existing]);
        db.update.mockReturnValue(updateChain);

        await service.createOrUpsertProwlarr({
          name: 'Synced Name',
          type: 'torznab',
          enabled: true,
          priority: 50,
          settings: { apiUrl: 'http://new/', apiKey: 'newkey' },
          sourceIndexerId: 10,
        });

        const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        for (const key of ['categories', 'minimumSeeders', 'seedCriteria.seedRatio', 'seedCriteria.seedTime']) {
          expect(setPayload.settings).not.toHaveProperty(key);
        }
        expect(isEncrypted(setPayload.settings.apiUrl)).toBe(true);
        expect(isEncrypted(setPayload.settings.apiKey)).toBe(true);
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

  describe('getLanAllowlist (#1149)', () => {
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

    it('returns matching host:port and hostname sets for two configured indexers', async () => {
      const { indexers } = await import('@db/schema.js');
      await realDb.insert(indexers).values([
        {
          name: 'Prowlarr', type: 'torznab', enabled: true, priority: 50,
          settings: { apiUrl: 'http://192.168.0.22:9696/1/', apiKey: 'k' },
        },
        {
          name: 'Prowlarr-by-name', type: 'torznab', enabled: true, priority: 50,
          settings: { apiUrl: 'http://prowlarr.lan/', apiKey: 'k' },
        },
      ]);

      const allowlist = await realService.getLanAllowlist();

      expect(allowlist.hostPort.has('192.168.0.22:9696')).toBe(true);
      // URL normalization supplies the default port and lowercases the hostname.
      expect(allowlist.hostPort.has('prowlarr.lan:80')).toBe(true);
      expect(allowlist.hostname.has('192.168.0.22')).toBe(true);
      expect(allowlist.hostname.has('prowlarr.lan')).toBe(true);
    });

    it('produces no entries for empty/null/un-parseable apiUrl (no empty-string keys, no crash)', async () => {
      const { indexers } = await import('@db/schema.js');
      await realDb.insert(indexers).values([
        {
          name: 'NoApiUrl', type: 'abb', enabled: true, priority: 50,
          settings: { hostname: 'audiobookbay.lu' },
        },
        {
          name: 'EmptyApiUrl', type: 'torznab', enabled: true, priority: 50,
          settings: { apiUrl: '', apiKey: 'k' },
        },
        {
          name: 'UnparseableApiUrl', type: 'torznab', enabled: true, priority: 50,
          settings: { apiUrl: 'not-a-url', apiKey: 'k' },
        },
      ]);

      const allowlist = await realService.getLanAllowlist();

      expect(allowlist.hostPort.size).toBe(0);
      expect(allowlist.hostname.size).toBe(0);
      expect(allowlist.hostPort.has('')).toBe(false);
      expect(allowlist.hostname.has('')).toBe(false);
    });

    it('IPv6 apiUrl emits unbracketed host:port and hostname keys', async () => {
      const { indexers } = await import('@db/schema.js');
      await realDb.insert(indexers).values({
        name: 'IPv6 Indexer', type: 'torznab', enabled: true, priority: 50,
        settings: { apiUrl: 'http://[fe80::1]:8080/', apiKey: 'k' },
      });

      const allowlist = await realService.getLanAllowlist();

      expect(allowlist.hostPort.has('fe80::1:8080')).toBe(true);
      expect(allowlist.hostname.has('fe80::1')).toBe(true);
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
      const persistSpy = vi.spyOn(service, 'persistObservedSettings').mockResolvedValue(mamRow as never);

      await service.test(10);
      expect(persistSpy).toHaveBeenCalledWith(10, expect.objectContaining({ isVip: true, classname: 'VIP' }));
    });
  });


  /**
   * #2374 end-to-end: the diagnosis is produced by the real adapter, returned by the service, and
   * recorded as the breaker's reason verbatim — `reasonFor` reads `error.message`, so the new
   * wording is what the health card renders. The transient/terminal verdict must be unchanged by it.
   */
  describe('#2374 the solver diagnosis reaches the health card', () => {
    const SOLVER_URL = 'http://flaresolverr.test:8191';
    const ABB_HOST = 'audiobookbay.test';
    const TARGET_VERDICT = `Target unreachable: ${ABB_HOST} refused the connection (ECONNREFUSED). Probed directly, not through the solver.`;
    const solverRow = createMockDbIndexer({
      id: 11,
      name: 'ABB',
      type: 'abb',
      settings: { hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL },
    });
    let routed: RoutedFetch | undefined;

    afterEach(() => {
      routed?.restore();
      routed = undefined;
    });

    it('records the Target verdict as the breaker reason and takes the transient ladder', async () => {
      db.select.mockReturnValue(mockDbChain([solverRow]));
      routed = routeFetch((url, method) => {
        if (method === 'POST' && url.startsWith(`${SOLVER_URL}/v1`)) return abortRejection();
        if (method === 'HEAD' && url.includes(ABB_HOST)) return codedRejection('ECONNREFUSED');
        if (method === 'HEAD') return new Response(null, { status: 405 });
        return undefined;
      });

      const result = await service.test(11);

      expect(result).toEqual({ success: false, message: TARGET_VERDICT });
      expect(service.getFailureSnapshot(11)).toMatchObject({ state: 'backing-off', reason: TARGET_VERDICT });
    });

    it('clears the breaker when the same solver round-trip succeeds, and probes nothing', async () => {
      db.select.mockReturnValue(mockDbChain([solverRow]));
      const calls = routeFetch((url, method) => (method === 'POST' && url.startsWith(`${SOLVER_URL}/v1`)
        ? solverEnvelope({ status: 'ok', solution: { response: '<html>ok</html>', status: 200 } })
        : undefined));
      routed = calls;
      service.recordSearchFailure(11, new Error('Connection refused on port 443'), service.reserveSearchAttempt(11).generation);
      expect(service.getFailureSnapshot(11).state).toBe('backing-off');

      const result = await service.test(11);

      expect(result.success).toBe(true);
      expect(service.getFailureSnapshot(11).state).toBe('ok');
      expect(calls.probes()).toEqual([]);
    });
  });

  // #2376 — the breaker lives here so the clears (AC17) and the health-probe recovery hook
  // (AC7) share one home, while the gate itself stays out on the search path (AC18).
  describe('#2376 search breaker state', () => {
    /** Drive the breaker to `stopped` the way eight consecutive transient search failures would. */
    function stop(id: number): void {
      for (let n = 1; n <= 8; n++) service.recordSearchFailure(id, new Error('Connection refused on port 443'), service.reserveSearchAttempt(id).generation);
    }

    it('lets a pristine indexer through without writing state', () => {
      const decision = service.reserveSearchAttempt(7);

      expect(decision.allowed).toBe(true);
      expect(decision.snapshot.state).toBe('ok');
      expect(service.getFailureSnapshot(7).state).toBe('ok');
    });

    it('shuts the gate after a search failure and reopens it on a search success', () => {
      service.recordSearchFailure(7, new Error('Connection refused on port 443'), service.reserveSearchAttempt(7).generation);
      expect(service.getFailureSnapshot(7)).toMatchObject({ state: 'backing-off', reason: 'Connection refused on port 443' });
      expect(service.reserveSearchAttempt(7).allowed).toBe(false);

      service.recordSearchSuccess(7, service.getFailureGeneration(7));
      expect(service.getFailureSnapshot(7).state).toBe('ok');
    });

    it('stops on an IndexerAuthError at the first sight, without a backoff ladder', () => {
      service.recordSearchFailure(7, new IndexerAuthError('MAM'), service.reserveSearchAttempt(7).generation);

      expect(service.getFailureSnapshot(7)).toMatchObject({ state: 'stopped', consecutiveFailures: 1 });
    });

    it('update() clears the breaker — an operator config change is a repair signal', async () => {
      stop(7);
      db.update.mockReturnValue(mockDbChain([mockIndexer]));

      await service.update(7, { name: 'Renamed' });

      expect(service.getFailureSnapshot(7).state).toBe('ok');
      expect(service.getFailureGeneration(7)).toBe(1);
    });

    it('persistObservedSettings() writes and evicts the adapter but leaves the breaker alone', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const adapter1 = await service.getAdapter(mockIndexer);
      service.recordSearchFailure(7, new Error('Connection refused on port 443'), service.reserveSearchAttempt(7).generation);
      const before = service.getFailureSnapshot(7);
      const generationBefore = service.getFailureGeneration(7);
      db.update.mockReturnValue(mockDbChain([mockIndexer]));

      await service.persistObservedSettings(mockIndexer.id, { isVip: true });

      const setArg = (db.update.mock.results[0]!.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: unknown };
      expect(setArg.settings).toBeDefined();
      expect(await service.getAdapter(mockIndexer)).not.toBe(adapter1);
      expect(service.getFailureSnapshot(7)).toEqual(before);
      expect(service.getFailureGeneration(7)).toBe(generationBefore);
    });

    it('a Prowlarr config upsert clears through update(), leaving other indexers untouched', async () => {
      const prowlarrRow = createMockDbIndexer({ id: 7, source: 'prowlarr', sourceIndexerId: 42 });
      stop(7);
      stop(8);
      db.select.mockReturnValue(mockDbChain([prowlarrRow]));
      db.update.mockReturnValue(mockDbChain([prowlarrRow]));

      await service.createOrUpsertProwlarr({
        name: 'Prowlarr ABB', type: 'abb', enabled: true, priority: 50,
        settings: { hostname: 'audiobookbay.lu' }, sourceIndexerId: 42,
      });

      expect(service.getFailureSnapshot(7).state).toBe('ok');
      expect(service.getFailureSnapshot(8).state).toBe('stopped');
    });

    it('delete() clears the breaker and leaves every other indexer untouched', async () => {
      stop(7);
      stop(8);
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      db.delete.mockReturnValue(mockDbChain([]));

      await service.delete(7);

      expect(service.getFailureSnapshot(7).state).toBe('ok');
      expect(service.getFailureSnapshot(8).state).toBe('stopped');
    });

    it('a successful test() clears the breaker with exactly one generation bump', async () => {
      const mamRow = createMockDbIndexer({ id: 10, name: 'MAM', type: 'myanonamouse', settings: { mamId: 'test', searchLanguages: [1], searchType: 'active' } });
      db.select.mockReturnValue(mockDbChain([mamRow]));
      db.update.mockReturnValue(mockDbChain([mamRow]));
      vi.spyOn(service, 'getAdapter').mockResolvedValue({
        test: vi.fn().mockResolvedValue({ success: true, message: 'Connected', metadata: { username: 'u', classname: 'VIP', isVip: true } }),
      } as never);
      stop(10);
      const generationBefore = service.getFailureGeneration(10);

      await service.test(10);

      expect(service.getFailureSnapshot(10).state).toBe('ok');
      expect(service.getFailureGeneration(10) - generationBefore).toBe(1);
    });

    it('keeps probing a stopped indexer — suppression is for searches, never the probe (AC8)', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const adapterTest = vi.fn().mockResolvedValue({ success: true, message: 'Connected' });
      vi.spyOn(service, 'getAdapter').mockResolvedValue({ test: adapterTest } as never);
      stop(mockIndexer.id);

      await service.test(mockIndexer.id);

      expect(adapterTest).toHaveBeenCalledTimes(1);
      expect(service.getFailureSnapshot(mockIndexer.id).state).toBe('ok');
    });

    it('a failing test() records a failure instead of clearing', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(service, 'getAdapter').mockResolvedValue({
        test: vi.fn().mockResolvedValue({ success: false, message: 'Connection refused on port 443' }),
      } as never);

      await service.test(mockIndexer.id);

      expect(service.getFailureSnapshot(mockIndexer.id)).toMatchObject({
        state: 'backing-off',
        consecutiveFailures: 1,
        reason: 'Connection refused on port 443',
      });
    });

    it('a throwing test() records a failure too, so a probe outage advances the ladder', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(service, 'getAdapter').mockRejectedValue(new Error('Connection refused on port 443'));

      await service.test(mockIndexer.id);

      expect(service.getFailureSnapshot(mockIndexer.id)).toMatchObject({ state: 'backing-off', consecutiveFailures: 1 });
    });

    it('drops a search outcome whose generation predates an operator clear', async () => {
      const generation = service.reserveSearchAttempt(7).generation;
      db.update.mockReturnValue(mockDbChain([mockIndexer]));
      await service.update(7, { name: 'Fixed' });

      service.recordSearchFailure(7, new Error('a late in-flight failure'), generation);

      expect(service.getFailureSnapshot(7).state).toBe('ok');
    });
  });
});
