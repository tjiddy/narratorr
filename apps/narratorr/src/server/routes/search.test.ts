import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockSearchResult = {
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  protocol: 'torrent' as const,
  indexer: 'AudioBookBay',
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 1073741824,
  seeders: 42,
};

describe('search routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/search', () => {
    it('returns SearchResponse shape with results and unsupportedResults', async () => {
      (services.indexer.searchAll as Mock).mockResolvedValue([mockSearchResult]);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('The Way of Kings');
      expect(body.unsupportedResults).toEqual({ count: 0, titles: [] });
    });

    it('returns 400 when query is too short', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=a' });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when query is missing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search' });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/search multi-part filtering', () => {
    it('filters usenet results with multi-part pattern (M > 1)', async () => {
      const results = [
        mockSearchResult,
        {
          title: 'Harry Potter Chapter 16',
          rawTitle: 'hp02.Harry Potter "28" of "30" yEnc',
          protocol: 'usenet' as const,
          indexer: 'NZBgeek',
          size: 97000000,
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=harry+potter' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('The Way of Kings');
      expect(body.unsupportedResults.count).toBe(1);
      expect(body.unsupportedResults.titles).toEqual(['hp02.Harry Potter "28" of "30" yEnc']);
    });

    it('keeps usenet results with M = 1', async () => {
      const results = [
        {
          title: 'Complete Audiobook',
          rawTitle: 'My Book "1" of "1" yEnc',
          protocol: 'usenet' as const,
          indexer: 'NZBgeek',
          size: 500000000,
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=audiobook' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(1);
      expect(body.unsupportedResults.count).toBe(0);
    });

    it('does not filter torrent results with multi-part pattern', async () => {
      const results = [
        {
          title: 'Harry Potter Chapter 16',
          rawTitle: 'hp02.Harry Potter "28" of "30"',
          protocol: 'torrent' as const,
          indexer: 'AudioBookBay',
          infoHash: 'abc123',
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.blacklist.getBlacklistedHashes as Mock).mockResolvedValue(new Set());

      const res = await app.inject({ method: 'GET', url: '/api/search?q=harry+potter' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(1);
      expect(body.unsupportedResults.count).toBe(0);
    });

    it('uses title when rawTitle is absent for usenet filtering', async () => {
      const results = [
        {
          title: 'hp02.Harry Potter "28" of "30" yEnc',
          protocol: 'usenet' as const,
          indexer: 'NZBgeek',
          size: 97000000,
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=harry+potter' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(0);
      expect(body.unsupportedResults.count).toBe(1);
    });

    it('filters mixed usenet multi-part and keeps torrent + normal usenet', async () => {
      const results = [
        { ...mockSearchResult, protocol: 'torrent' as const },
        {
          title: 'Complete Audiobook',
          protocol: 'usenet' as const,
          indexer: 'NZBgeek',
          size: 500000000,
        },
        {
          title: 'Chapter 5',
          rawTitle: 'Book (5/20)',
          protocol: 'usenet' as const,
          indexer: 'NZBgeek',
          size: 50000000,
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=test' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(2);
      expect(body.unsupportedResults.count).toBe(1);
      expect(body.unsupportedResults.titles).toEqual(['Book (5/20)']);
    });
  });

  describe('POST /api/search/grab', () => {
    it('grabs download and returns 201', async () => {
      const mockDownload = { id: 1, title: 'Test', status: 'downloading' };
      (services.download.grab as Mock).mockResolvedValue(mockDownload);

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings',
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('returns 400 for empty download URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: '',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when title is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 500 when grab fails', async () => {
      (services.download.grab as Mock).mockRejectedValue(new Error('No download client'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload).error).toBe('No download client');
    });
  });

  describe('error paths', () => {
    it('GET /api/search returns 500 when searchAll throws', async () => {
      (services.indexer.searchAll as Mock).mockRejectedValue(new Error('All indexers failed'));

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(500);
    });

    it('GET /api/search filters blacklisted results with null/empty infoHash (keeps them)', async () => {
      const results = [
        { ...mockSearchResult, infoHash: null },
        { ...mockSearchResult, infoHash: '' },
        { ...mockSearchResult, infoHash: 'abc123', title: 'Has Hash' },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.blacklist.getBlacklistedHashes as Mock).mockResolvedValue(new Set(['abc123']));

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // null and empty infoHash are falsy → kept; abc123 is blacklisted → filtered
      expect(body.results).toHaveLength(2);
    });

    it('GET /api/search returns all results when no hashes present', async () => {
      const results = [
        { ...mockSearchResult, infoHash: undefined },
        { ...mockSearchResult, infoHash: null },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(2);
      // blacklistService should not be called since hashes array is empty
      expect(services.blacklist.getBlacklistedHashes).not.toHaveBeenCalled();
    });
  });
});
