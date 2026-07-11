import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { downloads } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import {
  INDEXER_BASE,
  WEBHOOK_URL,
  TORRENT_HASH,
  TORZNAB_SEARCH_XML,
  qbLoginHandler,
  qbAddTorrentHandler,
  qbAddTorrentErrorHandler,
  qbDeleteTorrentHandler,
  qbLoginErrorHandler,
  webhookCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

const MAGNET_URI = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=The+Way+of+Kings`;
const REPLACEMENT_HASH = 'bbf4c61ddcc5e8a2dabede0f3b482cd9aea9434e';
const MAGNET_URI_2 = `magnet:?xt=urn:btih:${REPLACEMENT_HASH}&dn=Replacement+Release`;

const mswServer = setupServer();

describe('Search → Grab flow E2E', () => {
  let e2e: E2EApp;
  let indexerId: number;
  let downloadClientId: number;
  let bookId: number;

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });

    e2e = await createE2EApp();

    // Seed indexer via API
    const indexerRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Test Torznab',
        type: 'torznab',
        enabled: true,
        priority: 50,
        settings: { apiUrl: INDEXER_BASE, apiKey: 'test-api-key' },
      },
    });
    expect(indexerRes.statusCode).toBe(201);
    indexerId = indexerRes.json().id;

    // Seed download client via API — host/port must match QB_BASE
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

    // Seed a book (wanted status)
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'The Way of Kings',
        authors: [{ name: 'Brandon Sanderson' }],
      },
    });
    expect(bookRes.statusCode).toBe(201);
    bookId = bookRes.json().id;
  });

  afterEach(() => {
    mswServer.resetHandlers();
    // Clear adapter cache so each test gets fresh adapter behavior.
    // The qBittorrent adapter caches its auth session — without clearing,
    // error-path tests reuse the cached (authenticated) adapter.
    e2e.services.downloadClient.clearAdapterCache();
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
  });

  it('searches the indexer with correct query params', async () => {
    let capturedUrl: URL | undefined;

    mswServer.use(
      http.get(`${INDEXER_BASE}/api`, ({ request }) => {
        capturedUrl = new URL(request.url);
        return new HttpResponse(TORZNAB_SEARCH_XML, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }),
    );

    // GET /api/search retired in Wave 11.2 (#755); SSE /api/search/stream is
    // the active surface. Exercise the indexer service directly so the MSW
    // capture still verifies the outgoing query params.
    await e2e.services.indexerSearch.searchAll('Brandon Sanderson');

    expect(capturedUrl).toBeDefined();
    expect(capturedUrl!.searchParams.get('t')).toBe('search');
    expect(capturedUrl!.searchParams.get('q')).toBe('Brandon Sanderson');
    expect(capturedUrl!.searchParams.get('cat')).toBe('3030');
    expect(capturedUrl!.searchParams.get('apikey')).toBe('test-api-key');
    expect(capturedUrl!.searchParams.has('limit')).toBe(true);
  });

  it('search → grab creates download record and transitions book status', async () => {
    mswServer.use(
      http.get(`${INDEXER_BASE}/api`, () => {
        return new HttpResponse(TORZNAB_SEARCH_XML, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }),
      qbLoginHandler(),
      qbAddTorrentHandler(),
    );

    // GET /api/search retired in Wave 11.2 (#755). The grab path under test
    // here doesn't depend on the search route; exercise the indexer service
    // directly to obtain a search result for grab.
    const results = await e2e.services.indexerSearch.searchAll('Brandon Sanderson');
    expect(results.length).toBeGreaterThan(0);

    const firstResult = results[0];

    // Grab using magnet URI (qBittorrent adapter extracts hash from magnet, not .torrent URLs)
    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: firstResult!.title,
        protocol: 'torrent',
        bookId,
        indexerId,
        size: firstResult!.size,
        seeders: firstResult!.seeders,
      },
    });

    expect(grabRes.statusCode).toBe(201);
    const download = grabRes.json();
    expect(download.id).toBeDefined();
    expect(download.downloadClientId).toBe(downloadClientId);
    expect(download.protocol).toBe('torrent');
    expect(download.externalId).toBeDefined();
    expect(download.infoHash).toBe(TORRENT_HASH);
    expect(download.status).toBe('downloading');

    // Verify book status transitioned to downloading
    const bookRes = await e2e.app.inject({
      method: 'GET',
      url: `/api/books/${bookId}`,
    });
    expect(bookRes.statusCode).toBe(200);
    expect(bookRes.json().status).toBe('downloading');
  });

  it('grab sends on_grab notification to webhook notifier', async () => {
    // Create a notifier
    const notifierRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Test Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_grab'],
        settings: { url: WEBHOOK_URL },
      },
    });
    expect(notifierRes.statusCode).toBe(201);

    const { handler: webhookHandler, captured } = webhookCaptureHandler();
    mswServer.use(
      http.get(`${INDEXER_BASE}/api`, () => {
        return new HttpResponse(TORZNAB_SEARCH_XML, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      }),
      qbLoginHandler(),
      qbAddTorrentHandler(),
      webhookHandler,
    );

    // Need a new book since the previous one may already be 'downloading'
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Notification Test Book',
        authors: [{ name: 'Test Author' }],
      },
    });
    const newBookId = bookRes.json().id;

    // Grab with magnet URI
    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: 'Notification Test Book',
        protocol: 'torrent',
        bookId: newBookId,
        indexerId,
        size: 1073741824,
      },
    });
    expect(grabRes.statusCode).toBe(201);

    // Wait for fire-and-forget notification
    await waitForRequests(captured, 1);

    expect(captured).toHaveLength(1);
    const payload = captured[0]!.body as Record<string, unknown>;
    expect(payload.event).toBe('on_grab');
    expect(payload.book).toEqual(expect.objectContaining({ title: 'Notification Test Book' }));
    expect(payload.release).toEqual(expect.objectContaining({
      title: 'Notification Test Book',
      size: 1073741824,
    }));
  });

  it('grab fails when download client rejects add (non-2xx)', async () => {
    mswServer.use(
      qbLoginHandler(),
      qbAddTorrentErrorHandler(500),
    );

    // Create a fresh book
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Rejected Grab Book',
        authors: [{ name: 'Test Author' }],
      },
    });
    const rejectedBookId = bookRes.json().id;

    // Grab — should fail
    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: 'Rejected Grab Book',
        protocol: 'torrent',
        bookId: rejectedBookId,
        indexerId,
      },
    });

    expect(grabRes.statusCode).toBe(500);
    expect(grabRes.json().error).toBeDefined();

    // No download record should have been created for this book
    const activityRes = await e2e.app.inject({ method: 'GET', url: '/api/activity' });
    const downloads = (activityRes.json() as { data: { bookId: number | null }[] }).data;
    expect(downloads.filter((d) => d.bookId === rejectedBookId)).toHaveLength(0);

    // Book status should remain 'wanted'
    const bookCheck = await e2e.app.inject({
      method: 'GET',
      url: `/api/books/${rejectedBookId}`,
    });
    expect(bookCheck.json().status).toBe('wanted');
  });

  it('grab fails when download client is unreachable (auth fails)', async () => {
    mswServer.use(
      qbLoginErrorHandler(500),
    );

    // Create a fresh book
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: {
        title: 'Unreachable Client Book',
        authors: [{ name: 'Test Author' }],
      },
    });
    const unreachableBookId = bookRes.json().id;

    // Grab — should fail due to auth error
    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: 'Unreachable Client Book',
        protocol: 'torrent',
        bookId: unreachableBookId,
        indexerId,
      },
    });

    expect(grabRes.statusCode).toBe(500);
    expect(grabRes.json().error).toBeDefined();

    // No download record should have been created for this book
    const activityRes = await e2e.app.inject({ method: 'GET', url: '/api/activity' });
    const downloads = (activityRes.json() as { data: { bookId: number | null }[] }).data;
    expect(downloads.filter((d) => d.bookId === unreachableBookId)).toHaveLength(0);

    // Book should still be 'wanted'
    const bookCheck = await e2e.app.inject({
      method: 'GET',
      url: `/api/books/${unreachableBookId}`,
    });
    expect(bookCheck.json().status).toBe('wanted');
  });


  describe('grab endpoint nullish/non-object throw guard (search.ts ACTIVE_DOWNLOAD_EXISTS path)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns 500 without crashing when orchestrator throws null', async () => {
      vi.spyOn(e2e.services.downloadOrchestrator, 'grabInternal').mockRejectedValueOnce(null);
      const res = await e2e.app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI, title: 'Guard Test', protocol: 'torrent', bookId, indexerId },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'null' });
    });

    it('returns 500 without crashing when orchestrator throws a plain string', async () => {
      vi.spyOn(e2e.services.downloadOrchestrator, 'grabInternal').mockRejectedValueOnce('unexpected failure');
      const res = await e2e.app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI, title: 'Guard Test', protocol: 'torrent', bookId, indexerId },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'unexpected failure' });
    });

    it('returns 500 without crashing when orchestrator throws a plain object without a code property', async () => {
      vi.spyOn(e2e.services.downloadOrchestrator, 'grabInternal').mockRejectedValueOnce({ message: 'no code here' });
      const res = await e2e.app.inject({
        method: 'POST',
        url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI, title: 'Guard Test', protocol: 'torrent', bookId, indexerId },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: '[object Object]' });
    });
  });

  // #1857 F14 — end-to-end confirm-&-replace + PIPELINE_ACTIVE-cancels-nothing,
  // driven through route → orchestrator → claim transaction → download client → DB.
  describe('cancel-&-replace flow (#1857 F14)', () => {
    async function seedBook(title: string): Promise<number> {
      const res = await e2e.app.inject({ method: 'POST', url: '/api/books', payload: { title, authors: [{ name: 'Author' }] } });
      expect(res.statusCode).toBe(201);
      return res.json().id;
    }

    it('initial 409 ACTIVE_DOWNLOAD_EXISTS → confirmed replace cancels the old download and grabs the new one', async () => {
      mswServer.use(qbLoginHandler(), qbAddTorrentHandler(), qbDeleteTorrentHandler());
      const replaceBookId = await seedBook('Replace Flow Book');

      // First grab → a live downloading download.
      const first = await e2e.app.inject({
        method: 'POST', url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI, title: 'Release A', protocol: 'torrent', bookId: replaceBookId, indexerId },
      });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id;

      // Second grab for the same book WITHOUT replace → structured 409 conflict.
      const conflict = await e2e.app.inject({
        method: 'POST', url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI_2, title: 'Release B', protocol: 'torrent', bookId: replaceBookId, indexerId },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Release A' }, count: 1 });

      // Confirmed replace → 201, a NEW download row.
      const replace = await e2e.app.inject({
        method: 'POST', url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI_2, title: 'Release B', protocol: 'torrent', bookId: replaceBookId, indexerId, replace: true },
      });
      expect(replace.statusCode).toBe(201);
      const newId = replace.json().id;
      expect(newId).not.toBe(firstId);
      expect(replace.json().infoHash).toBe(REPLACEMENT_HASH);

      // Old download claim-cancelled (failed), new one downloading, book still downloading.
      const oldDl = await e2e.app.inject({ method: 'GET', url: `/api/activity/${firstId}` });
      expect(oldDl.json().status).toBe('failed');
      const newDl = await e2e.app.inject({ method: 'GET', url: `/api/activity/${newId}` });
      expect(newDl.json().status).toBe('downloading');
      const book = await e2e.app.inject({ method: 'GET', url: `/api/books/${replaceBookId}` });
      expect(book.json().status).toBe('downloading');
    });

    it('a book with a pipeline-stage download returns PIPELINE_ACTIVE and cancels nothing', async () => {
      const pipelineBookId = await seedBook('Pipeline Book');
      // Insert a download already in the import pipeline (checking) directly.
      const [inserted] = await e2e.db.insert(downloads).values({
        publicId: generatePublicId('dl'), bookId: pipelineBookId, downloadClientId, title: 'In Pipeline',
        protocol: 'torrent', clientStatus: 'completed', pipelineStage: 'checking', progress: 1, externalId: 'ext-checking',
      }).returning();

      const res = await e2e.app.inject({
        method: 'POST', url: '/api/search/grab',
        payload: { downloadUrl: MAGNET_URI, title: 'New', protocol: 'torrent', bookId: pipelineBookId, indexerId, replace: true },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: 'PIPELINE_ACTIVE', reason: 'processing' });

      // The pipeline download is untouched — replace cancelled nothing.
      const dl = await e2e.app.inject({ method: 'GET', url: `/api/activity/${inserted!.id}` });
      expect(dl.json().status).toBe('checking');
    });
  });
});
