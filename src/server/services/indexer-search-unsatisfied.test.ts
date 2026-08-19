import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { SearchResult } from '@core/index.js';
import type { UnsatisfiedStatus } from '@core/utils/mam-unsatisfied.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

const mamIndexer = createMockDbIndexer({
  id: 10, name: 'MAM', type: 'myanonamouse',
  settings: { mamId: 'test', searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
});
const abbIndexer = createMockDbIndexer({ id: 2, name: 'ABB', type: 'abb' });

function searchResponse(titles: string[], indexerName: string) {
  const results = titles.map((title) => ({ title, indexer: indexerName, protocol: 'torrent' as const }));
  return {
    results: results as SearchResult[],
    parseStats: { itemsObserved: results.length, kept: results.length, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
    debugTrace: [],
  };
}

type RefreshResult = { isVip?: boolean; classname?: string; unsatisfied?: UnsatisfiedStatus } | null;

function mamAdapter(options: {
  refresh: RefreshResult | Error;
  titles?: string[];
  onSearch?: () => Promise<void>;
}) {
  const { refresh, titles = ['MAM Book'], onSearch } = options;
  return {
    type: 'myanonamouse', name: 'MAM', test: vi.fn(),
    refreshStatus: vi.fn().mockImplementation(() =>
      refresh instanceof Error ? Promise.reject(refresh) : Promise.resolve(refresh),
    ),
    search: vi.fn().mockImplementation(async () => {
      if (onSearch) await onSearch();
      return searchResponse(titles, 'MAM');
    }),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('#2322 — the unsatisfied observation travels with the results it describes', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: IndexerService;
  let searchService: IndexerSearchService;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    service = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
    searchService = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()), service);
    db.select.mockReturnValue(mockDbChain([mamIndexer]));
    vi.spyOn(service, 'update').mockResolvedValue(mamIndexer as never);
  });

  afterEach(() => {
    _resetKey();
    vi.restoreAllMocks();
  });

  describe('searchAllWithStatus', () => {
    it('attaches the observed pair to that indexer’s results', async () => {
      vi.spyOn(service, 'getAdapter').mockResolvedValue(
        mamAdapter({ refresh: { isVip: true, classname: 'VIP', unsatisfied: { count: 150, limit: 150 } } }) as never,
      );

      const { results } = await searchService.searchAllWithStatus('test');

      expect(results).toHaveLength(1);
      expect(results[0]?.unsatisfied).toEqual({ count: 150, limit: 150 });
    });

    it('attaches the pair only to the reporting indexer’s results', async () => {
      db.select.mockReturnValue(mockDbChain([mamIndexer, abbIndexer]));
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mamAdapter({ refresh: { unsatisfied: { count: 150, limit: 150 } } }) as never)
        .mockResolvedValueOnce({
          type: 'abb', name: 'ABB', test: vi.fn(),
          search: vi.fn().mockResolvedValue(searchResponse(['ABB Book'], 'ABB')),
        } as never);

      const { results } = await searchService.searchAllWithStatus('test');

      const mam = results.find((r) => r.indexer === 'MAM');
      const abb = results.find((r) => r.indexer === 'ABB');
      expect(mam?.unsatisfied).toEqual({ count: 150, limit: 150 });
      expect(abb).toBeDefined();
      expect(abb).not.toHaveProperty('unsatisfied');
    });

    const nothingObserved: Array<{ name: string; refresh: RefreshResult | Error }> = [
      { name: 'the refresh reported class fields only', refresh: { isVip: true, classname: 'VIP' } },
      { name: 'the refresh returned null', refresh: null },
      { name: 'the refresh threw', refresh: new Error('Network error') },
    ];

    for (const { name, refresh } of nothingObserved) {
      it(`attaches nothing when ${name}`, async () => {
        vi.spyOn(service, 'getAdapter').mockResolvedValue(mamAdapter({ refresh }) as never);

        const { results } = await searchService.searchAllWithStatus('test');

        expect(results).toHaveLength(1);
        expect(results[0]).not.toHaveProperty('unsatisfied');
      });
    }

    it('attaches nothing for an adapter with no refreshStatus hook', async () => {
      db.select.mockReturnValue(mockDbChain([abbIndexer]));
      vi.spyOn(service, 'getAdapter').mockResolvedValue({
        type: 'abb', name: 'ABB', test: vi.fn(),
        search: vi.fn().mockResolvedValue(searchResponse(['ABB Book'], 'ABB')),
      } as never);

      const { results } = await searchService.searchAllWithStatus('test');

      expect(results[0]).not.toHaveProperty('unsatisfied');
    });
  });

  describe('searchAllStreaming', () => {
    function stream() {
      return searchService.searchAllStreaming(
        'test', undefined, new Map([[10, new AbortController()]]),
        { onComplete: vi.fn(), onError: vi.fn() },
      );
    }

    it('attaches the observed pair to that indexer’s results', async () => {
      vi.spyOn(service, 'getAdapter').mockResolvedValue(
        mamAdapter({ refresh: { isVip: true, classname: 'VIP', unsatisfied: { count: 151, limit: 150 } } }) as never,
      );

      const results = await stream();

      expect(results[0]?.unsatisfied).toEqual({ count: 151, limit: 150 });
    });

    it('attaches nothing when the refresh observed no pair', async () => {
      vi.spyOn(service, 'getAdapter').mockResolvedValue(mamAdapter({ refresh: null }) as never);

      const results = await stream();

      expect(results[0]).not.toHaveProperty('unsatisfied');
    });

    it('contributes no results at all when the Mouse arm skips the indexer', async () => {
      vi.spyOn(service, 'getAdapter').mockResolvedValue(
        mamAdapter({ refresh: { isVip: false, classname: 'Mouse', unsatisfied: { count: 150, limit: 150 } } }) as never,
      );

      expect(await stream()).toEqual([]);
    });
  });

  describe('request isolation — no shared cell to contend for', () => {
    /** Hold A's adapter.search open until B has completed, then let A finish. */
    async function interleave(aRefresh: RefreshResult | Error, bRefresh: RefreshResult | Error) {
      const gate = deferred();
      const adapterA = mamAdapter({ refresh: aRefresh, titles: ['A Book'], onSearch: () => gate.promise });
      const adapterB = mamAdapter({ refresh: bRefresh, titles: ['B Book'] });
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(adapterA as never)
        .mockResolvedValueOnce(adapterB as never);

      const searchA = searchService.searchAllWithStatus('a');
      // Let A reach its held search() before B starts, so the two overlap.
      await Promise.resolve();
      const b = await searchService.searchAllWithStatus('b');
      gate.resolve();
      const a = await searchA;
      return { a: a.results, b: b.results };
    }

    it('keeps the at-limit observation on the search that made it', async () => {
      const { a, b } = await interleave(
        { unsatisfied: { count: 150, limit: 150 } },
        new Error('Network error'),
      );

      expect(a[0]?.unsatisfied).toEqual({ count: 150, limit: 150 });
      expect(b[0]).not.toHaveProperty('unsatisfied');
    });

    it('holds under the mirror interleaving', async () => {
      const { a, b } = await interleave(
        new Error('Network error'),
        { unsatisfied: { count: 150, limit: 150 } },
      );

      expect(a[0]).not.toHaveProperty('unsatisfied');
      expect(b[0]?.unsatisfied).toEqual({ count: 150, limit: 150 });
    });

    it('does not leak an earlier observation into a later search on the same service instance', async () => {
      vi.spyOn(service, 'getAdapter')
        .mockResolvedValueOnce(mamAdapter({ refresh: { unsatisfied: { count: 150, limit: 150 } } }) as never)
        .mockResolvedValueOnce(mamAdapter({ refresh: new Error('Network error') }) as never);

      const first = await searchService.searchAllWithStatus('first');
      const second = await searchService.searchAllWithStatus('second');

      expect(first.results[0]?.unsatisfied).toEqual({ count: 150, limit: 150 });
      expect(second.results[0]).not.toHaveProperty('unsatisfied');
    });
  });
});
