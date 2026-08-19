/**
 * #2420 test 49 — the ABB identity chain end to end, on a REAL database:
 *
 *   real ABB adapter search (MSW)
 *     -> runRssJob -> buildGrabPayload with NO guid override
 *     -> real DownloadService.grab -> real resolveDownloadUrl -> real persistence
 *     -> real EventHistoryService.markFailed -> real BlacklistService.create
 *     -> runRssJob again -> real filterBlacklistedResults drops the same release
 *
 * Every link is production code. The separate unit tests each prove one hop, but a contract drift
 * BETWEEN hops — RSS payload construction, persisted download identity, blacklist creation,
 * blacklist filtering — is invisible to all of them: each would stay green while the release is
 * re-grabbed on the next RSS pass. That whole-chain drift is what this test exists to catch, and
 * it is why the download client is the only mocked boundary.
 *
 * Reds against a `buildGrabPayload` that drops `result.guid`: the download row then persists
 * `guid: null`, the blacklist entry is hash-only, and pass two re-grabs — because an ABB search
 * result no longer carries the hash that entry holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { blacklist, bookEvents, books, downloadClients, downloads, indexers } from '@db/schema.js';
import { eq } from 'drizzle-orm';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { AudioBookBayIndexer } from '@core/indexers/abb.js';
import { abbThrottle, _resetAbbThrottleForTesting } from '@core/indexers/abb-throttle.js';
import type { IndexerAdapter, SearchResult } from '@core/index.js';
import { runRssJob } from './rss.js';
import { DownloadService } from '../services/download.service.js';
import { BlacklistService } from '../services/blacklist.service.js';
import { EventHistoryService } from '../services/event-history.service.js';
import type { BookService } from '../services/book.service.js';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { DownloadOrchestrator } from '../services/download-orchestrator.js';
import type { IndexerService } from '../services/indexer.service.js';
import type { IndexerSearchService } from '../services/indexer-search.service.js';
import type { BookListService } from '../services/book-list.service.js';
import { createMockLogger, inject, createMockSettingsService } from '../__tests__/helpers.js';

vi.mock('../utils/enrich-usenet-languages.js', async (importActual) => ({
  ...(await importActual<typeof import('../utils/enrich-usenet-languages.js')>()),
  enrichUsenetLanguages: vi.fn(),
}));

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;
const DETAILS_URL = `${ABB_BASE}/audio-books/murder-in-the-new-forest/`;
/** #2434 — path-derived, so the entry survives a mirror hop; the sentinel stays an absolute URL. */
const DETAILS_GUID = 'abb:/audio-books/murder-in-the-new-forest/';
const FIXTURE_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const BOOK_TITLE = 'Murder in the New Forest';

const SEARCH_HTML = `<html><body><div class="post"><div class="postTitle">
  <h2><a href="/audio-books/murder-in-the-new-forest/" rel="bookmark">${BOOK_TITLE}</a></h2>
</div></div></body></html>`;
const DETAIL_HTML = `<html><body><h1>${BOOK_TITLE}</h1><pre>Info Hash: ${FIXTURE_HASH}</pre></body></html>`;

