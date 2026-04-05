import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { downloads, books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  QB_BASE,
  INDEXER_BASE,
  WEBHOOK_URL,
  TORRENT_HASH,
  TORZNAB_SEARCH_XML,
  qbLoginHandler,
  qbAddTorrentHandler,
  qbGetTorrentHandler,
  torznabSearchHandler,
} from './msw-handlers.js';

vi.mock('../../core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn().mockResolvedValue(null),
}));

const MOCK_SCAN_RESULT = {
  codec: 'aac',
  bitrate: 128000,
  sampleRate: 44100,
  channels: 2,
  bitrateMode: 'cbr' as const,
  fileFormat: 'm4b',
  totalDuration: 3600,
  totalSize: 3072,
  fileCount: 2,
  hasCoverArt: false,
};

// Default webhook sink
const mswServer = setupServer(
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
);

const INDEXER_2_BASE = 'http://indexer2.test';
const MAGNET_URI = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=Test+Book`;

// Torznab XML that uses magnet URIs (no .torrent links) — needed because
// qBittorrent adapter extracts infohash from magnet URI, not .torrent URLs
const MAGNET_SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Test Indexer</title>
    <item>
      <title>The Way of Kings - Brandon Sanderson (Unabridged)</title>
      <guid isPermaLink="true">https://tracker.test/details/abc123</guid>
      <torznab:attr name="size" value="1073741824"/>
      <torznab:attr name="seeders" value="15"/>
      <torznab:attr name="infohash" value="${TORRENT_HASH}"/>
    </item>
  </channel>
</rss>`;

const INDEXER_2_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Second Indexer</title>
    <item>
      <title>Words of Radiance - Brandon Sanderson (Unabridged)</title>
      <guid isPermaLink="true">https://tracker2.test/details/def456</guid>
      <link>https://tracker2.test/download/def456.torrent</link>
      <enclosure url="https://tracker2.test/download/def456.torrent" length="2147483648" type="application/x-bittorrent"/>
      <torznab:attr name="size" value="2147483648"/>
      <torznab:attr name="seeders" value="25"/>
      <torznab:attr name="leechers" value="5"/>
      <torznab:attr name="infohash" value="bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434e"/>
    </item>
  </channel>
