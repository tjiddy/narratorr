/**
 * #2420 end-to-end — the whole lazy-resolution chain, driven through the REAL AudioBookBay adapter
 * over MSW: search row -> `abb-details://` sentinel -> `DownloadService.grab` ->
 * `resolveAdapterDownloadUrl` -> `resolveArtifact` -> a fake download client.
 *
 * A mock adapter cannot prove any of it. The defect this guards against lives in the branch where
 * the adapter does NOT throw — an injected double is free to reject on cue, which proves the
 * service and nothing about the adapter (see `degrading-adapter-invisible-to-mock-suite`).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { AudioBookBayIndexer } from '@core/indexers/abb.js';
import { abbThrottle, _resetAbbThrottleForTesting } from '@core/indexers/abb-throttle.js';
import { ABB_DETAILS_SENTINEL_PREFIX } from '@core/indexers/abb-sentinel.js';
import { IndexerError } from '@core/indexers/errors.js';
import { parseInfoHash } from '@core/utils/magnet.js';
import type { IndexerAdapter } from '@core/index.js';
import { DownloadService } from './download.service.js';
import type { DownloadClientService } from './download-client.service.js';
import type { IndexerService } from './indexer.service.js';
import { buildGrabPayload } from './grab-payload.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbIndexer } from '../__tests__/factories.js';

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;
const MURDER_SLUG = 'murder-in-the-new-forest';
const DETAILS_URL = `${ABB_BASE}/audio-books/${MURDER_SLUG}/`;
const SENTINEL = `${ABB_DETAILS_SENTINEL_PREFIX}${DETAILS_URL}`;
/** #2434 — the persisted identity is path-derived, so a mirror hop cannot invalidate it. */
const DETAILS_GUID = `abb:/audio-books/${MURDER_SLUG}/`;
const FIXTURE_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const SEARCH_HTML = `<html><body><div class="post"><div class="postTitle">
  <h2><a href="/audio-books/${MURDER_SLUG}/" rel="bookmark">Murder in the New Forest</a></h2>
</div></div></body></html>`;

const DETAIL_HTML = `<html><body>
  <h1>Murder in the New Forest</h1>
  <table><tr><td>Info Hash:</td><td>${FIXTURE_HASH}</td></tr></table>
</body></html>`;

const ABB_ROW = createMockDbIndexer({ id: 7, name: 'AudioBookBay', type: 'abb', settings: {} });

