import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { DownloadClientService } from './download-client.service.js';

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
    service = new DownloadClientService(db as any, createMockLogger() as any);
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
});
