import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { ProwlarrClient } from './client.js';
import type { ProwlarrIndexer } from './types.js';

const PROWLARR_URL = 'https://prowlarr.test';

const mockIndexers: ProwlarrIndexer[] = [
  {
    id: 1,
    name: 'NZBGeek',
    protocol: 'usenet',
    enable: true,
    fields: [],
    capabilities: { categories: [
      { id: 3000, name: 'Audio', subCategories: [{ id: 3030, name: 'Audiobook' }] },
    ] },
  },
  {
    id: 2,
    name: 'TorrentLeech',
    protocol: 'torrent',
    enable: true,
    fields: [],
    capabilities: { categories: [
      { id: 3000, name: 'Audio', subCategories: [{ id: 3010, name: 'Music' }] },
    ] },
  },
  {
    id: 3,
    name: 'DisabledIndexer',
    protocol: 'torrent',
    enable: false,
    fields: [],
    capabilities: { categories: [
      { id: 3000, name: 'Audio', subCategories: [{ id: 3030, name: 'Audiobook' }] },
    ] },
  },
  {
    id: 4,
    name: 'AudioBooks.org',
    protocol: 'torrent',
    enable: true,
    fields: [],
    capabilities: { categories: [
      { id: 3030, name: 'Audiobook' },
    ] },
  },
];

describe('ProwlarrClient', () => {
  const server = useMswServer();
  let client: ProwlarrClient;

  beforeEach(() => {
    client = new ProwlarrClient(PROWLARR_URL, 'test-api-key');
  });

  describe('healthCheck', () => {
    it('returns success on 200', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/health`, ({ request }) => {
          expect(request.headers.get('X-Api-Key')).toBe('test-api-key');
          return HttpResponse.json([]);
        }),
      );

      const result = await client.healthCheck();
      expect(result).toEqual({ success: true });
    });

    it('returns failure with message on non-200', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/health`, () => {
          return new HttpResponse('Unauthorized', { status: 401 });
        }),
      );

      const result = await client.healthCheck();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/health`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await client.healthCheck();
      expect(result.success).toBe(false);
      expect(result.message).toBeTruthy();
    });
  });

  describe('getIndexers', () => {
    it('fetches and returns indexers', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/indexer`, ({ request }) => {
          expect(request.headers.get('X-Api-Key')).toBe('test-api-key');
          return HttpResponse.json(mockIndexers);
        }),
      );

      const result = await client.getIndexers();
      expect(result).toHaveLength(4);
      expect(result[0].name).toBe('NZBGeek');
    });

    it('throws on non-200', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/indexer`, () => {
          return new HttpResponse('Error', { status: 500 });
        }),
      );

      await expect(client.getIndexers()).rejects.toThrow('HTTP 500');
    });

    it('throws on malformed response payload', async () => {
      server.use(
        http.get(`${PROWLARR_URL}/api/v1/indexer`, () => {
          // Return an object instead of an array
          return HttpResponse.json({ error: 'not an array' });
        }),
      );

      await expect(client.getIndexers()).rejects.toThrow('unexpected data');
    });
  });

  describe('buildProxyIndexers', () => {
    it('creates proxy URLs with correct protocol mapping', () => {
      const proxies = client.buildProxyIndexers(mockIndexers);

      // Should exclude disabled indexer (id: 3)
      expect(proxies).toHaveLength(3);

      // Usenet -> newznab
      expect(proxies[0]).toEqual({
        prowlarrId: 1,
        name: 'NZBGeek',
        type: 'newznab',
        apiUrl: `${PROWLARR_URL}/1/`,
        apiKey: 'test-api-key',
      });

      // Torrent -> torznab
      expect(proxies[1]).toEqual({
        prowlarrId: 2,
        name: 'TorrentLeech',
        type: 'torznab',
        apiUrl: `${PROWLARR_URL}/2/`,
        apiKey: 'test-api-key',
      });
    });

    it('strips trailing slashes from base URL', () => {
      const trailingClient = new ProwlarrClient(`${PROWLARR_URL}/`, 'key');
      const proxies = trailingClient.buildProxyIndexers([mockIndexers[0]]);
      expect(proxies[0].apiUrl).toBe(`${PROWLARR_URL}/1/`);
    });
  });

  describe('filterByCategories', () => {
    it('returns all indexers when categories is empty', () => {
      const result = client.filterByCategories(mockIndexers, []);
      expect(result).toHaveLength(4);
    });

    it('filters by top-level category', () => {
      const result = client.filterByCategories(mockIndexers, [3030]);
      // NZBGeek (sub 3030), DisabledIndexer (sub 3030), AudioBooks.org (top 3030)
      expect(result).toHaveLength(3);
      expect(result.map(i => i.name)).toEqual(['NZBGeek', 'DisabledIndexer', 'AudioBooks.org']);
    });

    it('filters by subcategory', () => {
      const result = client.filterByCategories(mockIndexers, [3010]);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('TorrentLeech');
    });

    it('handles indexers with null or missing capabilities', () => {
      const indexersWithNullCaps: ProwlarrIndexer[] = [
        { id: 10, name: 'NullCaps', protocol: 'torrent', enable: true, fields: [], capabilities: null },
        { id: 11, name: 'NoCaps', protocol: 'usenet', enable: true, fields: [] } as ProwlarrIndexer,
        { id: 12, name: 'NullCats', protocol: 'torrent', enable: true, fields: [], capabilities: { categories: null } },
        ...mockIndexers,
      ];

      const result = client.filterByCategories(indexersWithNullCaps, [3030]);
      // NullCaps, NoCaps, NullCats should be excluded (no matching categories), others same as before
      expect(result).toHaveLength(3);
      expect(result.map(i => i.name)).toEqual(['NZBGeek', 'DisabledIndexer', 'AudioBooks.org']);
    });
  });
});
