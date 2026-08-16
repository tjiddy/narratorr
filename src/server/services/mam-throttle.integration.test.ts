import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { IndexerAdapter, SearchResult } from '@core/index.js';
import type * as NetworkServiceModule from '@core/utils/network-service.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { MAM_MIN_REQUEST_INTERVAL_MS } from '@core/utils/constants.js';
import { MyAnonamouseIndexer } from '@core/indexers/myanonamouse.js';
import { _resetMamThrottleForTesting } from '@core/indexers/mam-throttle.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';

// Mock only the network boundary; the MAM adapter, its gate and the pre-search refresh run for real.
vi.mock('@core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { preSearchRefresh } from './indexer-pre-search-refresh.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const MAM_BASE = 'https://mam.test';

const emptyResponse = {
  results: [] as SearchResult[],
  parseStats: { itemsObserved: 0, kept: 0, dropped: { emptyTitle: 0, noUrl: 0, other: 0 } },
  debugTrace: [],
};

describe('#2309 end-to-end — the MAM gate spaces one search\'s own refresh/search pair', () => {
  const server = useMswServer();
  let db: ReturnType<typeof createMockDb>;
  let indexerService: IndexerService;
  let searchService: IndexerSearchService;
  let dispatched: Array<{ label: string; at: number }>;

  const mamRow = createMockDbIndexer({
    id: 10, name: 'MyAnonamouse', type: 'myanonamouse', enabled: true,
    settings: { mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
  });
  const torznabRow = createMockDbIndexer({
    id: 11, name: 'Torznab', type: 'torznab', enabled: true,
    settings: { apiUrl: 'https://torznab.test', apiKey: 'k' },
  });

  function stubMam() {
    server.use(
      http.get(`${MAM_BASE}/jsonLoad.php`, () => {
        dispatched.push({ label: 'mam:status', at: Date.now() });
        return HttpResponse.json({ username: 'testuser', classname: 'VIP' });
      }),
      http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
        dispatched.push({ label: 'mam:search', at: Date.now() });
        return HttpResponse.json({ data: [] });
      }),
    );
  }

  /** Stands in for any non-MAM row: no gate, so it must dispatch without waiting. */
  const torznabAdapter = {
    type: 'torznab',
    name: 'Torznab',
    search: vi.fn(async () => {
      dispatched.push({ label: 'torznab:search', at: Date.now() });
      return emptyResponse;
    }),
    test: vi.fn(),
  };

  beforeEach(() => {
    initializeKey(TEST_KEY);
    _resetMamThrottleForTesting();
    dispatched = [];
    torznabAdapter.search.mockClear();
    db = createMockDb();
    db.select.mockReturnValue(mockDbChain([mamRow, torznabRow]));
    const log = createMockLogger();
    indexerService = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
    searchService = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), indexerService);

    const mamAdapter = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' });
    vi.spyOn(indexerService, 'getAdapter').mockImplementation(async (row: { type: string }) =>
      (row.type === 'myanonamouse' ? mamAdapter : torznabAdapter) as unknown as IndexerAdapter);
  });

  afterEach(() => {
    _resetMamThrottleForTesting();
    _resetKey();
    vi.restoreAllMocks();
  });

  it('spaces the status refresh and the search it precedes, and leaves the other row unwaited', async () => {
    stubMam();
    // Both observations below are stamped inside MSW handlers, so the asserted quantity is the
    // gate's interval plus the difference of two fetch-to-handler latencies. The run's first
    // intercepted fetch pays a one-time interception cost the second does not, biasing the gap
    // ~5-11ms SHORT and eating the tolerance meant for clock granularity (#2362). Warm the path so
    // the measurement lands on the interval itself; this fetch bypasses the adapter, so it takes no
    // gate slot and leaves no stamp behind.
    await fetch(`${MAM_BASE}/jsonLoad.php`);
    dispatched.length = 0;

    const startedAt = Date.now();

    const outcome = await searchService.searchAllWithStatus('the way of kings');

    expect(outcome.succeeded).toBe(2);
    expect(dispatched.map((d) => d.label)).toEqual(['torznab:search', 'mam:status', 'mam:search']);

    const status = dispatched.find((d) => d.label === 'mam:status')!;
    const search = dispatched.find((d) => d.label === 'mam:search')!;
    const torznab = dispatched.find((d) => d.label === 'torznab:search')!;
    // Date.now() granularity is ~15.6ms on Windows, so a strict >= interval flakes there.
    expect(search.at - status.at).toBeGreaterThanOrEqual(MAM_MIN_REQUEST_INTERVAL_MS - 20);
    expect(torznab.at - startedAt).toBeLessThan(MAM_MIN_REQUEST_INTERVAL_MS);
  });

  it('terminates an aborted search through abortReason instead of resolving it as answered', async () => {
    stubMam();
    const controller = new AbortController();
    controller.abort();

    await expect(searchService.searchAllWithStatus('the way of kings', { signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
    expect(dispatched.some((d) => d.label.startsWith('mam:'))).toBe(false);
  });

  it('rethrows from preSearchRefresh under an aborted signal rather than proceeding with stored status', async () => {
    stubMam();
    const controller = new AbortController();
    controller.abort();
    const adapter = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' });

    await expect(preSearchRefresh(adapter, mamRow, {
      log: inject<FastifyBaseLogger>(createMockLogger()),
      update: vi.fn(),
      signal: controller.signal,
    })).rejects.toBe(controller.signal.reason);
    expect(dispatched).toEqual([]);
  });
});
