import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { SearchResult } from '@core/index.js';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import { DownloadService } from './download.service.js';
import { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadClientService } from './download-client.service.js';
import type { IndexerSearchService } from './indexer-search.service.js';
import type { IndexerService } from './indexer.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { EventHistoryService } from './event-history.service.js';
import { searchAndGrabForBook } from './search-pipeline.js';
import { SearchDeadlineError, _resetSearchRegistryForTesting } from './search-deadline.js';
import { SEARCH_DEADLINE_MS } from '@core/utils/constants.js';
import { BlackholeClient } from '@core/download-clients/blackhole.js';
import { tmpdir } from 'node:os';

/**
 * #2310 AC6/AC8 at the service-integration layer. The unit suite in `search-pipeline.test.ts`
 * replaces `DownloadOrchestrator.grab`, so it cannot see the real `resolveAdapterDownloadUrl →
 * resolveArtifact → addDownload → insertDownloadRecordOrCompensate` chain the ACs are about. Here
 * the orchestrator, download service, record insert and Blackhole adapter are all real; only the
 * database, the download-client registry and the indexer search are doubled.
 */

// Passthrough spies on the three nested boundaries AC8 EXCLUDES from signal threading. Real
// implementations run; the spies exist so an accidental widening is visible.
vi.mock('./download-resolve-adapter-url.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./download-resolve-adapter-url.js')>();
  return { ...actual, resolveAdapterDownloadUrl: vi.fn(actual.resolveAdapterDownloadUrl) };
});
vi.mock('./download-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./download-record.js')>();
  return { ...actual, resolveArtifact: vi.fn(actual.resolveArtifact) };
});
vi.mock('@core/utils/network-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/utils/network-service.js')>();
  return { ...actual, fetchWithSsrfRedirect: vi.fn(actual.fetchWithSsrfRedirect) };
});
vi.mock('../utils/enrich-usenet-languages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

const { resolveAdapterDownloadUrl } = await import('./download-resolve-adapter-url.js');
const { resolveArtifact } = await import('./download-record.js');
const { fetchWithSsrfRedirect } = await import('@core/utils/network-service.js');

const MAGNET = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d&dn=Test';

const book = { id: 5, title: 'Test Book', duration: 3600, authors: [{ name: 'Author' }] };

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
  size: null, seeders: null, clientStatus: 'completed' as const, pipelineStage: 'idle' as const,
  progress: 1, externalId: null, errorMessage: null, guid: null, outputPath: null,
  bookStatusAtGrab: 'wanted' as const, addedAt: new Date(), completedAt: new Date(),
  progressUpdatedAt: null, pendingCleanup: null,
};

