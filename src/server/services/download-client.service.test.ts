import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbDownloadClient } from '../__tests__/factories.js';
import { DownloadClientService } from './download-client.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { initializeKey, _resetKey, encrypt } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockClient = createMockDbDownloadClient();

describe('DownloadClientService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: DownloadClientService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new DownloadClientService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  afterEach(() => {
    _resetKey();
  });

  describe('getAll', () => {
    it('returns all clients', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));

      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('qBittorrent');
    });
  });

  describe('getById', () => {
    it('returns client when found', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('qbittorrent');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('getFirstEnabled', () => {
    it('returns first enabled client', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));

      const result = await service.getFirstEnabled();
      expect(result).not.toBeNull();
      expect(result!.enabled).toBe(true);
    });

    it('returns null when no enabled clients', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getFirstEnabled();
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('inserts and returns new client', async () => {
      db.insert.mockReturnValue(mockDbChain([mockClient]));

      const result = await service.create({
        name: 'qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080 },
      });

      expect(result.name).toBe('qBittorrent');
    });
  });

  // ===== #263 — createWithMappings =====

  describe('createWithMappings', () => {
    it('inserts client and all mappings in a transaction with correct row payload', async () => {
      const mappingValuesArg = vi.fn();
      const clientChain = mockDbChain([mockClient]);
      const mappingChain = mockDbChain([]);
      // Override values() on the mapping chain to capture the payload
      mappingChain.values = vi.fn().mockImplementation((rows: unknown) => {
        mappingValuesArg(rows);
        return mappingChain;
      });

      const txInsert = vi.fn()
        .mockReturnValueOnce(clientChain)   // first insert: client
        .mockReturnValueOnce(mappingChain); // second insert: mappings
      db.transaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        return fn({ insert: txInsert });
      });

      const mappings = [
        { remotePath: '/remote/a', localPath: '/local/a' },
        { remotePath: '/remote/b', localPath: '/local/b' },
      ];

      const result = await service.createWithMappings({
        name: 'qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080 },
      }, mappings);

      expect(result.name).toBe('qBittorrent');
      expect(db.transaction).toHaveBeenCalled();
      expect(txInsert).toHaveBeenCalledTimes(2);

      // Verify mapping rows contain the created client's ID and exact path pairs
      expect(mappingValuesArg).toHaveBeenCalledWith([
        { downloadClientId: mockClient.id, remotePath: '/remote/a', localPath: '/local/a' },
        { downloadClientId: mockClient.id, remotePath: '/remote/b', localPath: '/local/b' },
      ]);
    });

    it('creates client only when pathMappings is empty array', async () => {
      db.insert.mockReturnValue(mockDbChain([mockClient]));

      const result = await service.createWithMappings({
        name: 'qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080 },
      }, []);

      expect(result.name).toBe('qBittorrent');
      // No transaction needed for empty mappings
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();
    });

    it('rolls back client insert when mapping insert fails', async () => {
      const txInsert = vi.fn()
        .mockReturnValueOnce(mockDbChain([mockClient])) // client insert succeeds
        .mockReturnValueOnce({ values: vi.fn().mockImplementation(() => { throw new Error('mapping insert failed'); }) }); // mapping insert fails
      db.transaction.mockImplementation(async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        return fn({ insert: txInsert });
      });

      await expect(service.createWithMappings({
        name: 'qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080 },
      }, [{ remotePath: '/remote', localPath: '/local' }])).rejects.toThrow('mapping insert failed');
    });
  });

  describe('update', () => {
    it('updates and clears adapter cache', async () => {
      // Populate cache
      db.select.mockReturnValue(mockDbChain([mockClient]));
      const adapter1 = await service.getAdapter(1);

      // Update clears cache
      db.update.mockReturnValue(mockDbChain([mockClient]));
      await service.update(1, { name: 'Renamed' });

      // Next getAdapter creates new adapter
      db.select.mockReturnValue(mockDbChain([mockClient]));
      const adapter2 = await service.getAdapter(1);
      expect(adapter2).not.toBe(adapter1);
    });

    it('preserves existing encrypted secret fields when sentinel values are submitted', async () => {
      const encryptedPassword = encrypt('real-password', TEST_KEY);
      const encryptedApiKey = encrypt('real-api-key', TEST_KEY);
      const existingRow = {
        ...mockClient,
        settings: { host: 'old-host', port: 8080, password: encryptedPassword, apiKey: encryptedApiKey },
      };

      // Sentinel lookup returns existing row
      db.select.mockReturnValue(mockDbChain([existingRow]));
      // Update returns the row
      const updateChain = mockDbChain([existingRow]);
      db.update.mockReturnValue(updateChain);

      await service.update(1, {
        settings: { host: 'new-host', port: 9090, password: '********', apiKey: '********' },
      });

      // The .set() call should have preserved the exact stored encrypted values
      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0][0] as { settings: Record<string, unknown> };
      expect(setArg.settings.host).toBe('new-host');
      expect(setArg.settings.port).toBe(9090);
      expect(setArg.settings.password).toBe(encryptedPassword);
      expect(setArg.settings.apiKey).toBe(encryptedApiKey);
    });
  });

  describe('delete', () => {
    it('returns true when client exists', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));
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
    it('creates qBittorrent adapter from settings', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));

      const adapter = await service.getAdapter(1);
      expect(adapter).not.toBeNull();
    });

    it('returns null when client not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const adapter = await service.getAdapter(999);
      expect(adapter).toBeNull();
    });

    it('caches adapter instances', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));

      const adapter1 = await service.getAdapter(1);
      const adapter2 = await service.getAdapter(1);
      expect(adapter1).toBe(adapter2);
    });
  });

  describe('test', () => {
    it('returns failure when client not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.test(999);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Download client not found');
    });
  });

  describe('getFirstEnabledForProtocol', () => {
    const qbitClient = {
      ...mockClient,
      id: 1,
      name: 'qBittorrent',
      type: 'qbittorrent' as const,
      priority: 50,
    };
    const transmissionClient = {
      ...mockClient,
      id: 2,
      name: 'Transmission',
      type: 'transmission' as const,
      priority: 100,
    };
    const sabClient = {
      ...mockClient,
      id: 3,
      name: 'SABnzbd',
      type: 'sabnzbd' as const,
      priority: 50,
    };

    it('returns qbittorrent for torrent protocol', async () => {
      db.select.mockReturnValue(mockDbChain([qbitClient, sabClient]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('qbittorrent');
    });

    it('returns null when only usenet clients exist and requesting torrent', async () => {
      db.select.mockReturnValue(mockDbChain([sabClient]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).toBeNull();
    });

    it('returns sabnzbd for usenet protocol', async () => {
      db.select.mockReturnValue(mockDbChain([qbitClient, sabClient]));

      const result = await service.getFirstEnabledForProtocol('usenet');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('sabnzbd');
    });

    it('returns null when no enabled clients', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).toBeNull();
    });

    it('respects priority ordering', async () => {
      // transmission (priority 100) comes after qbit (priority 50) in the DB results
      // since the DB query orders by priority, qbit should be found first
      db.select.mockReturnValue(mockDbChain([qbitClient, transmissionClient]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('qBittorrent');
    });

    const blackholeTorrent = {
      ...mockClient,
      id: 10,
      name: 'Blackhole Torrent',
      type: 'blackhole' as const,
      priority: 50,
      settings: { watchDir: '/watch', protocol: 'torrent' },
    };
    const blackholeUsenet = {
      ...mockClient,
      id: 11,
      name: 'Blackhole Usenet',
      type: 'blackhole' as const,
      priority: 50,
      settings: { watchDir: '/watch', protocol: 'usenet' },
    };

    it('selects Blackhole with settings.protocol matching torrent', async () => {
      db.select.mockReturnValue(mockDbChain([blackholeTorrent]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Blackhole Torrent');
    });

    it('selects Blackhole with settings.protocol matching usenet', async () => {
      db.select.mockReturnValue(mockDbChain([blackholeUsenet]));

      const result = await service.getFirstEnabledForProtocol('usenet');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Blackhole Usenet');
    });

    it('does NOT select Blackhole torrent for usenet protocol', async () => {
      db.select.mockReturnValue(mockDbChain([blackholeTorrent]));

      const result = await service.getFirstEnabledForProtocol('usenet');
      expect(result).toBeNull();
    });

    it('selects Deluge for torrent protocol', async () => {
      const delugeClient = {
        ...mockClient,
        id: 12,
        name: 'Deluge',
        type: 'deluge' as const,
        priority: 50,
      };
      db.select.mockReturnValue(mockDbChain([delugeClient]));

      const result = await service.getFirstEnabledForProtocol('torrent');
      expect(result).not.toBeNull();
      expect(result!.name).toBe('Deluge');
    });
  });

  describe('testConfig', () => {
    it('creates adapter from config and returns test result', async () => {
      const result = await service.testConfig({
        type: 'qbittorrent',
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false },
      });
      // Will fail since no real network, but should return a result (not throw)
      expect(result).toHaveProperty('success');
    });

    it('returns failure for unknown type', async () => {
      const result = await service.testConfig({
        type: 'unknown',
        settings: {},
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown download client type');
    });
  });

  describe('test edge cases', () => {
    it('catches adapter.test() throwing and returns failure', async () => {
      // Create a client that exists but whose adapter.test() throws
      const throwingClient = {
        ...mockClient,
        type: 'qbittorrent' as const,
      };
      db.select.mockReturnValue(mockDbChain([throwingClient]));

      // Spy on createAdapter to return an adapter that throws on test
      const mockAdapter = { test: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('ECONNREFUSED');
    });

    it('returns stringified value for non-Error thrown values', async () => {
      const throwingClient = { ...mockClient };
      db.select.mockReturnValue(mockDbChain([throwingClient]));

      const mockAdapter = { test: vi.fn().mockRejectedValue('string error') };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('string error');
    });
  });

  describe('getCategories', () => {
    it('returns categories from adapter', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));
      const mockAdapter = {
        supportsCategories: true,
        getCategories: vi.fn().mockResolvedValue(['audiobooks', 'movies']),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategories(1);
      expect(result.categories).toEqual(['audiobooks', 'movies']);
      expect(result.error).toBeUndefined();
    });

    it('returns empty with error when client not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getCategories(999);
      expect(result.categories).toEqual([]);
      expect(result.error).toBe('Download client not found');
    });

    it('skips adapter call when supportsCategories is false', async () => {
      db.select.mockReturnValue(mockDbChain([{ ...mockClient, type: 'transmission' }]));
      const mockAdapter = {
        supportsCategories: false,
        getCategories: vi.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategories(1);
      expect(result.categories).toEqual([]);
      expect(mockAdapter.getCategories).not.toHaveBeenCalled();
    });

    it('returns empty with error when adapter throws', async () => {
      db.select.mockReturnValue(mockDbChain([mockClient]));
      const mockAdapter = {
        supportsCategories: true,
        getCategories: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategories(1);
      expect(result.categories).toEqual([]);
      expect(result.error).toBe('ECONNREFUSED');
    });
  });

  describe('getCategoriesFromConfig', () => {
    it('creates adapter from config and returns categories', async () => {
      const mockAdapter = {
        supportsCategories: true,
        getCategories: vi.fn().mockResolvedValue(['audiobooks']),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategoriesFromConfig({
        type: 'qbittorrent',
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false },
      });
      expect(result.categories).toEqual(['audiobooks']);
    });

    it('returns empty when adapter does not support categories', async () => {
      const mockAdapter = {
        supportsCategories: false,
        getCategories: vi.fn(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategoriesFromConfig({
        type: 'transmission',
        settings: { host: 'localhost', port: 9091 },
      });
      expect(result.categories).toEqual([]);
      expect(mockAdapter.getCategories).not.toHaveBeenCalled();
    });

    it('returns failure for unknown type', async () => {
      const result = await service.getCategoriesFromConfig({
        type: 'unknown',
        settings: {},
      });
      expect(result.categories).toEqual([]);
      expect(result.error).toContain('Unknown download client type');
    });

    it('catches adapter error and returns failure', async () => {
      const mockAdapter = {
        supportsCategories: true,
        getCategories: vi.fn().mockRejectedValue(new Error('Network unreachable')),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.getCategoriesFromConfig({
        type: 'qbittorrent',
        settings: { host: '192.168.1.999', port: 8080 },
      });
      expect(result.categories).toEqual([]);
      expect(result.error).toBe('Network unreachable');
    });
  });

  describe('testConfig edge cases', () => {
    it('catches adapter.test() network error and returns failure', async () => {
      const mockAdapter = { test: vi.fn().mockRejectedValue(new Error('Network unreachable')) };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(service as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.testConfig({
        type: 'qbittorrent',
        settings: { host: '192.168.1.999', port: 8080 },
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('Network unreachable');
    });
  });

  describe('getAdapter edge cases', () => {
    it('returns null when results.find returns undefined (client not in DB)', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const adapter = await service.getAdapter(42);
      expect(adapter).toBeNull();
    });
  });

  describe('getFirstEnabledAdapter', () => {
    it('returns null when no enabled clients exist', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const adapter = await service.getFirstEnabledAdapter();
      expect(adapter).toBeNull();
    });

    it('returns adapter for first enabled client', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([mockClient]))  // getFirstEnabled
        .mockReturnValueOnce(mockDbChain([mockClient]));  // getById inside getAdapter

      const adapter = await service.getFirstEnabledAdapter();
      expect(adapter).not.toBeNull();
    });
  });

  describe('createAdapter types', () => {
    it('creates transmission adapter', async () => {
      const transmissionClient = {
        ...mockClient,
        id: 5,
        type: 'transmission' as const,
        settings: { host: 'localhost', port: 9091, username: '', password: '', useSsl: false },
      };
      db.select.mockReturnValue(mockDbChain([transmissionClient]));

      const adapter = await service.getAdapter(5);
      expect(adapter).not.toBeNull();
    });

    it('creates sabnzbd adapter', async () => {
      const sabClient = {
        ...mockClient,
        id: 6,
        type: 'sabnzbd' as const,
        settings: { host: 'localhost', port: 8080, apiKey: 'test-key', useSsl: false },
      };
      db.select.mockReturnValue(mockDbChain([sabClient]));

      const adapter = await service.getAdapter(6);
      expect(adapter).not.toBeNull();
    });

    it('creates nzbget adapter', async () => {
      const nzbgetClient = {
        ...mockClient,
        id: 7,
        type: 'nzbget' as const,
        settings: { host: 'localhost', port: 6789, username: 'nzbget', password: '', useSsl: false },
      };
      db.select.mockReturnValue(mockDbChain([nzbgetClient]));

      const adapter = await service.getAdapter(7);
      expect(adapter).not.toBeNull();
    });

    it('creates deluge adapter', async () => {
      const delugeClient = {
        ...mockClient,
        id: 8,
        type: 'deluge' as const,
        settings: { host: 'localhost', port: 8112, password: 'deluge', useSsl: false },
      };
      db.select.mockReturnValue(mockDbChain([delugeClient]));

      const adapter = await service.getAdapter(8);
      expect(adapter).not.toBeNull();
    });

    it('creates blackhole adapter', async () => {
      const blackholeClient = {
        ...mockClient,
        id: 9,
        type: 'blackhole' as const,
        settings: { watchDir: '/downloads/watch', protocol: 'torrent' },
      };
      db.select.mockReturnValue(mockDbChain([blackholeClient]));

      const adapter = await service.getAdapter(9);
      expect(adapter).not.toBeNull();
    });

    it('throws for unknown client type', async () => {
      const unknownClient = {
        ...mockClient,
        id: 10,
        type: 'unknown' as never,
        settings: {},
      };
      db.select.mockReturnValue(mockDbChain([unknownClient]));

      await expect(service.getAdapter(10)).rejects.toThrow('Unknown download client type');
    });
  });
});
