import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';
import { ProwlarrSyncService } from './prowlarr-sync.service.js';

// Mock the ProwlarrClient
vi.mock('@narratorr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@narratorr/core')>();
  return {
    ...actual,
    ProwlarrClient: vi.fn().mockImplementation(() => mockProwlarrClient),
  };
});

const mockProwlarrClient = {
  healthCheck: vi.fn(),
  getIndexers: vi.fn(),
  buildProxyIndexers: vi.fn(),
  filterByCategories: vi.fn(),
};

const prowlarrConfig = {
  url: 'https://prowlarr.test',
  apiKey: 'test-key',
  syncMode: 'addOnly' as const,
  categories: [3030],
};

const mockRemoteIndexers = [
  { id: 1, name: 'NZBGeek', protocol: 'usenet', enable: true, fields: [], categories: [] },
  { id: 2, name: 'TorrentLeech', protocol: 'torrent', enable: true, fields: [], categories: [] },
];

const mockProxyIndexers = [
  { prowlarrId: 1, name: 'NZBGeek', type: 'newznab' as const, apiUrl: 'https://prowlarr.test/1/', apiKey: 'test-key' },
  { prowlarrId: 2, name: 'TorrentLeech', type: 'torznab' as const, apiUrl: 'https://prowlarr.test/2/', apiKey: 'test-key' },
];

describe('ProwlarrSyncService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: ProwlarrSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    service = new ProwlarrSyncService(db as any, createMockLogger() as any);

    // Default mock setup
    mockProwlarrClient.getIndexers.mockResolvedValue(mockRemoteIndexers);
    mockProwlarrClient.filterByCategories.mockReturnValue(mockRemoteIndexers);
    mockProwlarrClient.buildProxyIndexers.mockReturnValue(mockProxyIndexers);
  });

  describe('getConfig', () => {
    it('returns config when found', async () => {
      db.select.mockReturnValue(mockDbChain([{ key: 'prowlarr', value: prowlarrConfig }]));
      const result = await service.getConfig();
      expect(result).toEqual(prowlarrConfig);
    });

    it('returns null when not configured', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getConfig();
      expect(result).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('upserts config into settings', async () => {
      db.insert.mockReturnValue(mockDbChain());
      await service.saveConfig(prowlarrConfig);
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('testConnection', () => {
    it('delegates to ProwlarrClient healthCheck', async () => {
      mockProwlarrClient.healthCheck.mockResolvedValue({ success: true });
      const result = await service.testConnection('https://prowlarr.test', 'key');
      expect(result).toEqual({ success: true });
    });
  });

  describe('preview', () => {
    it('marks all remote indexers as new when no local prowlarr indexers exist', async () => {
      // No local prowlarr indexers
      db.select.mockReturnValue(mockDbChain([]));

      const items = await service.preview(prowlarrConfig);
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ action: 'new', name: 'NZBGeek', type: 'newznab', prowlarrId: 1 });
      expect(items[1]).toEqual({ action: 'new', name: 'TorrentLeech', type: 'torznab', prowlarrId: 2 });
    });

    it('marks matching indexers as unchanged when config matches', async () => {
      const localIndexers = [
        { id: 10, name: 'NZBGeek', type: 'newznab', source: 'prowlarr', sourceIndexerId: 1, settings: { apiUrl: 'https://prowlarr.test/1/', apiKey: 'test-key' } },
      ];
      db.select.mockReturnValue(mockDbChain(localIndexers));

      const items = await service.preview(prowlarrConfig);
      const nzbGeek = items.find(i => i.prowlarrId === 1);
      expect(nzbGeek?.action).toBe('unchanged');
    });

    it('marks changed indexers as updated in fullSync mode', async () => {
      const localIndexers = [
        { id: 10, name: 'OldName', type: 'newznab', source: 'prowlarr', sourceIndexerId: 1, settings: { apiUrl: 'https://old-url/', apiKey: 'old-key' } },
      ];
      db.select.mockReturnValue(mockDbChain(localIndexers));

      const fullSyncConfig = { ...prowlarrConfig, syncMode: 'fullSync' as const };
      const items = await service.preview(fullSyncConfig);
      const updated = items.find(i => i.prowlarrId === 1);
      expect(updated?.action).toBe('updated');
      expect(updated?.changes).toContain('name');
      expect(updated?.changes).toContain('apiUrl');
    });

    it('marks changed indexers as unchanged in addOnly mode (no updates)', async () => {
      const localIndexers = [
        { id: 10, name: 'OldName', type: 'newznab', source: 'prowlarr', sourceIndexerId: 1, settings: { apiUrl: 'https://old-url/', apiKey: 'old-key' } },
      ];
      db.select.mockReturnValue(mockDbChain(localIndexers));

      const items = await service.preview(prowlarrConfig);
      const item = items.find(i => i.prowlarrId === 1);
      expect(item?.action).toBe('unchanged');
    });

    it('marks removed indexers in fullSync mode', async () => {
      const localIndexers = [
        { id: 10, name: 'Removed', type: 'torznab', source: 'prowlarr', sourceIndexerId: 99, settings: {} },
      ];
      db.select.mockReturnValue(mockDbChain(localIndexers));

      const fullSyncConfig = { ...prowlarrConfig, syncMode: 'fullSync' as const };
      const items = await service.preview(fullSyncConfig);
      const removed = items.find(i => i.prowlarrId === 99);
      expect(removed?.action).toBe('removed');
    });

    it('does not mark removed indexers in addOnly mode', async () => {
      const localIndexers = [
        { id: 10, name: 'StillHere', type: 'torznab', source: 'prowlarr', sourceIndexerId: 99, settings: {} },
      ];
      db.select.mockReturnValue(mockDbChain(localIndexers));

      const items = await service.preview(prowlarrConfig);
      const removed = items.find(i => i.prowlarrId === 99);
      expect(removed).toBeUndefined();
    });
  });

  describe('apply', () => {
    it('creates new indexers for selected new items', async () => {
      db.insert.mockReturnValue(mockDbChain());

      const result = await service.apply(prowlarrConfig, {
        items: [
          { prowlarrId: 1, action: 'new', selected: true },
          { prowlarrId: 2, action: 'new', selected: false },
        ],
      });

      expect(result.added).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      expect(db.insert).toHaveBeenCalled();
    });

    it('updates indexers for selected updated items', async () => {
      const localRow = { id: 10, name: 'Old', source: 'prowlarr', sourceIndexerId: 1 };
      db.select.mockReturnValue(mockDbChain([localRow]));
      db.update.mockReturnValue(mockDbChain());

      const result = await service.apply(prowlarrConfig, {
        items: [
          { prowlarrId: 1, action: 'updated', selected: true },
        ],
      });

      expect(result.updated).toBe(1);
      expect(db.update).toHaveBeenCalled();
    });

    it('removes indexers for selected removed items', async () => {
      const localRow = { id: 10, name: 'ToRemove', source: 'prowlarr', sourceIndexerId: 1 };
      db.select.mockReturnValue(mockDbChain([localRow]));
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.apply(prowlarrConfig, {
        items: [
          { prowlarrId: 1, action: 'removed', selected: true },
        ],
      });

      expect(result.removed).toBe(1);
      expect(db.delete).toHaveBeenCalled();
    });

    it('skips unselected items', async () => {
      const result = await service.apply(prowlarrConfig, {
        items: [
          { prowlarrId: 1, action: 'new', selected: false },
          { prowlarrId: 2, action: 'removed', selected: false },
        ],
      });

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
    });
  });
});
