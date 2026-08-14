import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';
import type { BlacklistService } from './blacklist.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { IndexerService as IndexerServiceType } from './indexer.service.js';
import type * as NetworkServiceModule from '@core/utils/network-service.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbIndexer } from '../__tests__/factories.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { eventHistoryQuerySchema } from '@shared/schemas/event-history.js';

// Mock only the network boundary; the MAM adapter, the pre-search refresh, the attachment, the
// filter chain and the grab decision all run for real.
vi.mock('@core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

import { IndexerService } from './indexer.service.js';
import { IndexerSearchService } from './indexer-search.service.js';
import { searchAndGrabForBook } from './search-pipeline.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');
const MAM_BASE = 'https://mam.test';

const wantedBook = { id: 1, title: 'The Way of Kings', duration: 3600, authors: [{ name: 'Brandon Sanderson' }] };

/** The account state the issue was filed from, with the count pushed to the limit. */
const userStatus = (count: number) => ({
  username: 'testuser', classname: 'VIP', wedges: 7, uid: 12345,
  unsat: { count, limit: 150, size: 73954762929, red: false },
  seedUnsat: { count, red: false, size: 73954762929 },
  sSat: { count: 578, red: false, size: 459359749269 },
  connectable: 'yes',
});

const mamSearchRow = {
  id: 999, title: 'The Way of Kings', author_info: '"{\\"1\\": \\"Brandon Sanderson\\"}"',
  size: '881.8 MiB', seeders: 42, leechers: 3, filetype: 'm4b', lang_code: 'ENG',
};

describe('#2322 end-to-end — snatch_summary at the limit withholds a scheduled auto-grab', () => {
  const server = useMswServer();
  let db: ReturnType<typeof createMockDb>;
  let indexerService: IndexerService;
  let indexerSearchService: IndexerSearchService;
  let downloadOrchestrator: DownloadOrchestrator;
  let eventHistory: EventHistoryService;
  let log: ReturnType<typeof createMockLogger>;

  const mamRow = createMockDbIndexer({
    id: 10, name: 'MyAnonamouse', type: 'myanonamouse', enabled: true,
    settings: { mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true, classname: 'VIP' },
  });

  function stubMam(count: number) {
    server.use(
      http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json(userStatus(count))),
      http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => HttpResponse.json({ data: [mamSearchRow] })),
    );
  }

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    db.select.mockReturnValue(mockDbChain([mamRow]));
    log = createMockLogger();
    indexerService = new IndexerService(inject<Db>(db), inject<FastifyBaseLogger>(log));
    indexerSearchService = new IndexerSearchService(inject<Db>(db), inject<FastifyBaseLogger>(log), indexerService);
    downloadOrchestrator = inject<DownloadOrchestrator>({ grab: vi.fn().mockResolvedValue({ id: 1, status: 'downloading' }) });
    eventHistory = inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) });
  });

  afterEach(() => {
    _resetKey();
  });

  const deps = () => ({
    indexerSearchService,
    downloadOrchestrator,
    qualitySettings: { grabFloor: 0, minSeeders: 0, protocolPreference: 'none', maxDownloadSize: 0 },
    log: inject<FastifyBaseLogger>(log),
    blacklistService: inject<BlacklistService>({
      getBlacklistedIdentifiers: vi.fn().mockResolvedValue({ blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>() }),
    }),
    indexerService: indexerService as unknown as IndexerServiceType,
    eventHistory,
  });

  it('withholds the grab and records a Needs-Review-reachable event when MAM reports 150 of 150', async () => {
    stubMam(150);

    const result = await searchAndGrabForBook(wantedBook, deps());

    expect(result).toEqual({ result: 'no_results' });
    expect(downloadOrchestrator.grab).not.toHaveBeenCalled();

    const created = vi.mocked(eventHistory.create).mock.calls.map((c) => c[0]);
    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(expect.objectContaining({
      bookId: 1,
      eventType: 'grab_blocked_unsatisfied',
      source: 'auto',
      reason: { indexer: 'MyAnonamouse', count: 150, limit: 150, release_title: 'The Way of Kings' },
    }));

    // The Needs Review chip's comma-joined value must round-trip through the query validator.
    const parsed = eventHistoryQuerySchema.parse({
      eventType: 'held_for_review,recording_review_skipped,search_relaxed_held,sidecar_diverged,grab_blocked_unsatisfied',
    });
    expect(parsed.eventType).toContain('grab_blocked_unsatisfied');
  });

  it('grabs normally when the same live path reports 149 of 150', async () => {
    stubMam(149);

    const result = await searchAndGrabForBook(wantedBook, deps());

    expect(result).toEqual({ result: 'grabbed', title: 'The Way of Kings' });
    expect(downloadOrchestrator.grab).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).not.toHaveBeenCalled();
  });

  it('grabs normally when MAM stops reporting the pair at all', async () => {
    server.use(
      http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'testuser', classname: 'VIP' })),
      http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => HttpResponse.json({ data: [mamSearchRow] })),
    );

    expect(await searchAndGrabForBook(wantedBook, deps())).toEqual({ result: 'grabbed', title: 'The Way of Kings' });
  });

  // The worst outcome this feature could cause is silently blocking every grab, so each shape a
  // MAM response change could take must still grab.
  const failOpenShapes: Array<{ name: string; unsat: unknown }> = [
    { name: 'a string instead of an object', unsat: '139/150' },
    { name: 'an object with no limit', unsat: { count: 5 } },
    { name: 'a zero limit', unsat: { count: 0, limit: 0 } },
    { name: 'null members', unsat: { count: null, limit: null } },
    { name: 'null', unsat: null },
  ];

  for (const { name, unsat } of failOpenShapes) {
    it(`grabs normally when MAM reports ${name}`, async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'testuser', classname: 'VIP', unsat })),
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => HttpResponse.json({ data: [mamSearchRow] })),
      );

      expect(await searchAndGrabForBook(wantedBook, deps())).toEqual({ result: 'grabbed', title: 'The Way of Kings' });
      expect(eventHistory.create).not.toHaveBeenCalled();
    });
  }

  it('grabs normally when the user-status request fails outright', async () => {
    server.use(
      http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.error()),
      http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => HttpResponse.json({ data: [mamSearchRow] })),
    );

    expect(await searchAndGrabForBook(wantedBook, deps())).toEqual({ result: 'grabbed', title: 'The Way of Kings' });
  });
});
