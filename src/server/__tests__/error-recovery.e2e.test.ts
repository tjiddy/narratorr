import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { downloads, books } from '@db/schema.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  INDEXER_BASE,
  WEBHOOK_URL,
  WEBHOOK_URL_2,
  TORRENT_HASH,
  TORZNAB_SEARCH_XML,
  qbLoginHandler,
  qbGetTorrentHandler,
  qbLoginErrorHandler,
  webhookCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

vi.mock('@core/utils/audio-scanner.js', () => ({
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

const mswServer = setupServer(
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
  http.post(WEBHOOK_URL_2, () => new HttpResponse(null, { status: 200 })),
);

describe('Error recovery E2E', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-err-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-err-lib-'));

    const downloadSource = join(downloadParent, 'Test Audiobook');
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(1024));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(2048));

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

    await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Webhook 1',
        type: 'webhook',
        enabled: true,
        events: ['on_import', 'on_failure'],
        settings: { url: WEBHOOK_URL },
      },
    });

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

  afterEach(async () => {
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

  it('import fails gracefully when download client is unreachable — download failed, book recovered to wanted', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId, 'Unreachable Client Book', 'Test Author');

    mswServer.use(qbLoginErrorHandler(500));

    await expect(e2e.services.import.importDownload(downloadId)).rejects.toThrow();

    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl!.clientStatus).toBe('failed');
    expect(dl!.pipelineStage).toBe('idle');
    expect(dl!.errorMessage).toBeTruthy();

    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.json().status).toBe('wanted');
  });

  it('search handles indexer failure with partial results from other indexers', async () => {
    const INDEXER_2_BASE = 'http://indexer2.test';

    const idx1 = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Failing Indexer',
        type: 'torznab',
        enabled: true,
        priority: 10,
        settings: { apiUrl: INDEXER_BASE, apiKey: 'test-key' },
      },
    });
    expect(idx1.statusCode).toBe(201);

    const idx2 = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Working Indexer',
        type: 'torznab',
        enabled: true,
        priority: 20,
        settings: { apiUrl: INDEXER_2_BASE, apiKey: 'test-key-2' },
      },
    });
    expect(idx2.statusCode).toBe(201);

    mswServer.use(
      http.get(`${INDEXER_BASE}/api`, () => {
        return new HttpResponse('Server Error', { status: 500 });
      }),
      http.get(`${INDEXER_2_BASE}/api`, () => {
        return new HttpResponse(TORZNAB_SEARCH_XML, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }),
    );

    // SSE needs listen+fetch and does not compose with this inject harness; route event behavior
    // is covered separately, while this service call retains E2E coverage of both HTTP endpoints.
    const results = await e2e.services.indexerSearch.searchAll('Brandon Sanderson');
    expect(results.length).toBeGreaterThan(0);
  });

  it('notifier dispatch continues when one notifier endpoint fails', async () => {
    await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Working Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_import'],
        settings: { url: WEBHOOK_URL_2 },
      },
    });

    const { downloadId } = await seedBookAndDownload(e2e, downloadClientId, 'Notifier Fail Test', 'Test Author');
    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    const { handler: workingHandler, captured } = webhookCaptureHandler(WEBHOOK_URL_2);
    mswServer.use(
      http.post(WEBHOOK_URL, () => new HttpResponse('Error', { status: 500 })),
      workingHandler,
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    const result = await e2e.services.importOrchestrator.importDownload(downloadId);
    expect(result.fileCount).toBe(2);

    await waitForRequests(captured, 1);
    expect(captured).toHaveLength(1);
    expect((captured[0]!.body as Record<string, unknown>).event).toBe('on_import');
  });

  it('enrichment failure leaves book with existing data intact, retries only after 1-hour window', async () => {
    const AUDNEXUS_BASE = 'https://api.audnex.us';
    const TEST_ASIN = 'B001TEST01';

    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title: 'Enrichment Test Book', authors: [{ name: 'Enrich Author' }], asin: TEST_ASIN },
    });
    expect(bookRes.statusCode).toBe(201);
    const bookId = bookRes.json().id;

    await e2e.db.update(books).set({ enrichmentStatus: 'pending' }).where(eq(books.id, bookId));

    // Only a true ASIN 404 plus empty fallback marks failed; transient provider errors retain pending.
    mswServer.use(
      http.get(`${AUDNEXUS_BASE}/books/${TEST_ASIN}`, () => {
        return new HttpResponse('Not Found', { status: 404 });
      }),
      http.get('https://api.audible.com/1.0/catalog/products', () => {
        return HttpResponse.json({ products: [] });
      }),
    );

    const { runEnrichment } = await import('../jobs/enrichment.js');
    await runEnrichment(e2e.db, e2e.services.metadata, e2e.services.book, e2e.app.log);

    const [bookAfterFail] = await e2e.db.select().from(books).where(eq(books.id, bookId));
    expect(bookAfterFail!.enrichmentStatus).toBe('failed');
    expect(bookAfterFail!.title).toBe('Enrichment Test Book');

    // Install success first; a recent updatedAt must still suppress the immediate retry.
    mswServer.use(
      http.get(`${AUDNEXUS_BASE}/books/${TEST_ASIN}`, () => {
        return HttpResponse.json({
          asin: TEST_ASIN,
          title: 'Test Book',
          authors: [{ name: 'Test Author' }],
          narrators: [{ name: 'New Narrator' }],
          runtimeLengthMin: 206,
        });
      }),
    );
    await runEnrichment(e2e.db, e2e.services.metadata, e2e.services.book, e2e.app.log);

    const [bookAfterImmediate] = await e2e.db.select().from(books).where(eq(books.id, bookId));
    expect(bookAfterImmediate!.enrichmentStatus).toBe('failed');
    expect(bookAfterImmediate!.title).toBe('Enrichment Test Book');

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await e2e.db.update(books).set({ updatedAt: twoHoursAgo }).where(eq(books.id, bookId));

    await runEnrichment(e2e.db, e2e.services.metadata, e2e.services.book, e2e.app.log);

    const [bookAfterRetry] = await e2e.db.select().from(books).where(eq(books.id, bookId));
    expect(bookAfterRetry!.enrichmentStatus).toBe('enriched');
  });
});
