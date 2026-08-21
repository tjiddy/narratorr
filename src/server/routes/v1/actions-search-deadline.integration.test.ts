import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { SearchResult } from '@core/index.js';
import type { BookService } from '../../services/book.service.js';
import type { BlacklistService } from '../../services/blacklist.service.js';
import type { IndexerService } from '../../services/indexer.service.js';
import type { IndexerSearchService } from '../../services/indexer-search.service.js';
import type { DownloadOrchestrator } from '../../services/download-orchestrator.js';
import type { DownloadService } from '../../services/download.service.js';
import type { SettingsService } from '../../services/settings.service.js';
import type { EventHistoryService } from '../../services/event-history.service.js';
import type { Services } from '../../services/di.js';
import {
  createMockDb, mockDbChain, createMockLogger, createMockServices, createAuthTestApp,
  createMockSettingsService, inject, searchStatus, captureDeadlineTimers, BASIC_AUTH_HEADER,
} from '../../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../../__tests__/factories.js';
import { RetryBudget } from '../../services/retry-budget.js';
import { retrySearch, type RetrySearchDeps } from '../../services/retry-search.js';
import { searchAndGrabForBook } from '../../services/search-pipeline.js';
import { _resetSearchRegistryForTesting } from '../../services/search-deadline.js';
import { initializeKey, _resetKey } from '../../utils/secret-codec.js';
import { v1ActionsRoutes } from './actions.js';

/**
 * #2527 at the route-integration layer. The unit suites double one surface at a time, so none of
 * them can see that `POST /api/v1/books/:publicId/search`, `searchAndGrabForBook` and `retrySearch`
 * key the SAME `inFlightSearches` map — which is the whole invariant. Nothing here doubles
 * `withSearchDeadline`; the real production timer is parked by `captureDeadlineTimers()` and fired
 * on demand.
 */

vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

// The 200 arm mints signed release ids, so the HMAC key has to exist before any request.
_resetKey();
initializeKey(Buffer.alloc(32, 0x2b));

const BOOK_X = 5;
const BOOK_Y = 6;
const PUBLIC_X = 'bk_xxxxxxxxxxxxxxxxxxxx';
const PUBLIC_Y = 'bk_yyyyyyyyyyyyyyyyyyyy';

const hydrated = (id: number) => ({
  ...createMockDbBook({ id, title: 'The Way of Kings', path: null }),
  authors: [createMockDbAuthor()],
  narrators: [],
});

const searchHit = (): SearchResult => ({
  title: 'The Way of Kings',
  protocol: 'torrent',
  indexer: 'abb',
  indexerId: 1,
  seeders: 10,
  size: 500 * 1024 * 1024,
  downloadUrl: 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
});

const qualitySettings = {
  grabFloor: 0, minSeeders: 0, protocolPreference: 'none' as const,
  rejectWords: '', requiredWords: '', maxDownloadSize: 0, minDownloadSize: 0,
};

