import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import { filterAndRankResults } from './search.js';
import type { SearchResult } from '../../core/index.js';

const mockSearchResult = {
  title: 'The Way of Kings',
  author: 'Brandon Sanderson',
  protocol: 'torrent' as const,
  indexer: 'AudioBookBay',
  downloadUrl: 'magnet:?xt=urn:btih:abc123',
  size: 1073741824,
  seeders: 42,
};

// Helper to build SearchResult with specific fields
function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Book',
    protocol: 'torrent',
    indexer: 'test',
    seeders: 10,
    size: 500 * 1024 * 1024, // 500 MB
    downloadUrl: 'magnet:?xt=urn:btih:aaa',
    ...overrides,
  };
}

describe('filterAndRankResults', () => {
  const ONE_HOUR = 3600; // 1 hour in seconds

  it('returns durationUnknown: true when bookDuration is undefined', () => {
    const { durationUnknown } = filterAndRankResults([], undefined, 0, 0, 'none');
    expect(durationUnknown).toBe(true);
  });

  it('returns durationUnknown: true when bookDuration is 0', () => {
    const { durationUnknown } = filterAndRankResults([], 0, 0, 0, 'none');
    expect(durationUnknown).toBe(true);
  });

  it('returns durationUnknown: false when bookDuration is positive', () => {
    const { durationUnknown } = filterAndRankResults([], ONE_HOUR, 0, 0, 'none');
    expect(durationUnknown).toBe(false);
  });

  it('filters torrents below minSeeders', () => {
    const results = [
      makeResult({ seeders: 3, title: 'Low Seeds' }),
      makeResult({ seeders: 10, title: 'High Seeds' }),
    ];
    const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 5, 'none');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('High Seeds');
  });

  it('does NOT filter usenet results by minSeeders', () => {
    const results = [
      makeResult({ protocol: 'usenet', seeders: 0, title: 'Usenet Result' }),
      makeResult({ protocol: 'torrent', seeders: 0, title: 'Torrent No Seeds' }),
    ];
    const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 5, 'none');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('Usenet Result');
  });

  it('filters results below grabFloor MB/hr (when duration known)', () => {
    // 100 MB over 1 hour = 100 MB/hr. Set floor at 150 to filter it out.
    const results = [
      makeResult({ size: 100 * 1024 * 1024, title: 'Low Quality' }),
      makeResult({ size: 200 * 1024 * 1024, title: 'High Quality' }),
    ];
    const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 150, 0, 'none');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('High Quality');
  });

  it('passes through results with no size (cannot calculate) even when grabFloor is set', () => {
    const results = [
      makeResult({ size: undefined, title: 'No Size' }),
    ];
    const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 150, 0, 'none');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('No Size');
  });

  it('skips grabFloor filtering when duration is unknown', () => {
    // 10 MB over unknown duration — should pass through even with high floor
    const results = [
      makeResult({ size: 10 * 1024 * 1024, title: 'Tiny' }),
    ];
    const { results: filtered } = filterAndRankResults(results, undefined, 9999, 0, 'none');
    expect(filtered).toHaveLength(1);
  });

  it('sorts by matchScore when difference > 0.1', () => {
    const results = [
      makeResult({ matchScore: 0.5, title: 'Low Score', seeders: 100 }),
      makeResult({ matchScore: 0.9, title: 'High Score', seeders: 1 }),
    ];
    const { results: sorted } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none');
    expect(sorted[0].title).toBe('High Score');
    expect(sorted[1].title).toBe('Low Score');
  });

  it('sorts by MB/hr desc when matchScore is similar (and duration known)', () => {
    const results = [
      makeResult({ matchScore: 0.8, size: 100 * 1024 * 1024, title: 'Small' }),
      makeResult({ matchScore: 0.85, size: 500 * 1024 * 1024, title: 'Large' }),
    ];
    const { results: sorted } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none');
    // Score diff is 0.05 (<= 0.1), so MB/hr wins. Large = 500 MB/hr > Small = 100 MB/hr
    expect(sorted[0].title).toBe('Large');
    expect(sorted[1].title).toBe('Small');
  });

  it('sorts by protocol preference when MB/hr is equal', () => {
    const results = [
      makeResult({ matchScore: 0.8, size: 200 * 1024 * 1024, protocol: 'torrent', title: 'Torrent' }),
      makeResult({ matchScore: 0.8, size: 200 * 1024 * 1024, protocol: 'usenet', title: 'Usenet' }),
    ];
    const { results: sorted } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'usenet');
    expect(sorted[0].title).toBe('Usenet');
    expect(sorted[1].title).toBe('Torrent');
  });

  it('sorts by seeders as final tiebreaker', () => {
    const results = [
      makeResult({ matchScore: 0.8, size: 200 * 1024 * 1024, seeders: 5, title: 'Few Seeds' }),
      makeResult({ matchScore: 0.8, size: 200 * 1024 * 1024, seeders: 50, title: 'Many Seeds' }),
    ];
    const { results: sorted } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none');
    expect(sorted[0].title).toBe('Many Seeds');
    expect(sorted[1].title).toBe('Few Seeds');
  });

  it('returns empty array when all results filtered out', () => {
    const results = [
      makeResult({ seeders: 1 }),
      makeResult({ seeders: 2 }),
    ];
    const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 10, 'none');
    expect(filtered).toHaveLength(0);
  });
});

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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

    it('returns durationUnknown: true when no bookDuration param', async () => {
      (services.indexer.searchAll as Mock).mockResolvedValue([]);
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.durationUnknown).toBe(true);
    });

    it('returns durationUnknown: false when valid bookDuration provided', async () => {
      (services.indexer.searchAll as Mock).mockResolvedValue([]);
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery&bookDuration=3600' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.durationUnknown).toBe(false);
    });

    it('returns 400 for invalid bookDuration (e.g. abc)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery&bookDuration=abc' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toMatch(/bookDuration/i);
    });

    it('returns 400 for negative bookDuration', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery&bookDuration=-100' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toMatch(/bookDuration/i);
    });

    it('applies quality settings from settingsService', async () => {
      // Result with 2 seeders — should be filtered by minSeeders: 5
      const lowSeedResult = { ...mockSearchResult, seeders: 2, title: 'Low Seeds' };
      const highSeedResult = { ...mockSearchResult, seeders: 20, title: 'High Seeds' };
      (services.indexer.searchAll as Mock).mockResolvedValue([lowSeedResult, highSeedResult]);
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 5, protocolPreference: 'none' });
        return Promise.resolve({});
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('High Seeds');
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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

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
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      // null and empty infoHash are falsy -> kept; abc123 is blacklisted -> filtered
      expect(body.results).toHaveLength(2);
    });

    it('GET /api/search returns all results when no hashes present', async () => {
      const results = [
        { ...mockSearchResult, infoHash: undefined },
        { ...mockSearchResult, infoHash: null },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.settings.get as Mock).mockImplementation((category: string) => {
        if (category === 'quality') return Promise.resolve({ grabFloor: 0, minSeeders: 0, protocolPreference: 'none' });
        return Promise.resolve({});
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(2);
      // blacklistService should not be called since hashes array is empty
      expect(services.blacklist.getBlacklistedHashes).not.toHaveBeenCalled();
    });
  });
});