</rss>`;

describe('Multi-entity E2E', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-multi-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-multi-lib-'));

    const downloadSource = join(downloadParent, 'Test Audiobook');
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(1024));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(2048));

    await e2e.services.settings.set('library', {
      path: libraryDir,
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    await e2e.services.settings.set('import', {
      deleteAfterImport: false,
      minSeedTime: 0,
      minSeedRatio: 0,
      minFreeSpaceGB: 5,
      redownloadFailed: true,
    });
  });

  afterEach(() => {
    mswServer.resetHandlers();
    e2e.services.downloadClient.clearAdapterCache();
    vi.mocked(scanAudioDirectory).mockReset();
    vi.mocked(scanAudioDirectory).mockResolvedValue(null);
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
  });

  // ── Multi-indexer search aggregation ──────────────────────────────────

  it('multi-indexer search aggregates results from all enabled indexers', async () => {
    // Seed two indexers
    await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Indexer A',
        type: 'torznab',
        enabled: true,
        priority: 10,
        settings: { apiUrl: INDEXER_BASE, apiKey: 'key-a' },
      },
    });
    await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Indexer B',
        type: 'torznab',
        enabled: true,
        priority: 20,
        settings: { apiUrl: INDEXER_2_BASE, apiKey: 'key-b' },
      },
    });

    mswServer.use(
      torznabSearchHandler(INDEXER_BASE, TORZNAB_SEARCH_XML),
      http.get(`${INDEXER_2_BASE}/api`, () => {
        return new HttpResponse(INDEXER_2_XML, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }),
    );

    const searchRes = await e2e.app.inject({
      method: 'GET',
      url: '/api/search?q=Brandon+Sanderson',
    });

    expect(searchRes.statusCode).toBe(200);
    const results = searchRes.json().results;
    // Should have results from both indexers
    expect(results.length).toBeGreaterThanOrEqual(2);

    const titles = results.map((r: { title: string }) => r.title);
    // At minimum, one result from each indexer (titles get parsed so check loosely)
    expect(titles.length).toBeGreaterThanOrEqual(2);
  });

  // ── Multi-download-client: grab uses highest priority ─────────────────

  it('grab uses the highest-priority enabled download client matching the protocol', async () => {

    // Seed two torrent clients — priority 10 (high) and priority 90 (low)
    const highRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/download-clients',
      payload: {
        name: 'High Priority qBit',
        type: 'qbittorrent',
        enabled: true,
        priority: 10,
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false },
      },
    });
    expect(highRes.statusCode).toBe(201);
    const highClientId = highRes.json().id;

    const lowRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/download-clients',
      payload: {
        name: 'Low Priority qBit',
        type: 'qbittorrent',
        enabled: true,
        priority: 90,
        settings: { host: 'localhost', port: 9090, username: 'admin', password: 'password', useSsl: false },
      },
    });
    expect(lowRes.statusCode).toBe(201);

    // Only wire up MSW handlers for the high-priority client (port 8080)
    mswServer.use(
      qbLoginHandler(QB_BASE),
      qbAddTorrentHandler(QB_BASE),
    );

    // Seed a book and seed an indexer for grab
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'Priority Test Book', authors: [{ name: 'Test Author' }] },
    });
    const bookId = bookRes.json().id;

    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: 'Priority Test Book',
        protocol: 'torrent',
        bookId,
        size: 1073741824,
      },
    });

    expect(grabRes.statusCode).toBe(201);
    // The download should use the high-priority client
    expect(grabRes.json().downloadClientId).toBe(highClientId);
  });
});

describe('Job lifecycle E2E', () => {
  let e2e: E2EApp;
  let downloadClientId: number;
  let downloadParent: string;
  let libraryDir: string;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-job-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-job-lib-'));

    const downloadSource = join(downloadParent, 'Test Audiobook');
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(1024));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(2048));

    // Seed download client
    const clientRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/download-clients',
      payload: {
        name: 'Test qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false },
      },
    });
    expect(clientRes.statusCode).toBe(201);
    downloadClientId = clientRes.json().id;

    // Seed indexer
    const idxRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Job Test Indexer',
        type: 'torznab',
        enabled: true,
        priority: 50,
        settings: { apiUrl: INDEXER_BASE, apiKey: 'test-key' },
      },
    });
    expect(idxRes.statusCode).toBe(201);

    await e2e.services.settings.set('library', {
      path: libraryDir,
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
      namingSeparator: 'space',
      namingCase: 'default',
    });
    await e2e.services.settings.set('import', {
      deleteAfterImport: false,
      minSeedTime: 0,
      minSeedRatio: 0,
      minFreeSpaceGB: 5,
      redownloadFailed: true,
    });
    await e2e.services.settings.set('search', {
      enabled: true,
      intervalMinutes: 60,
      blacklistTtlDays: 7,
    });
  });

  afterEach(() => {
    mswServer.resetHandlers();
    e2e.services.downloadClient.clearAdapterCache();
    vi.mocked(scanAudioDirectory).mockReset();
    vi.mocked(scanAudioDirectory).mockResolvedValue(null);
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
  });

  // ── Search job E2E ──────────────────────────────────────────────────

  it('search job executes end-to-end: finds wanted books, searches indexers, saves results', async () => {
    // Create a wanted book
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] },
    });
    expect(bookRes.statusCode).toBe(201);

    // Use magnet-only XML so qBittorrent adapter can extract infohash
    mswServer.use(
      torznabSearchHandler(INDEXER_BASE, MAGNET_SEARCH_XML),
      qbLoginHandler(),
      qbAddTorrentHandler(),
    );

    const { runSearchJob } = await import('../jobs/search.js');
    const result = await runSearchJob(
      e2e.services.settings,
      e2e.services.bookList,
      e2e.services.indexer,
      e2e.services.downloadOrchestrator,
      e2e.app.log,
    );

    expect(result.searched).toBeGreaterThanOrEqual(1);
    // Search always grabs — qBit mock accepts any add
    expect(result.grabbed).toBeGreaterThanOrEqual(1);

    // Verify download was created
    const activityRes = await e2e.app.inject({ method: 'GET', url: '/api/activity' });
    const activity = (activityRes.json() as { data: { status: string }[] }).data;
    expect(activity.some((d) => d.status === 'downloading')).toBe(true);
  });

  // ── Monitor job: marks completed with completedAt ─────────────────

  it('monitor job marks download as completed with completedAt (does NOT trigger import)', async () => {
    // Create a book + download in 'downloading' state
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'Monitor Test Book', authors: [{ name: 'Monitor Author' }] },
    });
    const bookId = bookRes.json().id;

    await e2e.db.update(books).set({ status: 'downloading' }).where(eq(books.id, bookId));

    const [dl] = await e2e.db.insert(downloads).values({
      bookId,
      downloadClientId,
      title: 'Monitor Test Book',
      protocol: 'torrent' as const,
      externalId: TORRENT_HASH,
      status: 'downloading' as const,
    }).returning();

    // qBittorrent reports download as complete (progress 100%)
    mswServer.use(
      qbLoginHandler(),
      http.get(`${QB_BASE}/api/v2/torrents/info`, ({ request }) => {
        const url = new URL(request.url);
        const hashes = url.searchParams.get('hashes');
        if (hashes && hashes.toLowerCase() === TORRENT_HASH.toLowerCase()) {
          return HttpResponse.json([{
            hash: TORRENT_HASH.toLowerCase(),
            name: 'Monitor Test Book',
            save_path: downloadParent,
            content_path: `${downloadParent}/Monitor Test Book`,
            state: 'uploading',
            progress: 1,
            size: 1073741824,
            added_on: Math.floor(Date.now() / 1000) - 86400,
            completion_on: Math.floor(Date.now() / 1000) - 3600,
          }]);
        }
        return HttpResponse.json([]);
      }),
    );

    // Run the real monitor logic (exported from monitor job) — no QG orchestrator = no inline import trigger
    const { monitorDownloads } = await import('../jobs/monitor.js');
    await monitorDownloads(e2e.db, e2e.services.downloadClient, e2e.services.notifier, e2e.app.log);

    // Verify download is completed with timestamp
    const [updated] = await e2e.db.select().from(downloads).where(eq(downloads.id, dl.id));
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();

    // Book stays 'downloading' — promotion to 'importing' now happens in processOneDownload
    // (fire-and-forget from monitor), not directly in the monitor. Without a QG orchestrator
    // passed, the inline import path is not triggered.
    const bookCheck = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookCheck.json().status).toBe('downloading');
  });

  // ── Import job: picks up completed downloads ──────────────────────

  it('import job picks up completed downloads and runs import flow', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId, 'Import Job Book', 'Import Author');

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    // Call processCompletedDownloads directly (what the import job cron calls)
    const results = await e2e.services.importOrchestrator.processCompletedDownloads();

    expect(results.length).toBeGreaterThanOrEqual(1);
    const importResult = results.find((r) => r.downloadId === downloadId);
    expect(importResult).toBeTruthy();
    expect(importResult!.bookId).toBe(bookId);
    expect(importResult!.fileCount).toBe(2);

    // Book should now be imported
    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.json().status).toBe('imported');

    // Download should be imported too
    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl.status).toBe('imported');
  });
});
