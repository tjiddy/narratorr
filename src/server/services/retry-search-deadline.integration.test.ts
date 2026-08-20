import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { SearchResult } from '@core/index.js';
import {
  createMockDb, mockDbChain, createMockLogger, inject, createMockSettingsService,
  mockSearchAllWithStatus, captureDeadlineTimers,
} from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadClientService } from './download-client.service.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { RetryBudget } from './retry-budget.js';
import { retrySearch, type RetrySearchDeps } from './retry-search.js';
import { searchAndGrabForBook } from './search-pipeline.js';
import { _resetSearchRegistryForTesting } from './search-deadline.js';

/**
 * #2477 at the service-integration layer. The unit suites double one surface at a time, so neither
 * can see that `retrySearch` and `searchAndGrabForBook` key the SAME `inFlightSearches` map — which
 * is the whole invariant. Nothing here doubles `withSearchDeadline`; the real production timer is
 * parked by `captureDeadlineTimers()` and fired on demand.
 */

vi.mock('../utils/enrich-usenet-languages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

const MAGNET = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d&dn=Test';

const book = { id: 5, title: 'Test Book', duration: 3600, path: null, authors: [{ name: 'Author' }], narrators: [] };

const searchHit = (): SearchResult => ({
  title: 'Test Book',
  protocol: 'torrent',
  indexer: 'abb',
  indexerId: 1,
  seeders: 10,
  size: 500 * 1024 * 1024,
  downloadUrl: MAGNET,
});

const insertedRow = {
  id: 1, publicId: 'dl_x', bookId: 5, indexerId: 1, downloadClientId: 1,
  title: 'Test Book', protocol: 'torrent' as const,
  infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d', downloadUrl: MAGNET,
  size: null, seeders: null, clientStatus: 'downloading' as const, pipelineStage: 'idle' as const,
  progress: 0, externalId: null, errorMessage: null, guid: null, outputPath: null,
  bookStatusAtGrab: 'wanted' as const, addedAt: new Date(), completedAt: null,
  progressUpdatedAt: null, pendingCleanup: null,
};

describe('#2477 — retry and the auto-grab pipeline share one per-book registry', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let addDownload: Mock;
  let removeDownload: Mock;
  let orchestrator: DownloadOrchestrator;
  let indexerSearchService: IndexerSearchService;
  let armed: Array<() => void>;

  const parkedSearch = () => vi.fn(() => new Promise<never>(() => { /* never settles */ }));

  const indexerService = inject<IndexerService>({
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'ABB', type: 'abb', enabled: true, settings: {} }),
    getAdapter: vi.fn().mockResolvedValue({
      type: 'abb', name: 'ABB', search: vi.fn(), test: vi.fn(),
      resolveDownloadUrl: vi.fn(async (ctx: { downloadUrl: string }) => ({ downloadUrl: ctx.downloadUrl })),
    }),
  });

  const blacklistService = inject<BlacklistService>({
    getBlacklistedHashes: vi.fn().mockResolvedValue(new Set<string>()),
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>(),
    }),
  });

  const qualitySettings = {
    grabFloor: 0, minSeeders: 1, protocolPreference: 'none' as const,
    rejectWords: '', requiredWords: '', maxDownloadSize: 0, minDownloadSize: 0,
  };

  /** Split by PROJECTION, not call order: blocker gathers, status capture and getById interleave. */
  function primeDb() {
    db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.select.mockImplementation((projection?: Record<string, unknown>) => {
      if (projection && 'download' in projection) return mockDbChain([{ download: insertedRow, book: null, indexer: null }]);
      if (projection && 'status' in projection) return mockDbChain([{ status: 'wanted' }]);
      return mockDbChain([]);
    });
  }

  function buildOrchestrator() {
    const downloadClientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'Client', type: 'blackhole', settings: {} }),
      getAdapter: vi.fn().mockResolvedValue({ addDownload, removeDownload }),
    });
    const service = new DownloadService(db as unknown as Db, downloadClientService, log);
    service.wire({ indexerService, retrySearchDeps: {} as never });
    return new DownloadOrchestrator(service, db as unknown as Db, log);
  }

  const pipelineDeps = () => ({
    indexerSearchService,
    downloadOrchestrator: orchestrator,
    qualitySettings,
    log,
    blacklistService,
    indexerService,
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
  });

  const retryDeps = (): RetrySearchDeps => ({
    indexerSearchService,
    indexerService,
    downloadOrchestrator: orchestrator,
    blacklistService,
    bookService: inject<BookService>({ getById: vi.fn().mockResolvedValue(book) }),
    settingsService: createMockSettingsService({ quality: qualitySettings }),
    retryBudget: new RetryBudget(),
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
    log,
  });

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    armed = captureDeadlineTimers();
    log = inject<FastifyBaseLogger>(createMockLogger());
    db = createMockDb();
    primeDb();
    addDownload = vi.fn().mockResolvedValue(null);
    removeDownload = vi.fn().mockResolvedValue(undefined);
    orchestrator = buildOrchestrator();
    indexerSearchService = inject<IndexerSearchService>({
      searchAllWithStatus: mockSearchAllWithStatus([searchHit()]),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  describe('AC3 — cross-surface single flight, both directions', () => {
    it('holds off a retry while the scheduled pipeline owns the book', async () => {
      const searchAllWithStatus = parkedSearch();
      indexerSearchService = inject<IndexerSearchService>({ searchAllWithStatus });

      const pipeline = searchAndGrabForBook(book, pipelineDeps());
      await vi.waitFor(() => expect(searchAllWithStatus).toHaveBeenCalledTimes(1));

      await expect(retrySearch(5, retryDeps())).resolves.toEqual({ outcome: 'already_active' });

      // No second ladder: the retry never reached an indexer at all.
      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);

      armed[0]!();
      await expect(pipeline).rejects.toThrow(/deadline/);
    });

    it('holds off the pipeline while a retry owns the book', async () => {
      const searchAllWithStatus = parkedSearch();
      indexerSearchService = inject<IndexerSearchService>({ searchAllWithStatus });

      const retry = retrySearch(5, retryDeps());
      await vi.waitFor(() => expect(searchAllWithStatus).toHaveBeenCalledTimes(1));

      await expect(searchAndGrabForBook(book, pipelineDeps())).resolves.toEqual({
        result: 'skipped', reason: 'search_already_in_flight',
      });

      expect(searchAllWithStatus).toHaveBeenCalledTimes(1);
      expect(armed).toHaveLength(1);

      armed[0]!();
      await expect(retry).resolves.toMatchObject({ outcome: 'retry_error' });
    });
  });

  // #2310 AC6, inherited rather than repaired: the deadline abandons the grab, it never tears it.
  describe('AC1 — the wrapped span covers the grab, and grab integrity is unchanged', () => {
    it('releases the caller with retry_error first, and still lands the abandoned row after', async () => {
      let releaseAdd!: () => void;
      addDownload.mockImplementation(() => new Promise<null>((resolve) => { releaseAdd = () => resolve(null); }));
      orchestrator = buildOrchestrator();

      const running = retrySearch(5, retryDeps());
      await vi.waitFor(() => expect(releaseAdd).toBeDefined());

      // Expiry lands between the client hand-off and the DB insert — the accepted #2310 window.
      expect(db.insert).not.toHaveBeenCalled();
      armed[0]!();
      await expect(running).resolves.toEqual({
        outcome: 'retry_error', error: expect.stringContaining('deadline'),
      });
      expect(db.insert).not.toHaveBeenCalled();

      releaseAdd();
      // Asserted in this order on purpose: the caller is released FIRST, the row lands AFTER.
      await vi.waitFor(() => expect(db.insert).toHaveBeenCalledTimes(1));
      const values = (db.insert.mock.results[0]!.value as { values: Mock }).values;
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 5, title: 'Test Book', downloadUrl: MAGNET,
      }));
    });

    it('frees the book for a fresh pipeline search once the abandoned grab settles', async () => {
      let releaseAdd!: () => void;
      addDownload.mockImplementation(() => new Promise<null>((resolve) => { releaseAdd = () => resolve(null); }));
      orchestrator = buildOrchestrator();

      const running = retrySearch(5, retryDeps());
      await vi.waitFor(() => expect(releaseAdd).toBeDefined());
      armed[0]!();
      await expect(running).resolves.toMatchObject({ outcome: 'retry_error' });

      // Still registered: the slot holds the WORK promise, which outlives its own deadline.
      await expect(searchAndGrabForBook(book, pipelineDeps())).resolves.toEqual({
        result: 'skipped', reason: 'search_already_in_flight',
      });

      releaseAdd();
      // The already-created hand-off resolves through its own closure; the follow-up search needs a
      // client that answers, or it would park on the same double and read as a registry hold.
      addDownload.mockResolvedValue(null);
      await vi.waitFor(async () => {
        await expect(searchAndGrabForBook(book, pipelineDeps())).resolves.toMatchObject({ result: 'grabbed' });
      });
    });
  });
});
