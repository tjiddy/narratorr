import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  INDEXER_BASE,
  WEBHOOK_URL,
  WEBHOOK_URL_2,
  DISCORD_WEBHOOK_URL,
  TORRENT_HASH,
  qbLoginHandler,
  qbAddTorrentHandler,
  qbGetTorrentHandler,
  torznabSearchHandler,
  webhookCaptureHandler,
  discordCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

// Mock audio scanner — enrichment needs valid audio files we don't have in tests
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

const MAGNET_URI = `magnet:?xt=urn:btih:${TORRENT_HASH}&dn=Test+Book`;

// Default sinks for all notification URLs — prevents onUnhandledRequest: 'error' blowups
const mswServer = setupServer(
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
  http.post(WEBHOOK_URL_2, () => new HttpResponse(null, { status: 200 })),
  http.post(DISCORD_WEBHOOK_URL, () => new HttpResponse(null, { status: 204 })),
);

describe('Notifier event triggers E2E', () => {
  let e2e: E2EApp;
  let indexerId: number;
  let downloadClientId: number;
  let downloadParent: string;
  let libraryDir: string;

  const DOWNLOAD_FOLDER = 'Test Audiobook';

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    // Temp directories for import tests
    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-notif-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-notif-lib-'));

    // Create download source with audio files
    const downloadSource = join(downloadParent, DOWNLOAD_FOLDER);
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(1024));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(2048));

    // Seed indexer
    const indexerRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Test Indexer',
        type: 'torznab',
        enabled: true,
        priority: 50,
        settings: { apiUrl: INDEXER_BASE, apiKey: 'test-key' },
      },
    });
    expect(indexerRes.statusCode).toBe(201);
    indexerId = indexerRes.json().id;

    // Seed download client (host/port must match QB_BASE)
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

    // Library + import settings
    await e2e.services.settings.set('library', {
      path: libraryDir,
      folderFormat: '{author}/{title}',
      fileFormat: '{author} - {title}',
    });
    await e2e.services.settings.set('import', {
      deleteAfterImport: false,
      minSeedTime: 0,
      minFreeSpaceGB: 5,
      redownloadFailed: true,
    });

    // Notifier 1: grab-only webhook (WEBHOOK_URL)
    const n1 = await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Grab-only Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_grab'],
        settings: { url: WEBHOOK_URL },
      },
    });
    expect(n1.statusCode).toBe(201);

    // Notifier 2: all-events webhook (WEBHOOK_URL_2)
    const n2 = await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'All Events Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_grab', 'on_import', 'on_failure'],
        settings: { url: WEBHOOK_URL_2 },
      },
    });
    expect(n2.statusCode).toBe(201);

    // Notifier 3: Discord (all events)
    const n3 = await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Discord Notifier',
        type: 'discord',
        enabled: true,
        events: ['on_grab', 'on_import', 'on_failure'],
        settings: { webhookUrl: DISCORD_WEBHOOK_URL },
      },
    });
    expect(n3.statusCode).toBe(201);
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

  /** Trigger a grab via API. Returns the grab response. */
  async function triggerGrab(title: string) {
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title, authors: [{ name: 'Test Author' }] },
    });
    expect(bookRes.statusCode).toBe(201);
    const bookId = bookRes.json().id;

    const grabRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/search/grab',
      payload: {
        downloadUrl: MAGNET_URI,
        title,
        protocol: 'torrent',
        bookId,
        indexerId,
        size: 1073741824,
      },
    });

    return { grabRes, bookId };
  }

  // ── Event Routing ──────────────────────────────────────────────────────

  describe('event routing', () => {
    it('notifier with on_grab only does NOT receive on_import events', async () => {
      const { handler: grabOnlyHandler, captured: grabOnlyCaptured } = webhookCaptureHandler(WEBHOOK_URL);
      const { handler: allEventsHandler, captured: allEventsCaptured } = webhookCaptureHandler(WEBHOOK_URL_2);
      const { handler: discordHandler, captured: discordCaptured } = discordCaptureHandler();

      vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

      mswServer.use(
        grabOnlyHandler,
        allEventsHandler,
        discordHandler,
        qbLoginHandler(),
        qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      );

      const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Routing Test Book', 'Routing Author');
      await e2e.services.importOrchestrator.importDownload(downloadId);

      // Wait for all-events webhook + discord to confirm notification cycle completed
      await waitForRequests(allEventsCaptured, 1);
      await waitForRequests(discordCaptured, 1);

      // Grab-only webhook should NOT have received the on_import event
      expect(grabOnlyCaptured).toHaveLength(0);
      expect((allEventsCaptured[0].body as Record<string, unknown>).event).toBe('on_import');
    });

    it('two webhooks subscribed to on_grab both receive notification', async () => {
      const { handler: hook1, captured: captured1 } = webhookCaptureHandler(WEBHOOK_URL);
      const { handler: hook2, captured: captured2 } = webhookCaptureHandler(WEBHOOK_URL_2);
      const { handler: discordHandler } = discordCaptureHandler();

      mswServer.use(
        hook1,
        hook2,
        discordHandler,
        torznabSearchHandler(),
        qbLoginHandler(),
        qbAddTorrentHandler(),
      );

      const { grabRes } = await triggerGrab('Multi-notifier Test');
      expect(grabRes.statusCode).toBe(201);

      await waitForRequests(captured1, 1);
      await waitForRequests(captured2, 1);

      expect(captured1).toHaveLength(1);
      expect(captured2).toHaveLength(1);
    });
  });

  // ── Webhook Payload Structure ──────────────────────────────────────────

  describe('webhook payload structure', () => {
    it('on_grab contains book.title, release.title, release.size', async () => {
      const { handler, captured } = webhookCaptureHandler(WEBHOOK_URL);
      const { handler: discordHandler } = discordCaptureHandler();

      mswServer.use(
        handler,
        discordHandler,
        torznabSearchHandler(),
        qbLoginHandler(),
        qbAddTorrentHandler(),
      );

      const { grabRes } = await triggerGrab('Grab Payload Test');
      expect(grabRes.statusCode).toBe(201);

      await waitForRequests(captured, 1);

      const payload = captured[0].body as Record<string, unknown>;
      expect(payload.event).toBe('on_grab');
      expect(payload.book).toEqual(expect.objectContaining({ title: 'Grab Payload Test' }));
      expect(payload.release).toEqual(expect.objectContaining({
        title: 'Grab Payload Test',
        size: 1073741824,
      }));
    });

    it('on_import contains book.title, book.author, import.libraryPath, import.fileCount', async () => {
      const { handler, captured } = webhookCaptureHandler(WEBHOOK_URL_2);
      const { handler: discordHandler } = discordCaptureHandler();

      vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

      mswServer.use(
        handler,
        discordHandler,
        qbLoginHandler(),
        qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      );

      const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Import Payload Test', 'Import Author');
      await e2e.services.importOrchestrator.importDownload(downloadId);

      await waitForRequests(captured, 1);

      const payload = captured[0].body as Record<string, unknown>;
      expect(payload.event).toBe('on_import');
      expect(payload.book).toEqual(expect.objectContaining({
        title: 'Import Payload Test',
        author: 'Import Author',
      }));
      expect(payload.import).toEqual(expect.objectContaining({
        libraryPath: expect.stringContaining('Import Payload Test'),
        fileCount: 2,
      }));
    });

    it('on_failure contains book.title, error.message, error.stage', async () => {
      const { handler, captured } = webhookCaptureHandler(WEBHOOK_URL_2);
      const { handler: discordHandler } = discordCaptureHandler();
      const badSavePath = join(tmpdir(), `narratorr-nonexistent-${Date.now()}`);

      mswServer.use(
        handler,
        discordHandler,
        qbLoginHandler(),
        qbGetTorrentHandler(TORRENT_HASH, badSavePath),
      );

      const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Failure Payload Test', 'Failure Author');
      await expect(e2e.services.importOrchestrator.importDownload(downloadId)).rejects.toThrow();

      await waitForRequests(captured, 1);

      const payload = captured[0].body as Record<string, unknown>;
      expect(payload.event).toBe('on_failure');
      expect(payload.book).toEqual(expect.objectContaining({ title: 'Failure Payload Test' }));
      expect(payload.error).toEqual(expect.objectContaining({
        message: expect.any(String),
        stage: 'import',
      }));
    });
  });

  // ── Discord Format ────────────────────────────────────────────────────

  describe('Discord format', () => {
    it('sends embed with title, color, fields, timestamp, and footer', async () => {
      const { handler, captured } = discordCaptureHandler();

      mswServer.use(
        handler,
        torznabSearchHandler(),
        qbLoginHandler(),
        qbAddTorrentHandler(),
      );

      const { grabRes } = await triggerGrab('Discord Format Test');
      expect(grabRes.statusCode).toBe(201);

      await waitForRequests(captured, 1);

      const body = captured[0].body as { embeds: Record<string, unknown>[] };
      expect(body.embeds).toHaveLength(1);

      const embed = body.embeds[0];
      expect(embed).toEqual(expect.objectContaining({
        title: 'Release Grabbed',
        color: 0x3498db,
        footer: { text: 'Narratorr' },
      }));

      // Fields should include Book title and Release title
      const fields = embed.fields as { name: string; value: string }[];
      expect(fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Book', value: 'Discord Format Test' }),
        expect.objectContaining({ name: 'Release', value: 'Discord Format Test' }),
      ]));

      // Timestamp should be a valid ISO 8601 string (round-trips through toISOString())
      const ts = embed.timestamp as string;
      expect(typeof ts).toBe('string');
      expect(new Date(ts).toISOString()).toBe(ts);
    });
  });

  // ── Resilience ────────────────────────────────────────────────────────

  describe('resilience', () => {
    it('grab succeeds when webhook returns 500', async () => {
      mswServer.use(
        http.post(WEBHOOK_URL, () => new HttpResponse('Error', { status: 500 })),
        http.post(WEBHOOK_URL_2, () => new HttpResponse('Error', { status: 500 })),
        http.post(DISCORD_WEBHOOK_URL, () => new HttpResponse('Error', { status: 500 })),
        torznabSearchHandler(),
        qbLoginHandler(),
        qbAddTorrentHandler(),
      );

      const { grabRes } = await triggerGrab('Resilience 500 Test');
      expect(grabRes.statusCode).toBe(201);

      const download = grabRes.json();
      expect(download.id).toBeDefined();
      expect(download.status).toBe('downloading');
    });

    it('import succeeds when webhook returns 500', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

      mswServer.use(
        http.post(WEBHOOK_URL, () => new HttpResponse('Error', { status: 500 })),
        http.post(WEBHOOK_URL_2, () => new HttpResponse('Error', { status: 500 })),
        http.post(DISCORD_WEBHOOK_URL, () => new HttpResponse('Error', { status: 500 })),
        qbLoginHandler(),
        qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      );

      const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Resilience Import 500 Test', 'Test Author');
      const result = await e2e.services.importOrchestrator.importDownload(downloadId);

      expect(result.downloadId).toBe(downloadId);
      expect(result.bookId).toBe(bookId);
      expect(result.fileCount).toBe(2);

      const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
      expect(bookRes.json().status).toBe('imported');
    });

    it('import succeeds when webhook returns network error', async () => {
      vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

      mswServer.use(
        http.post(WEBHOOK_URL, () => HttpResponse.error()),
        http.post(WEBHOOK_URL_2, () => HttpResponse.error()),
        http.post(DISCORD_WEBHOOK_URL, () => HttpResponse.error()),
        qbLoginHandler(),
        qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      );

      const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Resilience Network Test', 'Test Author');
      const result = await e2e.services.importOrchestrator.importDownload(downloadId);

      expect(result.downloadId).toBe(downloadId);
      expect(result.bookId).toBe(bookId);
      expect(result.fileCount).toBe(2);

      // Book status should still transition to imported
      const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
      expect(bookRes.json().status).toBe('imported');
    });
  });
});
