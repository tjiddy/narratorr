import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import {
  INDEXER_BASE,
  WEBHOOK_URL,
  TORRENT_HASH,
  TORZNAB_SEARCH_XML,
  qbLoginHandler,
  qbAddTorrentHandler,
  qbAddTorrentErrorHandler,
  qbLoginErrorHandler,
  webhookCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

const MAGNET_URI = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=The+Way+of+Kings`;

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
        authorName: 'Brandon Sanderson',
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

    const searchRes = await e2e.app.inject({
      method: 'GET',
      url: '/api/search?q=Brandon+Sanderson',
    });

    expect(searchRes.statusCode).toBe(200);
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

    // Search
    const searchRes = await e2e.app.inject({
      method: 'GET',
      url: '/api/search?q=Brandon+Sanderson',
    });
    expect(searchRes.statusCode).toBe(200);
    const results = searchRes.json();
    expect(results.length).toBeGreaterThan(0);

    const firstResult = results[0];

    // Grab using magnet URI (qBittorrent adapter extracts hash from magnet, not .torrent URLs)
    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title: firstResult.title,
        protocol: 'torrent',
        bookId,
        indexerId,
        size: firstResult.size,
        seeders: firstResult.seeders,
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
        authorName: 'Test Author',
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
    const payload = captured[0].body as Record<string, unknown>;
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
        authorName: 'Test Author',
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
    const downloads = activityRes.json() as { bookId: number | null }[];
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
        authorName: 'Test Author',
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
    const downloads = activityRes.json() as { bookId: number | null }[];
    expect(downloads.filter((d) => d.bookId === unreachableBookId)).toHaveLength(0);

    // Book should still be 'wanted'
    const bookCheck = await e2e.app.inject({
      method: 'GET',
      url: `/api/books/${unreachableBookId}`,
    });
    expect(bookCheck.json().status).toBe('wanted');
  });
});