describe('#2420 — an ABB grab resolves its magnet at download time', () => {
  const server = useMswServer();
  let db: ReturnType<typeof createMockDb>;
  let service: DownloadService;
  let adapter: { addDownload: Mock; removeDownload: Mock };
  let abb: AudioBookBayIndexer;
  let detailRequests: string[];

  beforeEach(() => {
    _resetAbbThrottleForTesting();
    // The 6.1s floor would make each grab a six-second test; its timing lives in abb-throttle.test.ts.
    vi.spyOn(abbThrottle, 'acquire').mockResolvedValue(undefined);
    detailRequests = [];
    abb = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });

    adapter = { addDownload: vi.fn().mockResolvedValue('ext-123'), removeDownload: vi.fn() };
    const clientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'qBit', enabled: true }),
      getAdapter: vi.fn().mockResolvedValue(adapter),
    });

    db = createMockDb();
    db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.update.mockReturnValue(mockDbChain());
    service = new DownloadService(db as unknown as Db, clientService, inject<FastifyBaseLogger>(createMockLogger()));
    wireIndexer(ABB_ROW);
  });

  /** `wire` is once-only, so the indexer row a test wants is chosen before the first grab. */
  function wireIndexer(row: unknown): void {
    service.wire({
      indexerService: inject<IndexerService>({
        getById: vi.fn().mockResolvedValue(row),
        getAdapter: vi.fn().mockResolvedValue(abb as unknown as IndexerAdapter),
        getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
      }),
    } as never);
  }

  afterEach(() => {
    _resetAbbThrottleForTesting();
    vi.restoreAllMocks();
  });

  /** No active download for the book, then the post-insert read-back. */
  function stubGrabReads(): void {
    db.select
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain([{
        download: { id: 1, title: 'Murder in the New Forest', protocol: 'torrent', clientStatus: 'downloading', pipelineStage: 'idle', progress: 0 },
        book: createMockDbBook(),
      }]));
  }

  function serveDetail(respond: () => Response): void {
    server.use(
      http.get(`${ABB_BASE}/`, () => new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } })),
      http.get(`${ABB_BASE}/audio-books/:slug/`, ({ request }) => {
        detailRequests.push(request.url);
        return respond();
      }),
    );
  }

  /** The values `insertDownloadRecord` wrote, read off the insert chain. */
  function insertedRow(): Record<string, unknown> {
    return (db.insert.mock.results[0]!.value as { values: Mock }).values.mock.calls[0]![0] as Record<string, unknown>;
  }

  it('turns a search row into a magnet the client receives, and persists hash + details-URL guid', async () => {
    serveDetail(() => new HttpResponse(DETAIL_HTML, { headers: { 'Content-Type': 'text/html' } }));
    stubGrabReads();

    // The payload is built by the shared helper with no guid override — the RSS-path shape.
    const { results } = await abb.search('murder');
    expect(results[0]!.downloadUrl).toBe(SENTINEL);
    const payload = buildGrabPayload({ ...results[0]!, indexerId: 7 }, 1, { source: 'rss' });

    await service.grab(payload);

    expect(detailRequests).toEqual([DETAILS_URL]);
    const artifact = adapter.addDownload.mock.calls[0]![0] as { type: string; uri: string; infoHash: string };
    expect(artifact.type).toBe('magnet-uri');
    expect(parseInfoHash(artifact.uri)).toBe(FIXTURE_HASH);
    expect(artifact.infoHash).toBe(FIXTURE_HASH);
    expect(artifact.uri).not.toContain(ABB_DETAILS_SENTINEL_PREFIX);

    const row = insertedRow();
    expect(row.infoHash).toBe(FIXTURE_HASH);
    // AC13: the guid reaches persistence with no explicit override, so the later blacklist entry
    // has something an ABB search result can still be matched on.
    expect(row.guid).toBe(DETAILS_GUID);
  });

  it('fails the grab when the resolve fails, sending nothing and inserting nothing', async () => {
    serveDetail(() => new HttpResponse(null, { status: 500 }));
    stubGrabReads();

    const error = await service.grab({
      downloadUrl: SENTINEL,
      title: 'Murder in the New Forest',
      protocol: 'torrent',
      bookId: 1,
      indexerId: 7,
      guid: DETAILS_GUID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IndexerError);
    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  // The no-hash arm is the one that must not degrade: a swallowed failure would hand the client
  // the sentinel string itself, which `resolveArtifact` cannot parse.
  it('fails the grab when the detail page loads but carries no hash', async () => {
    serveDetail(() => new HttpResponse('<html><body><h1>Book</h1></body></html>', { headers: { 'Content-Type': 'text/html' } }));
    stubGrabReads();

    const error = await service.grab({
      downloadUrl: SENTINEL,
      title: 'Murder in the New Forest',
      protocol: 'torrent',
      bookId: 1,
      indexerId: 7,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IndexerError);
    expect((error as IndexerError).message).toContain('no info hash');
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });

  /**
   * The stale-indexer race: the row is deleted between search and grab, so the resolve hook is
   * never reached and the sentinel goes straight to `resolveArtifact`. MAM has the identical
   * exposure. What matters is that it is a clean error, not a crash or a staged bad artifact.
   */
  it('fails cleanly when the indexer no longer resolves, never staging the sentinel', async () => {
    stubGrabReads();
    // A fresh service, because `wire` refuses a second call: the row was deleted between search
    // and grab, so `resolveAdapterDownloadUrl` short-circuits and the sentinel reaches the parser.
    service = new DownloadService(
      db as unknown as Db,
      inject<DownloadClientService>({
        getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'qBit', enabled: true }),
        getAdapter: vi.fn().mockResolvedValue(adapter),
      }),
      inject<FastifyBaseLogger>(createMockLogger()),
    );
    wireIndexer(undefined);

    const error = await service.grab({
      downloadUrl: SENTINEL,
      title: 'Murder in the New Forest',
      protocol: 'torrent',
      bookId: 1,
      indexerId: 7,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(adapter.addDownload).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('fails the same way with no indexerId at all, which short-circuits the resolve hook', async () => {
    stubGrabReads();

    const error = await service.grab({
      downloadUrl: SENTINEL,
      title: 'Murder in the New Forest',
      protocol: 'torrent',
      bookId: 1,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(detailRequests).toEqual([]);
    expect(adapter.addDownload).not.toHaveBeenCalled();
  });
});
