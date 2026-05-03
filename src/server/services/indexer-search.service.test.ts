import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { SearchResult } from '../../core/index.js';
import type { SettingsService } from './settings.service.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const mockIndexer = createMockDbIndexer();

/** Wraps a SearchResult[] into the IndexerSearchResponse shape that adapter.search now returns. */
function searchResponse(results: Partial<SearchResult>[]): {
  results: SearchResult[];
  parseStats: { itemsObserved: number; kept: number; dropped: { emptyTitle: number; noUrl: number; other: number } };
  debugTrace: never[];
} {
  return {
    results: results as SearchResult[],
    parseStats: { itemsObserved: results.length, kept: results.length, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

describe('IndexerSearchService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: IndexerService;
  let searchService: IndexerSearchService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
    searchService = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()), service);
  });

  afterEach(() => {
    _resetKey();
  });

  describe('getRssCapableIndexers', () => {
    it('returns only newznab and torznab enabled indexers', async () => {
      const newznab = createMockDbIndexer({ id: 1, name: 'Newznab', type: 'newznab', enabled: true });
      const torznab = createMockDbIndexer({ id: 2, name: 'Torznab', type: 'torznab', enabled: true });
      const abb = createMockDbIndexer({ id: 3, name: 'ABB', type: 'abb', enabled: true });
      db.select.mockReturnValue(mockDbChain([newznab, torznab, abb]));

      const result = await searchService.getRssCapableIndexers();
      expect(result).toHaveLength(2);
      expect(result.map((i: { name: string }) => i.name)).toEqual(['Newznab', 'Torznab']);
    });

    it('returns empty array when no RSS-capable indexers are enabled', async () => {
      const abb = createMockDbIndexer({ id: 1, name: 'ABB', type: 'abb', enabled: true });
      db.select.mockReturnValue(mockDbChain([abb]));

      const result = await searchService.getRssCapableIndexers();
      expect(result).toEqual([]);
    });
  });

  describe('pollRss', () => {
    it('calls adapter.search with empty query and parses release names', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.pollRss(torznabIndexer);

      expect(mockAdapter.search).toHaveBeenCalledWith('');
      expect(results).toHaveLength(1);
      expect(results[0]!.author).toBe('Brandon Sanderson');
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    it('returns empty array when feed has no items', async () => {
      const newznabIndexer = createMockDbIndexer({ id: 1, name: 'Newznab', type: 'newznab', settings: { apiUrl: 'https://nzb.test', apiKey: 'key' } });
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.pollRss(newznabIndexer);
      expect(results).toEqual([]);
    });

    it('populates indexerId from indexer row on all returned results', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 7, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.pollRss(torznabIndexer);

      expect(results).toHaveLength(1);
      expect(results[0]!.indexerId).toBe(7);
    });

    it('populates indexerId on multiple results (all stamped, not just first)', async () => {
      const torznabIndexer = createMockDbIndexer({ id: 3, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Author A - Book One', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Author B - Book Two', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Author C - Book Three', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.pollRss(torznabIndexer);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.indexerId).toBe(3);
      }
    });

    it('emits the canonical "Indexer search complete" summary from pollRss', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      const torznabIndexer = createMockDbIndexer({
        id: 1,
        name: 'Torznab',
        type: 'torznab',
        settings: { apiUrl: 'https://tracker.test', apiKey: 'key' },
      });
      const mockResult = { title: 'Book', indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue(searchResponse([mockResult])),
        test: vi.fn(),
      };
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.pollRss(torznabIndexer);

      const summaryCalls = (log.debug as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, msg]) => msg === 'Indexer search complete',
      );
      expect(summaryCalls).toHaveLength(1);
      expect(summaryCalls[0]?.[0]).toEqual(
        expect.objectContaining({ indexer: 'Torznab', type: 'torznab', itemsObserved: 1, kept: 1 }),
      );
    });
  });

  describe('searchAll', () => {
    it('searches enabled indexers and aggregates results', async () => {
      const mockResult = {
        title: 'The Way of Kings',
        indexer: 'AudioBookBay',
        protocol: 'torrent' as const,
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
      };

      // Mock the DB query for enabled indexers
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      // We need to mock the adapter's search method
      // Since getAdapter creates a real ABB adapter, we spy on the service
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([mockResult])),
        test: vi.fn(),
      };

      // Override getAdapter to return our mock
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    it('populates indexerId on results from the indexer row id', async () => {
      const mockResult = {
        title: 'The Way of Kings',
        indexer: 'AudioBookBay',
        protocol: 'torrent' as const,
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
      };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([mockResult])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson');
      expect(results[0]!.indexerId).toBe(mockIndexer.id);
    });

    it('continues searching when one indexer errors', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const errorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('Connection failed')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'Indexer2' }])),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Book');
    });

    it('returns empty array when all indexers fail', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const errorAdapter1 = {
        search: vi.fn().mockRejectedValue(new Error('Timeout')),
        test: vi.fn(),
      };
      const errorAdapter2 = {
        search: vi.fn().mockRejectedValue(new Error('DNS failure')),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter1 as never)
        .mockResolvedValueOnce(errorAdapter2 as never);

      const results = await searchService.searchAll('test');
      expect(results).toEqual([]);
    });

    it('returns empty array when no enabled indexers', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const results = await searchService.searchAll('test');
      expect(results).toEqual([]);
    });

    it('returns partial results when one succeeds and one fails', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const goodAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Book A', indexer: 'ABB' },
          { title: 'Book B', indexer: 'ABB' },
        ])),
        test: vi.fn(),
      };
      const errorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('Network error')),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(goodAdapter as never)
        .mockResolvedValueOnce(errorAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results).toHaveLength(2);
      expect(results[0]!.title).toBe('Book A');
      expect(results[1]!.title).toBe('Book B');
    });
  });

  describe('release name parsing integration', () => {
    it('populates author and title from parsed release name on torznab results', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson');
      expect(results[0]!.author).toBe('Brandon Sanderson');
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    it('sets rawTitle to original indexer title before parsing', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson');
      expect(results[0]!.rawTitle).toBe('Brandon Sanderson - The Way of Kings');
    });

    it('does not overwrite author when adapter already set it (ABB case)', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'The Way of Kings', author: 'Brandon Sanderson', indexer: 'ABB', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson');
      expect(results[0]!.author).toBe('Brandon Sanderson');
      expect(results[0]!.rawTitle).toBeUndefined();
    });

    it('uses cleaned title even when parsing extracts no author', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Some Random Title', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('random');
      // Title unchanged by parser, so rawTitle is not set
      expect(results[0]!.title).toBe('Some Random Title');
      expect(results[0]!.author).toBeUndefined();
      expect(results[0]!.rawTitle).toBeUndefined();
    });

    it('sets rawTitle and cleans title when parser strips noise without extracting author', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Some Random Title [MP3] [ENG]', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('random');
      expect(results[0]!.title).toBe('Some Random Title');
      expect(results[0]!.rawTitle).toBe('Some Random Title [MP3] [ENG]');
      expect(results[0]!.author).toBeUndefined();
    });

    it('logs unparsed non-hash release names at debug level', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Some Random Title', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.searchAll('random');
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ rawTitle: 'Some Random Title' }),
        'Unparsed release name',
      );
    });
  });

  describe('fuzzy scoring', () => {
    it('sets matchScore on results when title context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson', { title: 'The Way of Kings', author: 'Brandon Sanderson' });
      expect(results[0]!.matchScore).toBeDefined();
      expect(results[0]!.matchScore).toBeGreaterThan(0.5);
    });

    it('sorts results by matchScore descending when context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Completely Wrong Book', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Brandon Sanderson - The Way of Kings', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('sanderson', { title: 'The Way of Kings' });
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    it('does not score or sort when no context is provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Book B', indexer: 'Torznab', protocol: 'torrent' },
          { title: 'Book A', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('books');
      expect(results[0]!.matchScore).toBeUndefined();
      expect(results[0]!.title).toBe('Book B'); // order preserved
    });
  });

  describe('FlareSolverr proxy support — search-side', () => {
    it('searchAll catches thrown proxy errors and continues to next indexer', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const proxyErrorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('FlareSolverr proxy unreachable at http://proxy:8191')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Found Book', indexer: 'Indexer2', protocol: 'torrent' }])),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(proxyErrorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Found Book');
    });
  });

  describe('proxy integration — search-side', () => {
    let proxyDb: ReturnType<typeof createMockDb>;
    let proxyService: IndexerService;
    let proxySearchService: IndexerSearchService;
    let mockSettingsService: ReturnType<typeof createMockSettingsService>;

    beforeEach(() => {
      proxyDb = createMockDb();
      mockSettingsService = createMockSettingsService({ network: { proxyUrl: 'socks5://proxy:1080' } });
      proxyService = new IndexerService(
        inject<Db>(proxyDb),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(mockSettingsService),
      );
      proxySearchService = new IndexerSearchService(
        inject<Db>(proxyDb),
        inject<FastifyBaseLogger>(createMockLogger()),
        proxyService,
        inject<SettingsService>(mockSettingsService),
      );
    });

    it('searchAll uses proxy for proxy-enabled indexers', async () => {
      const proxyIndexer = createMockDbIndexer({
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });
      proxyDb.select.mockReturnValue(mockDbChain([proxyIndexer]));

      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Proxied Book', indexer: 'ABB', protocol: 'torrent' }])),
        test: vi.fn(),
      };
      // Spy on createAdapter to verify proxyUrl is passed, but return our mock adapter
      const createSpy = // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxyService as any, 'createAdapter').mockReturnValue(mockAdapter as never);

      const results = await proxySearchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Proxied Book');
      // getAdapter calls getProxyUrl which calls settingsService.get('network')
      expect(mockSettingsService.get).toHaveBeenCalledWith('network');
      expect(createSpy).toHaveBeenCalledWith(proxyIndexer, 'socks5://proxy:1080');
    });

    it('searchAll catches ProxyError and continues with other indexers', async () => {
      const { ProxyError } = await import('../../core/indexers/errors.js');
      const indexer1 = createMockDbIndexer({
        id: 1,
        settings: { hostname: 'audiobookbay.lu', pageLimit: 2, useProxy: true },
      });
      const indexer2 = createMockDbIndexer({ id: 2, name: 'Indexer2' });
      proxyDb.select.mockReturnValue(mockDbChain([indexer1, indexer2]));

      const proxyErrorAdapter = {
        search: vi.fn().mockRejectedValue(new ProxyError('SOCKS5 proxy connection refused')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Good Book', indexer: 'Indexer2', protocol: 'torrent' }])),
        test: vi.fn(),
      };

      vi.spyOn(proxyService, 'getAdapter')
        .mockResolvedValueOnce(proxyErrorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await proxySearchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Good Book');
    });
  });

  // ── #229 Observability — logging improvements ───────────────────────────
  describe('logging improvements (#229)', () => {
    it('per-indexer search emits the canonical "Indexer search complete" summary with parse stats', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      const mockResult = { title: 'Book', indexer: 'AudioBookBay', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockResolvedValue(searchResponse([mockResult])), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.searchAll('test');

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexer: 'AudioBookBay', type: 'abb', itemsObserved: 1, kept: 1 }),
        'Indexer search complete',
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'test', indexerCount: 1, perIndexerCounts: { AudioBookBay: 1 } }),
        'Search aggregated across indexers',
      );
    });

    it('per-indexer search that throws does not emit elapsed time log', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockRejectedValue(new Error('timeout')), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.searchAll('test');

      expect(log.debug).not.toHaveBeenCalledWith(
        expect.objectContaining({ indexer: 'AudioBookBay', elapsedMs: expect.any(Number) }),
        'Indexer search completed',
      );
    });

    it('parseReleaseNames debug log includes indexerName field', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      const unparseable = { title: 'Some Random Title Without Author Delimiter', indexer: 'AudioBookBay', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'abb', name: 'AudioBookBay', search: vi.fn().mockResolvedValue(searchResponse([unparseable])), test: vi.fn() };
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.searchAll('test');

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexerName: 'AudioBookBay' }),
        'Unparsed release name',
      );
    });

    it('parseReleaseNames called from pollRss passes indexer name', async () => {
      const log = createMockLogger();
      const svc = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
      const searchSvc = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), svc);
      const torznabIndexer = createMockDbIndexer({ id: 1, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const unparseable = { title: 'UnparseableTitle', indexer: 'Torznab', protocol: 'torrent' as const, downloadUrl: 'magnet:?xt=urn:btih:abc' };
      const mockAdapter = { type: 'torznab', name: 'Torznab', search: vi.fn().mockResolvedValue(searchResponse([unparseable])), test: vi.fn() };
      vi.spyOn(svc, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await searchSvc.pollRss(torznabIndexer);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ indexerName: 'Torznab' }),
        'Unparsed release name',
      );
    });
  });

  describe('searchAll — concurrent execution', () => {
    it('invokes second adapter before first resolves (proves concurrent fan-out)', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      // Adapter1 blocks on a deferred promise — if execution is sequential,
      // adapter2.search will never be called until adapter1 resolves.
      let resolveAdapter1!: (value: unknown) => void;
      const adapter1Promise = new Promise<unknown>((resolve) => { resolveAdapter1 = resolve; });

      const adapter1 = {
        search: vi.fn().mockReturnValue(adapter1Promise),
        test: vi.fn(),
      };
      const adapter2 = {
        search: vi.fn().mockImplementation(async () => {
          // Assert adapter1.search was already called but NOT yet resolved
          expect(adapter1.search).toHaveBeenCalledTimes(1);
          return searchResponse([{ title: 'Book2', indexer: 'Indexer2' }]);
        }),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(adapter1 as never)
        .mockResolvedValueOnce(adapter2 as never);

      const searchPromise = searchService.searchAll('test');

      // Wait a tick to let both adapter.search calls be initiated
      await new Promise(resolve => setTimeout(resolve, 0));

      // At this point, adapter2 should already have been called (concurrent)
      expect(adapter2.search).toHaveBeenCalledTimes(1);

      // Now resolve adapter1 so searchAll can complete
      resolveAdapter1(searchResponse([{ title: 'Book1', indexer: 'ABB' }]));
      const results = await searchPromise;
      expect(results).toHaveLength(2);
    });

    it('collects results from fulfilled indexers when one rejects', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const errorAdapter = {
        search: vi.fn().mockRejectedValue(new Error('Connection failed')),
        test: vi.fn(),
      };
      const goodAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'Indexer2' }])),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Book');
    });

    it('returns empty array when all indexers reject', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const err1 = { search: vi.fn().mockRejectedValue(new Error('Timeout')), test: vi.fn() };
      const err2 = { search: vi.fn().mockRejectedValue(new Error('DNS')), test: vi.fn() };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(err1 as never)
        .mockResolvedValueOnce(err2 as never);

      const results = await searchService.searchAll('test');
      expect(results).toEqual([]);
    });

    it('logs warning with err key for rejected indexers (Pino serialization)', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const failError = new Error('Connection refused');
      const errorAdapter = { search: vi.fn().mockRejectedValue(failError), test: vi.fn() };
      const goodAdapter = { search: vi.fn().mockResolvedValue(searchResponse([])), test: vi.fn() };

      const log = inject<FastifyBaseLogger>(createMockLogger());
      const svc = new IndexerService(inject<Db>(db), log);
      const searchSvc = new IndexerSearchService(inject<Db>(db), log, svc);
      vi.spyOn(svc, 'getAdapter')
        .mockResolvedValueOnce(errorAdapter as never)
        .mockResolvedValueOnce(goodAdapter as never);

      await searchSvc.searchAll('test');

      const errorCall = vi.mocked(log.warn).mock.calls.find(
        ([, msg]) => typeof msg === 'string' && msg.includes('Error searching indexer'),
      );
      expect(errorCall).toBeDefined();
      const [payload] = errorCall as [Record<string, unknown>, string];
      expect(payload.indexer).toBe(mockIndexer.name);
      // `error` must be the serialized plain object, NOT the original Error instance —
      // covers the manual MemberExpression migration that lint cannot enforce.
      expect(payload.error).not.toBe(failError);
      expect(payload.error).not.toBeInstanceOf(Error);
      expect(payload.error).toEqual(
        expect.objectContaining({
          message: failError.message,
          type: 'Error',
          stack: expect.any(String),
        }),
      );
    });

    it('applies match scoring and sorting after concurrent collection', async () => {
      const indexer2 = { ...mockIndexer, id: 2, name: 'Indexer2' };
      db.select.mockReturnValue(mockDbChain([mockIndexer, indexer2]));

      const adapter1 = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Wrong Book', indexer: 'ABB' }])),
        test: vi.fn(),
      };
      const adapter2 = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'The Way of Kings', indexer: 'Indexer2', author: 'Sanderson' }])),
        test: vi.fn(),
      };

      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(adapter1 as never)
        .mockResolvedValueOnce(adapter2 as never);

      const results = await searchService.searchAll('sanderson', { title: 'The Way of Kings', author: 'Sanderson' });
      // Better match should be sorted first
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    it('works correctly with a single enabled indexer', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const adapter = {
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'ABB' }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const results = await searchService.searchAll('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Book');
    });
  });

  describe('searchAllStreaming', () => {
    const mockIndexer2 = createMockDbIndexer({ id: 2, name: 'MAM', type: 'myanonamouse' });

    it('calls onComplete for each successful indexer', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer, mockIndexer2]));

      const adapter1 = { search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book1', indexer: 'ABB' }])), test: vi.fn() };
      const adapter2 = { search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book2', indexer: 'MAM' }])), test: vi.fn() };
      let callCount = 0;
      vi.spyOn(service, 'getAdapter').mockImplementation(async () => {
        callCount++;
        return (callCount === 1 ? adapter1 : adapter2) as never;
      });

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());
      controllers.set(2, new AbortController());

      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError });

      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name, 1, expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(2, 'MAM', 1, expect.any(Number));
      expect(onError).not.toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('calls onError for failed indexer and continues', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer, mockIndexer2]));

      const adapter1 = { search: vi.fn().mockRejectedValue(new Error('Timeout')), test: vi.fn() };
      const adapter2 = { search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book2', indexer: 'MAM' }])), test: vi.fn() };
      let callCount = 0;
      vi.spyOn(service, 'getAdapter').mockImplementation(async () => {
        callCount++;
        return (callCount === 1 ? adapter1 : adapter2) as never;
      });

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());
      controllers.set(2, new AbortController());

      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError });

      expect(onError).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name, 'Timeout', expect.any(Number));
      expect(onComplete).toHaveBeenCalledWith(2, 'MAM', 1, expect.any(Number));
      expect(results).toHaveLength(1);
    });

    it('excludes cancelled indexer results and calls onCancelled', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const controller = new AbortController();
      controller.abort();
      const adapter = { search: vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')), test: vi.fn() };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, controller);

      const onComplete = vi.fn();
      const onError = vi.fn();
      const onCancelled = vi.fn();

      const results = await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError, onCancelled });

      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled(); // Cancelled, not errored
      expect(onCancelled).toHaveBeenCalledWith(mockIndexer.id, mockIndexer.name);
      expect(results).toHaveLength(0);
    });

    it('scores results when title provided', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));

      const adapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'The Way of Kings', author: 'Brandon Sanderson', indexer: 'ABB' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(adapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(mockIndexer.id, new AbortController());

      const results = await searchService.searchAllStreaming(
        'way of kings',
        { title: 'The Way of Kings', author: 'Brandon Sanderson' },
        controllers,
        { onComplete: vi.fn(), onError: vi.fn() },
      );

      expect(results[0]!.matchScore).toBeDefined();
      expect(results[0]!.matchScore).toBeGreaterThan(0);
    });
  });

  describe('#372 — pre-search refresh (searchAll)', () => {
    const mamIndexer = createMockDbIndexer({
      id: 10, name: 'MAM', type: 'myanonamouse',
      settings: { mamId: 'test', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
    });

    it('calls refreshStatus() before search() for MAM adapter', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const callOrder: string[] = [];
      const mockAdapter = {
        type: 'myanonamouse',
        name: 'MAM',
        refreshStatus: vi.fn().mockImplementation(() => { callOrder.push('refresh'); return Promise.resolve({ isVip: true, classname: 'VIP' }); }),
        search: vi.fn().mockImplementation(() => { callOrder.push('search'); return Promise.resolve([]); }),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      await searchService.searchAll('test');
      expect(callOrder).toEqual(['refresh', 'search']);
    });

    it('skips search when refreshStatus() returns Mouse class', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const results = await searchService.searchAll('test');
      expect(mockAdapter.search).not.toHaveBeenCalled();
      expect(results).toEqual([]);
    });

    it('proceeds with search when refreshStatus() throws (network error)', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockRejectedValue(new Error('Network error')),
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await searchService.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('proceeds with search when refreshStatus() returns null', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue(null),
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await searchService.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('calls search() directly for non-MAM adapter (no refreshStatus method)', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const results = await searchService.searchAll('test');
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('persists updated isVip/classname when class changes (VIP → Power User)', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Power User' }),
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);
      const results = await searchService.searchAll('test');
      expect(updateSpy).toHaveBeenCalledWith(10, {
        settings: expect.objectContaining({ isVip: false, classname: 'Power User' }),
      });
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('does not write to DB when refreshStatus() returns same class as stored', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mockAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: true, classname: 'VIP' }),
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'MAM', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);
      const updateSpy = vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);
      const results = await searchService.searchAll('test');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(mockAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it('other indexers still return results when Mouse indexer is skipped', async () => {
      const abbIndexer = createMockDbIndexer({ id: 2, name: 'ABB', type: 'abb' });
      db.select.mockReturnValue(mockDbChain([mamIndexer, abbIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      const abbAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mouseAdapter as never)
        .mockResolvedValueOnce(abbAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));
      const results = await searchService.searchAll('test');
      expect(mouseAdapter.search).not.toHaveBeenCalled();
      expect(abbAdapter.search).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });
  });

  describe('#372 — searchAllStreaming Mouse error', () => {
    const mamIndexer = createMockDbIndexer({
      id: 10, name: 'MAM', type: 'myanonamouse',
      settings: { mamId: 'test', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
    });

    it('fires onError callback with "Searches disabled — Mouse class" message', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mouseAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));

      const onError = vi.fn();
      const onComplete = vi.fn();
      const controllers = new Map([[10, new AbortController()]]);
      await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(onError).toHaveBeenCalledWith(10, 'MAM', 'Searches disabled — Mouse class', expect.any(Number));
      expect(mouseAdapter.search).not.toHaveBeenCalled();
    });

    it('other indexers in same streaming search still complete normally', async () => {
      const abbIndexer = createMockDbIndexer({ id: 2, name: 'ABB', type: 'abb' });
      db.select.mockReturnValue(mockDbChain([mamIndexer, abbIndexer]));
      const mouseAdapter = {
        type: 'myanonamouse', name: 'MAM',
        refreshStatus: vi.fn().mockResolvedValue({ isVip: false, classname: 'Mouse' }),
        search: vi.fn(),
        test: vi.fn(),
      };
      const abbAdapter = {
        type: 'abb', name: 'ABB',
        search: vi.fn().mockResolvedValue(searchResponse([{ title: 'Book', indexer: 'ABB', protocol: 'torrent' as const }])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mouseAdapter as never)
        .mockResolvedValueOnce(abbAdapter as never);
      db.update.mockReturnValue(mockDbChain([mamIndexer]));

      const onError = vi.fn();
      const onComplete = vi.fn();
      const controllers = new Map([[10, new AbortController()], [2, new AbortController()]]);
      const results = await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(1);
    });
  });

  describe('searchAll() language injection', () => {
    let settingsService: ReturnType<typeof createMockSettingsService>;
    let langService: IndexerService;
    let langSearchService: IndexerSearchService;

    beforeEach(() => {
      settingsService = createMockSettingsService({ metadata: { audibleRegion: 'us', languages: ['english', 'french'] } });
      langService = new IndexerService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(settingsService),
      );
      langSearchService = new IndexerSearchService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        langService,
        inject<SettingsService>(settingsService),
      );
    });

    it('reads metadata.languages from settingsService when options.languages absent', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await langSearchService.searchAll('sanderson');

      expect(settingsService.get).toHaveBeenCalledWith('metadata');
      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['english', 'french'] }),
      );
    });

    it('preserves explicit caller-supplied options.languages', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      await langSearchService.searchAll('sanderson', { languages: ['german'] });

      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['german'] }),
      );
    });
  });

  describe('searchAllStreaming() language injection', () => {
    let settingsService: ReturnType<typeof createMockSettingsService>;
    let langService: IndexerService;
    let langSearchService: IndexerSearchService;

    beforeEach(() => {
      settingsService = createMockSettingsService({ metadata: { audibleRegion: 'us', languages: ['english', 'french'] } });
      langService = new IndexerService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        inject<SettingsService>(settingsService),
      );
      langSearchService = new IndexerSearchService(
        inject<Db>(db),
        inject<FastifyBaseLogger>(createMockLogger()),
        langService,
        inject<SettingsService>(settingsService),
      );
    });

    it('injects metadata.languages into adapter options', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controllers = new Map([[mockIndexer.id, new AbortController()]]);
      const onComplete = vi.fn();
      const onError = vi.fn();

      await langSearchService.searchAllStreaming('sanderson', undefined, controllers, { onComplete, onError });

      expect(settingsService.get).toHaveBeenCalledWith('metadata');
      expect(mockAdapter.search).toHaveBeenCalledWith(
        'sanderson',
        expect.objectContaining({ languages: ['english', 'french'] }),
      );
    });

    it('preserves per-indexer abort signal alongside injected languages', async () => {
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([])),
        test: vi.fn(),
      };
      vi.spyOn(langService, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controller = new AbortController();
      const controllers = new Map([[mockIndexer.id, controller]]);
      const onComplete = vi.fn();
      const onError = vi.fn();

      await langSearchService.searchAllStreaming('sanderson', undefined, controllers, { onComplete, onError });

      const searchCall = mockAdapter.search.mock.calls[0]![1];
      expect(searchCall.languages).toEqual(['english', 'french']);
      expect(searchCall.signal).toBe(controller.signal);
    });
  });

  describe('indexerPriority mapping (#394)', () => {
    it('searchAll attaches indexerPriority from the indexer record to each mapped result', async () => {
      const highPriorityIndexer = createMockDbIndexer({ id: 5, priority: 10 });
      db.select.mockReturnValue(mockDbChain([highPriorityIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Book One', indexer: 'AudioBookBay', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results[0]!.indexerPriority).toBe(10);
    });

    it('searchAllStreaming attaches indexerPriority from the indexer record to each mapped result', async () => {
      const streamIndexer = createMockDbIndexer({ id: 3, priority: 25 });
      db.select.mockReturnValue(mockDbChain([streamIndexer]));
      const mockAdapter = {
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Book One', indexer: 'ABB', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const controllers = new Map<number, AbortController>();
      controllers.set(3, new AbortController());
      const onComplete = vi.fn();
      const onError = vi.fn();

      const results = await searchService.searchAllStreaming('test', undefined, controllers, { onComplete, onError });
      expect(results[0]!.indexerPriority).toBe(25);
    });

    it('pollRss attaches indexerPriority from the indexer record to each mapped result', async () => {
      const rssIndexer = createMockDbIndexer({ id: 7, priority: 75, name: 'Torznab', type: 'torznab', settings: { apiUrl: 'https://tracker.test', apiKey: 'key' } });
      const mockAdapter = {
        type: 'torznab',
        name: 'Torznab',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Author A - Book One', indexer: 'Torznab', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.pollRss(rssIndexer);
      expect(results[0]!.indexerPriority).toBe(75);
    });

    it('indexer with default priority (50) produces results with indexerPriority: 50', async () => {
      // mockIndexer uses createMockDbIndexer() which defaults to priority: 50
      db.select.mockReturnValue(mockDbChain([mockIndexer]));
      const mockAdapter = {
        type: 'abb',
        name: 'AudioBookBay',
        search: vi.fn().mockResolvedValue(searchResponse([
          { title: 'Book One', indexer: 'AudioBookBay', protocol: 'torrent' },
        ])),
        test: vi.fn(),
      };
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mockAdapter as never);

      const results = await searchService.searchAll('test');
      expect(results[0]!.indexerPriority).toBe(50);
    });
  });
});