describe('#2310 grab integrity and excluded surfaces — real download chain', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let addDownload: Mock;
  let removeDownload: Mock;
  let getAdapter: Mock;
  let orchestrator: DownloadOrchestrator;
  let indexerSearchService: IndexerSearchService;
  let armed: Array<() => void>;

  /** Only the deadline's own timer is captured; every other timer in the process stays real. */
  function captureDeadlineTimers(): Array<() => void> {
    const captured: Array<() => void> = [];
    const original = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (delay !== SEARCH_DEADLINE_MS) return original(fn as never, delay as never, ...rest as never[]);
      captured.push(fn);
      const parked = original(() => { /* never fires within a test */ }, 2 ** 30);
      parked.unref();
      return parked;
    }) as never);
    return captured;
  }

  // The real `resolveAdapterDownloadUrl` walks getById → getAdapter → adapter.resolveDownloadUrl,
  // so the double must carry all three or the excluded boundary is never reached.
  const resolveDownloadUrl = vi.fn(async (ctx: { downloadUrl: string }) => ({ downloadUrl: ctx.downloadUrl }));
  const indexerService = inject<IndexerService>({
    getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'ABB', type: 'abb', enabled: true, settings: {} }),
    getAdapter: vi.fn().mockResolvedValue({ type: 'abb', name: 'ABB', search: vi.fn(), test: vi.fn(), resolveDownloadUrl }),
  });

  const blacklistService = inject<BlacklistService>({
    getBlacklistedIdentifiers: vi.fn().mockResolvedValue({
      blacklistedHashes: new Set<string>(), blacklistedGuids: new Set<string>(),
    }),
  });

  const qualitySettings = {
    grabFloor: 0, minSeeders: 1, protocolPreference: 'none',
    rejectWords: '', requiredWords: '', maxDownloadSize: 0, minDownloadSize: 0,
  };

  /**
   * Split the select stub by PROJECTION rather than call order: the grab issues blocker gathers,
   * a book-status capture and a getById re-read, and an order-based stub silently hands one of
   * them another's rows the moment the chain changes shape.
   */
  function primeDb() {
    db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.select.mockImplementation((projection?: Record<string, unknown>) => {
      if (projection && 'download' in projection) return mockDbChain([{ download: insertedRow, book: null, indexer: null }]);
      if (projection && 'status' in projection) return mockDbChain([{ status: 'wanted' }]);
      return mockDbChain([]);
    });
  }

  function buildOrchestrator(clientType = 'blackhole') {
    const downloadClientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'Client', type: clientType, settings: {} }),
      getAdapter,
    });
    const service = new DownloadService(db as unknown as Db, downloadClientService, log);
    service.wire({ indexerService, retrySearchDeps: {} as never });
    return new DownloadOrchestrator(service, db as unknown as Db, log);
  }

  const deps = () => ({
    indexerSearchService,
    downloadOrchestrator: orchestrator,
    qualitySettings,
    log,
    blacklistService,
    indexerService,
    eventHistory: inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({ id: 1 }) }),
  });

  beforeEach(() => {
    _resetSearchRegistryForTesting();
    vi.mocked(resolveAdapterDownloadUrl).mockClear();
    vi.mocked(resolveArtifact).mockClear();
    vi.mocked(fetchWithSsrfRedirect).mockClear();
    resolveDownloadUrl.mockClear();
    armed = captureDeadlineTimers();
    log = inject<FastifyBaseLogger>(createMockLogger());
    db = createMockDb();
    primeDb();
    addDownload = vi.fn().mockResolvedValue(null);
    removeDownload = vi.fn().mockResolvedValue(undefined);
    getAdapter = vi.fn().mockResolvedValue({ addDownload, removeDownload });
    orchestrator = buildOrchestrator();
    indexerSearchService = inject<IndexerSearchService>({
      searchAllWithStatus: vi.fn().mockResolvedValue({ results: [searchHit()], succeeded: 1, failed: 0 }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetSearchRegistryForTesting();
  });

  describe('AC6 — the deadline abandons the grab, it never tears it', () => {
    it('rejects the caller mid-handoff and STILL inserts the download row when the client add lands', async () => {
      let releaseAdd!: () => void;
      addDownload.mockImplementation(() => new Promise<null>((resolve) => { releaseAdd = () => resolve(null); }));

      const running = searchAndGrabForBook(book, deps());
      await vi.waitFor(() => expect(releaseAdd).toBeDefined());

      // Expiry lands between sendToClient and the DB insert — the exact window AC6 names.
      expect(db.insert).not.toHaveBeenCalled();
      armed[0]!();
      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
      expect(db.insert).not.toHaveBeenCalled();

      releaseAdd();
      // Asserted in this order on purpose: the caller is released FIRST, the row lands AFTER.
      await vi.waitFor(() => expect(db.insert).toHaveBeenCalledTimes(1));
      const values = (db.insert.mock.results[0]!.value as { values: Mock }).values;
      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        bookId: 5, title: 'Test Book', downloadUrl: MAGNET, externalId: null,
      }));
    });

    it('never reaches the client or the insert when the deadline fires during the search', async () => {
      vi.mocked(indexerSearchService.searchAllWithStatus).mockImplementation(() => new Promise(() => { /* stalled */ }));

      const running = searchAndGrabForBook(book, deps());
      await vi.waitFor(() => expect(armed).toHaveLength(1));
      armed[0]!();

      await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
      expect(addDownload).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    // The orphan-window controls: #2310 must leave these EXACTLY as it found them, so each runs
    // once with the deadline idle and once with it already expired, and the verdict must match.
    describe.each([
      ['with the deadline idle', false],
      ['with the deadline already expired', true],
    ])('%s', (_label, expire) => {
      it('runs NO compensation for a Blackhole handoff whose insert fails — there is no external id', async () => {
        addDownload.mockImplementation(async () => {
          if (!expire) return null;
          return new Promise<null>((resolve) => { setTimeout(() => resolve(null), 0); });
        });
        db.insert.mockReturnValue(mockDbChain([], { error: new Error('SQLITE_FULL') }));

        const running = searchAndGrabForBook(book, deps());
        if (expire) {
          await vi.waitFor(() => expect(armed).toHaveLength(1));
          armed[0]!();
          await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
          await vi.waitFor(() => expect(db.insert).toHaveBeenCalled());
        } else {
          await expect(running).resolves.toEqual({ result: 'grab_error', error: expect.any(Error) });
        }

        expect(removeDownload).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('orphaned external download'));
      });

      it('logs the documented orphan warning when an external-id insert fails and the compensation adapter is gone', async () => {
        addDownload.mockResolvedValue('ext-42');
        db.insert.mockReturnValue(mockDbChain([], { error: new Error('SQLITE_FULL') }));
        // First getAdapter serves sendToClient; the compensation lookup then finds nothing.
        getAdapter.mockResolvedValueOnce({ addDownload, removeDownload }).mockResolvedValue(null);

        const running = searchAndGrabForBook(book, deps());
        if (expire) {
          await vi.waitFor(() => expect(armed).toHaveLength(1));
          armed[0]!();
          await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
          await vi.waitFor(() => expect(db.insert).toHaveBeenCalled());
        } else {
          await expect(running).resolves.toEqual({ result: 'grab_error', error: expect.any(Error) });
        }

        await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ externalId: 'ext-42', clientId: 1 }),
          'Download insert failed AND compensation adapter unavailable — orphaned external download (operator recovery needed)',
        ));
        expect(removeDownload).not.toHaveBeenCalled();
      });
    });
  });

  describe('AC8 — the nested resolve/fetch/handoff boundaries never receive the deadline signal', () => {
    it('calls resolveAdapterDownloadUrl, and the adapter hook it reaches, with no signal', async () => {
      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      expect(resolveAdapterDownloadUrl).toHaveBeenCalledTimes(1);
      const args = vi.mocked(resolveAdapterDownloadUrl).mock.calls[0]!;
      expect(args).toHaveLength(3);
      expect(args[0]).not.toHaveProperty('signal');
      expect(args.some((a) => a instanceof AbortSignal)).toBe(false);

      // The MAM-style resolve hook is the surface AC8 actually names; assert at it, not just above it.
      expect(resolveDownloadUrl).toHaveBeenCalledTimes(1);
      expect(resolveDownloadUrl.mock.calls[0]![0]).not.toHaveProperty('signal');
    });

    it('calls resolveArtifact with only url, protocol and the allowlist thunk', async () => {
      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      expect(resolveArtifact).toHaveBeenCalledTimes(1);
      const args = vi.mocked(resolveArtifact).mock.calls[0]!;
      expect(args).toHaveLength(3);
      expect(args.some((a) => a instanceof AbortSignal)).toBe(false);
    });

    it('calls addDownload with an artifact that carries no signal', async () => {
      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      const [artifact, options] = addDownload.mock.calls[0]!;
      expect(artifact).not.toHaveProperty('signal');
      expect(options).toBeUndefined();
    });

    it('calls fetchWithSsrfRedirect with no signal when a real Blackhole handoff fetches an NZB', async () => {
      // Only an HTTP artifact reaches the redirect helper, so drive the usenet path end to end.
      const watchDir = tmpdir();
      const blackhole = new BlackholeClient({ watchDir, protocol: 'usenet' });
      addDownload = vi.fn((...args: Parameters<BlackholeClient['addDownload']>) => blackhole.addDownload(...args));
      getAdapter = vi.fn().mockResolvedValue({ addDownload, removeDownload });
      orchestrator = buildOrchestrator();
      vi.mocked(fetchWithSsrfRedirect).mockResolvedValue(new Response(Buffer.from('<nzb/>'), { status: 200 }));
      vi.mocked(indexerSearchService.searchAllWithStatus).mockResolvedValue({
        results: [{ ...searchHit(), protocol: 'usenet', downloadUrl: 'https://indexer.test/getnzb/abc.nzb' }],
        succeeded: 1, failed: 0,
      });

      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      expect(fetchWithSsrfRedirect).toHaveBeenCalled();
      for (const [, options] of vi.mocked(fetchWithSsrfRedirect).mock.calls) {
        expect(options ?? {}).not.toHaveProperty('signal');
      }
    });
  });
});
