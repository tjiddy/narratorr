import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { DEFAULT_SETTINGS } from '../../shared/schemas/settings/registry.js';
import type { Services } from './index.js';
import { filterAndRankResults } from '../services/search-pipeline.js';
import type { SearchResult } from '../../core/index.js';
import { DuplicateDownloadError } from '../services/download.service.js';

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

  describe('reject word filtering', () => {
    it('excludes result with title containing a reject word', () => {
      const results = [makeResult({ title: 'German Language Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(0);
    });

    it('excludes result when reject word differs in case (case-insensitive)', () => {
      const results = [makeResult({ title: 'GERMAN Language Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'german', '');
      expect(filtered).toHaveLength(0);
    });

    it('reject word matches as substring (e.g., "german" matches "German Language Edition")', () => {
      const results = [makeResult({ title: 'German Language Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'german', '');
      expect(filtered).toHaveLength(0);
    });

    it('excludes result if title matches ANY reject word (OR logic)', () => {
      const results = [
        makeResult({ title: 'Abridged Version' }),
        makeResult({ title: 'German Edition' }),
        makeResult({ title: 'Normal Audiobook' }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German, Abridged', '');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Normal Audiobook');
    });

    it('does NOT exclude when no reject words match', () => {
      const results = [makeResult({ title: 'Normal Audiobook' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German, Abridged', '');
      expect(filtered).toHaveLength(1);
    });

    it('applies equally to torrent and usenet results', () => {
      const results = [
        makeResult({ title: 'German Torrent', protocol: 'torrent' }),
        makeResult({ title: 'German Usenet', protocol: 'usenet' }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(0);
    });

    it('matches against rawTitle when present, falls back to title when rawTitle is undefined', () => {
      const results = [
        makeResult({ title: 'Clean Title', rawTitle: 'German Raw Title' }),
        makeResult({ title: 'German In Title Only' }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(0);
    });
  });

  describe('required word filtering', () => {
    it('includes result when title contains at least one required word', () => {
      const results = [makeResult({ title: 'Book M4B Unabridged' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', 'M4B');
      expect(filtered).toHaveLength(1);
    });

    it('excludes result when title contains no required words (list non-empty)', () => {
      const results = [makeResult({ title: 'Book MP3 Version' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', 'M4B, Unabridged');
      expect(filtered).toHaveLength(0);
    });

    it('all results pass when required word list is empty', () => {
      const results = [makeResult({ title: 'Any Book' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', '');
      expect(filtered).toHaveLength(1);
    });

    it('all results pass when required word list is undefined', () => {
      const results = [makeResult({ title: 'Any Book' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', undefined);
      expect(filtered).toHaveLength(1);
    });

    it('matching is case-insensitive substring', () => {
      const results = [makeResult({ title: 'Book m4b format' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', 'M4B');
      expect(filtered).toHaveLength(1);
    });

    it('matches against rawTitle when present, falls back to title when rawTitle is undefined', () => {
      const results = [
        makeResult({ title: 'Clean Title', rawTitle: 'Book M4B Raw' }),
        makeResult({ title: 'Book M4B In Title' }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', '', 'M4B');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('reject + required combined', () => {
    it('reject takes precedence — result matching both reject and required word is excluded', () => {
      const results = [makeResult({ title: 'German M4B Audiobook' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', 'M4B');
      expect(filtered).toHaveLength(0);
    });
  });

  describe('word list parsing edge cases', () => {
    it('empty entries after comma split are ignored', () => {
      const results = [makeResult({ title: 'German Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German, , Abridged', '');
      expect(filtered).toHaveLength(0);
    });

    it('whitespace around words is trimmed', () => {
      const results = [makeResult({ title: 'German Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', ' German , Abridged ', '');
      expect(filtered).toHaveLength(0);
    });

    it('single-word list works (no comma)', () => {
      const results = [makeResult({ title: 'German Edition' })];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(0);
    });

    it('word filtering applied BEFORE ranking (filtered results do not affect rank order)', () => {
      const results = [
        makeResult({ title: 'German High Score', matchScore: 1.0, seeders: 100 }),
        makeResult({ title: 'Normal Low Score', matchScore: 0.5, seeders: 5 }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Normal Low Score');
    });

    it('result with high matchScore but containing a reject word is still excluded', () => {
      const results = [
        makeResult({ title: 'Perfect Match German', matchScore: 1.0 }),
        makeResult({ title: 'Decent Match', matchScore: 0.7 }),
      ];
      const { results: filtered } = filterAndRankResults(results, ONE_HOUR, 0, 0, 'none', 'German', '');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].title).toBe('Decent Match');
    });
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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.durationUnknown).toBe(true);
    });

    it('returns durationUnknown: false when valid bookDuration provided', async () => {
      (services.indexer.searchAll as Mock).mockResolvedValue([]);
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ ...DEFAULT_SETTINGS.quality, minSeeders: 5 });
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
          seeders: 10,
        },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.blacklist.getBlacklistedHashes as Mock).mockResolvedValue(new Set());
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/search?q=test' });
      const body = JSON.parse(res.payload);

      expect(body.results).toHaveLength(2);
      expect(body.unsupportedResults.count).toBe(1);
      expect(body.unsupportedResults.titles).toEqual(['Book (5/20)']);
    });
  });

  describe('GET /api/search word filtering', () => {
    it('returns results filtered by reject words from quality settings', async () => {
      const results = [
        { ...mockSearchResult, title: 'German Edition' },
        { ...mockSearchResult, title: 'English Edition' },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ ...DEFAULT_SETTINGS.quality, rejectWords: 'German' });
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('English Edition');
    });

    it('returns results filtered by required words from quality settings', async () => {
      const results = [
        { ...mockSearchResult, title: 'Book M4B' },
        { ...mockSearchResult, title: 'Book MP3' },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.settings.get as Mock).mockImplementation((cat: string) => {
        if (cat === 'quality') return Promise.resolve({ ...DEFAULT_SETTINGS.quality, requiredWords: 'M4B' });
        return Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]);
      });

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('Book M4B');
    });

    it('returns unfiltered results when both word lists are empty', async () => {
      const results = [
        { ...mockSearchResult, title: 'Book One' },
        { ...mockSearchResult, title: 'Book Two' },
      ];
      (services.indexer.searchAll as Mock).mockResolvedValue(results);
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/search?q=testquery' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(2);
    });
  });

  describe('POST /api/search/grab', () => {
    it('grabs download and returns 201', async () => {
      const mockDownload = { id: 1, title: 'Test', status: 'downloading' };
      (services.downloadOrchestrator.grab as Mock).mockResolvedValue(mockDownload);

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

    it('forwards indexerId from request body to orchestrator.grab', async () => {
      const mockDownload = { id: 1, title: 'Test', status: 'downloading' };
      (services.downloadOrchestrator.grab as Mock).mockResolvedValue(mockDownload);

      await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings',
          indexerId: 7,
        },
      });

      expect(services.downloadOrchestrator.grab).toHaveBeenCalledWith(
        expect.objectContaining({ indexerId: 7 }),
      );
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
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(new Error('No download client'));

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

    // #197 — DuplicateDownloadError route handling (ERR-1)
    it('returns 409 with { code: ACTIVE_DOWNLOAD_EXISTS } when DuplicateDownloadError has ACTIVE_DOWNLOAD_EXISTS code', async () => {
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(
        new DuplicateDownloadError('Book 1 already has an active download', 'ACTIVE_DOWNLOAD_EXISTS'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ code: 'ACTIVE_DOWNLOAD_EXISTS' });
    });

    it('returns 409 with { error: message } when DuplicateDownloadError has PIPELINE_ACTIVE code (plugin-routed)', async () => {
      (services.downloadOrchestrator.grab as Mock).mockRejectedValue(
        new DuplicateDownloadError('Book 1 has pipeline download', 'PIPELINE_ACTIVE'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: {
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'Test',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Book 1 has pipeline download' });
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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

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
      (services.settings.get as Mock).mockImplementation((cat: string) =>
        Promise.resolve(DEFAULT_SETTINGS[cat as keyof typeof DEFAULT_SETTINGS]),
      );

      const res = await app.inject({ method: 'GET', url: '/api/search?q=sanderson' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.results).toHaveLength(2);
      // blacklistService should not be called since hashes array is empty
      expect(services.blacklist.getBlacklistedHashes).not.toHaveBeenCalled();
    });
  });
});