describe('#2527 — the v1 discovery route shares one per-book registry with the automatic surfaces', () => {
  let app: Awaited<ReturnType<typeof createAuthTestApp>>['app'];
  let services: Services;
  let db: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let armed: Array<() => void>;
  let searchAllWithStatus: Mock;
  let indexerSearchService: IndexerSearchService;
  let retryBudget: RetryBudget;
  let consumeAttempt: Mock;

  const parkedSearch = () => vi.fn(() => new Promise<never>(() => { /* never settles */ }));

  /** A park that can be let go, so a case can observe the registry freeing after an expiry. */
  function releasableSearch() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return { fn: vi.fn(async () => { await gate; return searchStatus([searchHit()]); }), release: () => release() };
  }

  const bookService = inject<BookService>({
    getById: vi.fn(async (id: number) => hydrated(id)),
  });

  const indexerService = inject<IndexerService>({
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'ABB', type: 'abb', enabled: true, settings: {} }),
  });

  const blacklistService = inject<BlacklistService>({
    getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>(),
    }),
  });

  // Never reached in these cases: every one of them parks before a grab decision.
  const downloadOrchestrator = inject<DownloadOrchestrator>({
    grab: vi.fn().mockResolvedValue(null),
    grabForRetry: vi.fn().mockResolvedValue('already_active'),
    hasGrabBlocker: vi.fn().mockResolvedValue(false),
  });

  const settingsService = createMockSettingsService({ quality: qualitySettings });

  const url = (publicId: string) => `/api/v1/books/${publicId}/search`;
  // Basic mode enforces CSRF on non-safe methods, so the XHR header is required, not decorative.
  const v1Search = (publicId: string) =>
    app.inject({
      method: 'POST',
      url: url(publicId),
      headers: { authorization: BASIC_AUTH_HEADER, 'x-requested-with': 'XMLHttpRequest' },
    });

  const pipelineDeps = () => ({
    indexerSearchService,
    downloadOrchestrator,
    qualitySettings,
    log,
    blacklistService,
    indexerService,
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
  });

  const retryDeps = (): RetrySearchDeps => ({
    indexerSearchService,
    indexerService,
    downloadOrchestrator,
    blacklistService,
    bookService,
    settingsService: inject<SettingsService>(settingsService),
    retryBudget,
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
    log,
  });

  /** Both public ids resolve; the wider projection the grab route uses reads no download rows. */
  function primeDb() {
    db.select.mockImplementation((proj?: Record<string, unknown>) => {
      const keys = proj ? Object.keys(proj) : [];
      if (keys.length === 1 && keys[0] === 'id') return mockDbChain([{ id: currentRowid }]);
      return mockDbChain([]);
    });
  }

  let currentRowid = BOOK_X;

  beforeEach(async () => {
    _resetSearchRegistryForTesting();
    armed = captureDeadlineTimers();
    log = inject<FastifyBaseLogger>(createMockLogger());
    db = createMockDb();
    currentRowid = BOOK_X;
    primeDb();
    searchAllWithStatus = vi.fn().mockResolvedValue(searchStatus([searchHit()]));
    // Read lazily so a case can swap the double after the deps object is built.
    indexerSearchService = inject<IndexerSearchService>({
      searchAllWithStatus: (...args: unknown[]) => searchAllWithStatus(...args),
    });
    retryBudget = new RetryBudget();
    consumeAttempt = vi.spyOn(retryBudget, 'consumeAttempt') as unknown as Mock;

    services = createMockServices();
    const built = await createAuthTestApp(services, {
      db: inject<Db>(db),
      routes: (instance, _svcs, database) =>
        v1ActionsRoutes(instance, {
          bookService,
          indexerSearchService,
          downloadOrchestrator,
          downloadService: inject<DownloadService>({ getById: vi.fn().mockResolvedValue(null) }),
          blacklistService,
          settingsService: inject<SettingsService>(settingsService),
          indexerService,
        }, database),
    });
    app = built.app;
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  describe('AC10 — cross-surface single flight, v1 first', () => {
    it('holds off both automatic surfaces while a v1 discovery search owns the book', async () => {
      searchAllWithStatus = parkedSearch();
      const pending = v1Search(PUBLIC_X);
      await vi.waitFor(() => expect(searchAllWithStatus).toHaveBeenCalledTimes(1));

      await expect(searchAndGrabForBook(hydrated(BOOK_X), pipelineDeps())).resolves.toEqual({
        result: 'skipped', reason: 'search_already_in_flight',
      });
      await expect(retrySearch(BOOK_X, retryDeps())).resolves.toEqual({ outcome: 'already_active' });

      // Neither ran a ladder: the call count is unchanged across both.
      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);

      armed[0]!();
      expect((await pending).statusCode).toBe(504);
    });

    it('costs the suppressed retry no budget attempt, and leaves the next one at attempt 1', async () => {
      const parked = releasableSearch();
      searchAllWithStatus = parked.fn;
      const pending = v1Search(PUBLIC_X);
      await vi.waitFor(() => expect(parked.fn).toHaveBeenCalledTimes(1));

      // A delta, not an absolute: `consumeAttempt` counts across this whole case.
      const before = consumeAttempt.mock.calls.length;
      await expect(retrySearch(BOOK_X, retryDeps())).resolves.toEqual({ outcome: 'already_active' });
      expect(consumeAttempt.mock.calls.length - before).toBe(0);

      armed[0]!();
      expect((await pending).statusCode).toBe(504);

      // The slot holds the WORK promise, so it frees only once the abandoned run settles.
      parked.release();
      (downloadOrchestrator.grabForRetry as Mock).mockResolvedValue({ id: 1, title: 'The Way of Kings' });
      searchAllWithStatus = vi.fn().mockResolvedValue(searchStatus([searchHit()]));
      await vi.waitFor(async () => {
        await retrySearch(BOOK_X, retryDeps());
        expect(consumeAttempt).toHaveBeenCalledTimes(1);
      });

      // The suppressed call spent nothing, so the first retry that actually runs is attempt 1.
      expect(consumeAttempt.mock.results[0]!.value).toBe(1);
    });
  });

  describe('AC10 — cross-surface single flight, automatic first', () => {
    it('answers 409 SEARCH_IN_PROGRESS while the scheduled pipeline owns the book', async () => {
      searchAllWithStatus = parkedSearch();
      const pipeline = searchAndGrabForBook(hydrated(BOOK_X), pipelineDeps());
      await vi.waitFor(() => expect(searchAllWithStatus).toHaveBeenCalledTimes(1));

      const res = await v1Search(PUBLIC_X);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: { code: 'SEARCH_IN_PROGRESS', message: expect.any(String) } });
      // The route consulted the SAME registry rather than a private map: no second ladder, no
      // second timer.
      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);

      armed[0]!();
      await expect(pipeline).rejects.toThrow(/deadline/);
    });

    it('answers 409 SEARCH_IN_PROGRESS while a failed-download retry owns the book', async () => {
      searchAllWithStatus = parkedSearch();
      const retry = retrySearch(BOOK_X, retryDeps());
      await vi.waitFor(() => expect(searchAllWithStatus).toHaveBeenCalledTimes(1));

      const res = await v1Search(PUBLIC_X);

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SEARCH_IN_PROGRESS');
      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);

      armed[0]!();
      await expect(retry).resolves.toMatchObject({ outcome: 'retry_error' });
    });
  });

  describe('AC10 — the registry is keyed per book', () => {
    it('serves a v1 search for book Y while book X is parked', async () => {
      const parked = parkedSearch();
      searchAllWithStatus = parked;
      const pipeline = searchAndGrabForBook(hydrated(BOOK_X), pipelineDeps());
      await vi.waitFor(() => expect(parked).toHaveBeenCalledTimes(1));

      // Book Y answers from its own ladder, so it needs a double that settles.
      searchAllWithStatus = vi.fn().mockResolvedValue(searchStatus([searchHit()]));
      currentRowid = BOOK_Y;

      const res = await v1Search(PUBLIC_Y);

      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(1);
      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      // Book X's parked timer plus book Y's own — one per admitted run, keyed per book.
      expect(armed).toHaveLength(2);

      armed[0]!();
      await expect(pipeline).rejects.toThrow(/deadline/);
    });
  });
});
