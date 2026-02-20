import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { DownloadClientService } from './download-client.service.js';
import type { Db } from '@narratorr/db';

const now = new Date();

const mockClient = {
  id: 1,
  name: 'qBittorrent',
  type: 'qbittorrent' as const,
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false },
  createdAt: now,
};

describe('DownloadClientService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: DownloadClientService;

  beforeEach(() => {
    db = createMockDb();
    service = new DownloadClientService(db as unknown as Db, createMockLogger());
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
      vi.spyOn(service as never, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('ECONNREFUSED');
    });

    it('returns "Unknown error" for non-Error thrown values', async () => {
      const throwingClient = { ...mockClient };
      db.select.mockReturnValue(mockDbChain([throwingClient]));

      const mockAdapter = { test: vi.fn().mockRejectedValue('string error') };
      vi.spyOn(service as never, 'createAdapter').mockReturnValue(mockAdapter as never);

      const result = await service.test(1);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Unknown error');
    });
  });

  describe('testConfig edge cases', () => {
    it('catches adapter.test() network error and returns failure', async () => {
      const mockAdapter = { test: vi.fn().mockRejectedValue(new Error('Network unreachable')) };
      vi.spyOn(service as never, 'createAdapter').mockReturnValue(mockAdapter as never);

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

    it('throws for unknown client type', async () => {
      const unknownClient = {
        ...mockClient,
        id: 8,
        type: 'deluge' as never,
        settings: {},
      };
      db.select.mockReturnValue(mockDbChain([unknownClient]));

      await expect(service.getAdapter(8)).rejects.toThrow('Unknown download client type');
    });
  });
});