describe('#2420 — an RSS-origin ABB grab round-trips its guid through the blacklist', () => {
  const server = useMswServer();
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let abb: AudioBookBayIndexer;
  let downloadService: DownloadService;
  let blacklistService: BlacklistService;
  let eventHistory: EventHistoryService;
  let clientAdapter: { addDownload: Mock; removeDownload: Mock };
  let bookId: number;

  beforeEach(async () => {
    _resetAbbThrottleForTesting();
    // The 6.1s floor would make this a multi-second test; its timing lives in abb-throttle.test.ts.
    vi.spyOn(abbThrottle, 'acquire').mockResolvedValue(undefined);

    dir = mkdtempSync(join(tmpdir(), 'abb-guid-roundtrip-'));
    await runMigrations(join(dir, 'narratorr.db'));
    db = createDb(join(dir, 'narratorr.db'));
    log = createMockLogger();

    await db.insert(downloadClients).values({ name: 'qBit', type: 'qbittorrent', settings: {} });
    await db.insert(indexers).values({ id: 7, name: 'AudioBookBay', type: 'abb', settings: {} });
    const [book] = await db.insert(books).values({
      publicId: 'bk_test0000000000000001', title: BOOK_TITLE, status: 'wanted', duration: 600,
    }).returning();
    bookId = book!.id;

    server.use(
      http.get(`${ABB_BASE}/`, () => new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } })),
      http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(DETAIL_HTML, { headers: { 'Content-Type': 'text/html' } })),
    );

    abb = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
    clientAdapter = { addDownload: vi.fn().mockResolvedValue('ext-123'), removeDownload: vi.fn() };

    downloadService = new DownloadService(
      db,
      inject<DownloadClientService>({
        getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'qBit', enabled: true }),
        getAdapter: vi.fn().mockResolvedValue(clientAdapter),
      }),
      inject<FastifyBaseLogger>(log),
    );
    downloadService.wire({
      indexerService: inject<IndexerService>({
        getById: vi.fn().mockResolvedValue({ id: 7, name: 'AudioBookBay', type: 'abb', settings: {} }),
        getAdapter: vi.fn().mockResolvedValue(abb as unknown as IndexerAdapter),
        getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
      }),
    } as never);

    blacklistService = new BlacklistService(db, inject<FastifyBaseLogger>(log));
    eventHistory = new EventHistoryService(
      db,
      inject<FastifyBaseLogger>(log),
      blacklistService,
      inject<BookService>({ updateStatus: vi.fn() }),
    );
  });

  afterEach(() => {
    db.$client.close();
    _resetAbbThrottleForTesting();
    vi.restoreAllMocks();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  /** The real adapter's own search rows — the only place the sentinel and guid come from. */
  async function abbFeed(): Promise<SearchResult[]> {
    const { results } = await abb.search(BOOK_TITLE);
    return results.map((r) => ({ ...r, indexerId: 7 }));
  }

  /**
   * `runRssJob` with the real blacklist gate and a grab that delegates to the real DownloadService.
   * `buildGrabPayload` therefore runs inside `rss.ts` with `{ source: 'rss' }` and no guid override.
   */
  async function runRss(feed: SearchResult[]) {
    const orchestrator = inject<DownloadOrchestrator>({
      grab: vi.fn((params: Parameters<DownloadService['grab']>[0]) => downloadService.grab(params)),
    });
    const result = await runRssJob(
      createMockSettingsService({ rss: { enabled: true } }),
      inject<BookListService>({
        getAll: vi.fn().mockResolvedValue({
          data: [{ id: bookId, title: BOOK_TITLE, status: 'wanted', duration: 600, authors: [], narrators: [] }],
          total: 1,
        }),
      }),
      inject<IndexerSearchService>({
        getRssCapableIndexers: vi.fn().mockResolvedValue([{ id: 7, name: 'AudioBookBay', type: 'abb', enabled: true }]),
        pollRss: vi.fn().mockResolvedValue({ results: feed }),
      }),
      orchestrator,
      blacklistService,
      inject<IndexerService>({
        getLanAllowlist: vi.fn().mockResolvedValue({ hostPort: new Set<string>(), hostname: new Set<string>() }),
      }),
      inject<FastifyBaseLogger>(log),
    );
    return { result, grab: orchestrator.grab as Mock };
  }

  it('builds the RSS payload with the path-derived guid and no explicit override', async () => {
    const feed = await abbFeed();
    expect(feed[0]!.downloadUrl).toBe(`abb-details://${DETAILS_URL}`);
    expect(feed[0]).not.toHaveProperty('infoHash');

    const { grab } = await runRss(feed);

    // `rss.ts` passes only `{ source: 'rss' }`; the guid can only have come from the shared helper.
    expect(grab).toHaveBeenCalledWith(expect.objectContaining({ source: 'rss', guid: DETAILS_GUID }));
  });

  /**
   * The chain proper. Deliberately asserts no mock arguments before the tail: an early
   * payload-shape assertion short-circuits the run and leaves persistence, blacklist creation and
   * the next-pass gate unexercised, so a break in any of those would hide behind it.
   */
  it('persists the path-derived guid, blacklists on it, and drops the same release next pass', async () => {
    // --- pass one: RSS grabs the sentinel-bearing release ---
    const first = await runRss(await abbFeed());
    expect(first.result.grabbed).toBe(1);

    // --- the resolved artifact reached the client, and persistence kept BOTH identities ---
    const artifact = clientAdapter.addDownload.mock.calls[0]![0] as { type: string; infoHash: string };
    expect(artifact.type).toBe('magnet-uri');
    const [row] = await db.select().from(downloads);
    expect(row!.guid).toBe(DETAILS_GUID);
    expect(row!.infoHash).toBe(FIXTURE_HASH);

    // --- the operator marks it failed: the real bad_quality path writes the blacklist entry ---
    // The event's bookId is left null deliberately: the book-revert and fire-and-forget retry
    // branches are orthogonal to the identity chain and would make the assertion non-deterministic.
    const [event] = await db.insert(bookEvents).values({
      downloadId: row!.id, bookTitle: BOOK_TITLE, eventType: 'grabbed', source: 'auto',
    }).returning();
    await eventHistory.markFailed(event!.id);

    const [entry] = await db.select().from(blacklist);
    expect(entry!.guid).toBe(DETAILS_GUID);
    expect(entry!.reason).toBe('bad_quality');

    // --- pass two: the same feed is now dropped by the real blacklist gate ---
    const second = await runRss(await abbFeed());
    expect(second.result.matched).toBe(0);
    expect(second.result.grabbed).toBe(0);
    expect(second.grab).not.toHaveBeenCalled();
    expect(await db.select().from(downloads)).toHaveLength(1);
  });

  /**
   * The control. Without it the case above also passes against "the second pass never grabs
   * anything" — a broken feed, a broken matcher or an always-empty gate would look identical.
   */
  it('control: with no blacklist entry, the second pass grabs the release again', async () => {
    const first = await runRss(await abbFeed());
    expect(first.result.grabbed).toBe(1);

    // Clear the book's active download so the duplicate guard is not what stops pass two.
    await db.delete(downloads).where(eq(downloads.bookId, bookId));

    const second = await runRss(await abbFeed());

    expect(second.result.matched).toBe(1);
    expect(second.result.grabbed).toBe(1);
  });

  /**
   * #2434 — the test problem 1 exists for. ABB's mirrors rotate, and a mirror hop is an operator
   * config edit: a host-bearing guid would change with it, every stored blacklist entry would stop
   * matching, and every known-bad release would silently re-enter grab eligibility on the one
   * indexer where a wasted grab costs a paced fetch against a ban-sensitive site.
   *
   * Reds against a host-bearing guid: the mirror's feed then carries `https://<host B>/...`, the
   * entry written under host A no longer matches, and pass two re-grabs the release.
   */
  it('keeps a blacklist entry matching after the operator reconfigures ABB onto a different mirror', async () => {
    const MIRROR_HOST = 'audiobookbay.mirror';
    const MIRROR_BASE = `https://${MIRROR_HOST}`;

    // --- pass one on host A: grab, fail, blacklist ---
    expect((await runRss(await abbFeed())).result.grabbed).toBe(1);
    const [row] = await db.select().from(downloads);
    const [event] = await db.insert(bookEvents).values({
      downloadId: row!.id, bookTitle: BOOK_TITLE, eventType: 'grabbed', source: 'auto',
    }).returning();
    await eventHistory.markFailed(event!.id);
    expect((await db.select().from(blacklist))[0]!.guid).toBe(DETAILS_GUID);

    // The book's active download is what the duplicate guard keys on; clearing it leaves the
    // blacklist gate as the only thing that can stop pass two.
    await db.delete(downloads).where(eq(downloads.bookId, bookId));

    // --- the operator moves to mirror B, which serves the same paths ---
    server.use(
      http.get(`${MIRROR_BASE}/`, () => new HttpResponse(SEARCH_HTML, { headers: { 'Content-Type': 'text/html' } })),
      http.get(`${MIRROR_BASE}/audio-books/:slug/`, () => new HttpResponse(DETAIL_HTML, { headers: { 'Content-Type': 'text/html' } })),
    );
    const mirror = new AudioBookBayIndexer({ hostname: MIRROR_HOST, pageLimit: 1 });
    const mirrorFeed = (await mirror.search(BOOK_TITLE)).results.map((r) => ({ ...r, indexerId: 7 }));

    // The row genuinely came off the new host — otherwise the drop below proves nothing about hops.
    expect(mirrorFeed[0]!.downloadUrl).toBe(`abb-details://${MIRROR_BASE}/audio-books/murder-in-the-new-forest/`);
    expect(mirrorFeed[0]!.guid).toBe(DETAILS_GUID);

    const second = await runRss(mirrorFeed);

    expect(second.result.matched).toBe(0);
    expect(second.result.grabbed).toBe(0);
    expect(second.grab).not.toHaveBeenCalled();
  });

  // The identity the entry is keyed on must be ABB's search-time one. A hash-only entry — what a
  // guid-dropping payload produces — cannot match an ABB result, which carries no hash at all.
  it('a hash-only blacklist entry does NOT stop the next pass, which is why the guid must persist', async () => {
    await blacklistService.create({ infoHash: FIXTURE_HASH, title: BOOK_TITLE, reason: 'bad_quality' });

    const { result, grab } = await runRss(await abbFeed());

    expect(result.grabbed).toBe(1);
    expect(grab).toHaveBeenCalledTimes(1);
  });
});
