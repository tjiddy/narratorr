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
import { join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

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
  let stageDownload: Mock;
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

  const stagedDouble = () => ({ commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) });

  /** Swap in the staging capability and rebuild the graph that captured the previous adapter. */
  function useStagingAdapter() {
    getAdapter.mockResolvedValue({ addDownload, stageDownload, removeDownload });
    orchestrator = buildOrchestrator();
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
    stageDownload = vi.fn();
    removeDownload = vi.fn().mockResolvedValue(undefined);
    // Default to the no-capability adapter: absence of `stageDownload` is what the grab path keys on.
    getAdapter = vi.fn().mockResolvedValue({ addDownload, removeDownload });
    orchestrator = buildOrchestrator();
    indexerSearchService = inject<IndexerSearchService>({
      searchAllWithStatus: vi.fn().mockResolvedValue({ results: [searchHit()], succeeded: 1, failed: 0, skipped: [] }),
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
      // #2341 rewrote the verdict this control pins: the handoff is staged, so a failed insert
      // now has something to discard. There is still no external id and still no control channel.
      it('discards the staged Blackhole handoff whose insert fails, publishing and compensating nothing', async () => {
        const handoff = stagedDouble();
        stageDownload.mockImplementation(async () => {
          if (expire) await new Promise((resolve) => { setTimeout(resolve, 0); });
          return handoff;
        });
        useStagingAdapter();
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

        await vi.waitFor(() => expect(handoff.abort).toHaveBeenCalledTimes(1));
        expect(handoff.commit).not.toHaveBeenCalled();
        expect(addDownload).not.toHaveBeenCalled();
        expect(removeDownload).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('orphaned external download'));
      });

      // The AC6 claim survives the reordering: an abandoned chain still reaches its insert AND
      // its publish, which is now the step after it.
      it('publishes the staged handoff only once the insert has landed, never before', async () => {
        const handoff = stagedDouble();
        stageDownload.mockResolvedValue(handoff);
        useStagingAdapter();
        let releaseInsert!: () => void;
        const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
        db.insert.mockReturnValue({
          values: vi.fn().mockReturnValue({ returning: vi.fn().mockImplementation(() => insertGate.then(() => [{ id: 1 }])) }),
        } as never);

        const running = searchAndGrabForBook(book, deps());
        await vi.waitFor(() => expect(db.insert).toHaveBeenCalled());
        expect(handoff.commit).not.toHaveBeenCalled();

        if (expire) {
          armed[0]!();
          await expect(running).rejects.toBeInstanceOf(SearchDeadlineError);
        }
        releaseInsert();
        if (!expire) await expect(running).resolves.toMatchObject({ result: 'grabbed' });

        await vi.waitFor(() => expect(handoff.commit).toHaveBeenCalledTimes(1));
        expect(handoff.abort).not.toHaveBeenCalled();
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

  // #2341 AC9: the guarantee is about what the watch DIRECTORY holds, which no adapter double can
  // show. The real Blackhole client runs against a real directory through the real grab chain.
  describe('#2341 — no consumable artifact survives a failed insert', () => {
    let watchDir: string;

    beforeEach(async () => {
      watchDir = await mkdtemp(join(tmpdir(), 'grab-integrity-'));
    });

    afterEach(async () => {
      try {
        await rm(watchDir, { recursive: true, force: true });
      } catch { /* a leaked tmpdir is cheaper than a red suite on Windows */ }
    });

    it('leaves the watch directory empty when the download row cannot be written', async () => {
      getAdapter = vi.fn().mockResolvedValue(new BlackholeClient({ watchDir, protocol: 'torrent' }));
      orchestrator = buildOrchestrator();
      db.insert.mockReturnValue(mockDbChain([], { error: new Error('SQLITE_FULL') }));

      await expect(searchAndGrabForBook(book, deps())).resolves.toEqual({ result: 'grab_error', error: expect.any(Error) });

      expect(await readdir(watchDir)).toEqual([]);
    });

    it('publishes exactly one consumable artifact when the row does land', async () => {
      getAdapter = vi.fn().mockResolvedValue(new BlackholeClient({ watchDir, protocol: 'torrent' }));
      orchestrator = buildOrchestrator();

      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      const names = await readdir(watchDir);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^\d+\.magnet$/);
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
        succeeded: 1, failed: 0, skipped: [],
      });

      await expect(searchAndGrabForBook(book, deps())).resolves.toMatchObject({ result: 'grabbed' });

      expect(fetchWithSsrfRedirect).toHaveBeenCalled();
      for (const [, options] of vi.mocked(fetchWithSsrfRedirect).mock.calls) {
        expect(options ?? {}).not.toHaveProperty('signal');
      }
    });
  });
});
