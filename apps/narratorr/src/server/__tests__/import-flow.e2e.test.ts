import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { downloads, books } from '@narratorr/db/schema';
import { scanAudioDirectory } from '@narratorr/core/utils/audio-scanner';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import {
  QB_BASE,
  WEBHOOK_URL,
  TORRENT_HASH,
  qbLoginHandler,
  qbGetTorrentHandler,
  webhookCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

// Mock audio scanner at module level — enrichment calls this but real parsing needs valid audio files
vi.mock('@narratorr/core/utils/audio-scanner', () => ({
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

/**
 * Default webhook sink — absorbs fire-and-forget notifications so
 * onUnhandledRequest: 'error' doesn't blow up non-notification tests.
 * Notification-specific tests override this with webhookCaptureHandler().
 */
const mswServer = setupServer(
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
);

describe('Import flow E2E', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  const FILE_SIZE_1 = 1024;
  const FILE_SIZE_2 = 2048;
  const DOWNLOAD_FOLDER = 'Test Audiobook';

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    // Temp directories: download source + library target
    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-import-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-import-lib-'));

    // Create download source with audio files
    const downloadSource = join(downloadParent, DOWNLOAD_FOLDER);
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(FILE_SIZE_1));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(FILE_SIZE_2));

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

    // Seed notifier for webhook event tests
    const notifierRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/notifiers',
      payload: {
        name: 'Test Webhook',
        type: 'webhook',
        enabled: true,
        events: ['on_import', 'on_failure'],
        settings: { url: WEBHOOK_URL },
      },
    });
    expect(notifierRes.statusCode).toBe(201);

    // Library settings: path + folder format
    await e2e.services.settings.set('library', {
      path: libraryDir,
      folderFormat: '{author}/{title}',
    });

    // Import settings: default — no auto-delete
    await e2e.services.settings.set('import', {
      deleteAfterImport: false,
      minSeedTime: 0,
    });
  });

  afterEach(async () => {
    mswServer.resetHandlers();
    (e2e.services.downloadClient as unknown as { adapters: Map<number, unknown> }).adapters.clear();
    vi.mocked(scanAudioDirectory).mockReset();
    vi.mocked(scanAudioDirectory).mockResolvedValue(null);
    // Restore default import settings (torrent tests modify these)
    await e2e.services.settings.set('import', { deleteAfterImport: false, minSeedTime: 0 });
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
  });

  /**
   * Seed a book (status 'downloading') + completed download record.
   * Returns IDs for use in importDownload().
   */
  async function seedBookAndDownload(
    title: string,
    authorName: string,
    opts: { completedAt?: Date; externalId?: string } = {},
  ) {
    const bookRes = await e2e.app.inject({
      method: 'POST',
      url: '/api/books',
      payload: { title, authorName },
    });
    expect(bookRes.statusCode).toBe(201);
    const bookId = bookRes.json().id;

    // Set book to 'downloading' (realistic pre-import state after grab)
    await e2e.db.update(books).set({ status: 'downloading' }).where(eq(books.id, bookId));

    const [download] = await e2e.db.insert(downloads).values({
      bookId,
      downloadClientId,
      title,
      protocol: 'torrent' as const,
      externalId: opts.externalId ?? TORRENT_HASH,
      status: 'completed' as const,
      completedAt: opts.completedAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000),
    }).returning();

    return { bookId, downloadId: download.id };
  }

  it('imports completed download: files copied to library, book status imported, enrichment fields populated', async () => {
    const { bookId, downloadId } = await seedBookAndDownload('The Way of Kings', 'Brandon Sanderson');

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    const result = await e2e.services.import.importDownload(downloadId);

    // Import result
    const expectedTarget = join(libraryDir, 'Brandon Sanderson', 'The Way of Kings');
    expect(result.downloadId).toBe(downloadId);
    expect(result.bookId).toBe(bookId);
    expect(result.targetPath).toBe(expectedTarget);
    expect(result.fileCount).toBe(2);
    expect(result.totalSize).toBe(FILE_SIZE_1 + FILE_SIZE_2);

    // Files actually copied to library
    const targetFiles = await readdir(expectedTarget);
    expect(targetFiles.sort()).toEqual(['book.m4b', 'chapter2.m4b']);

    // Book record: status + path + enrichment fields from mock scan result
    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    const book = bookRes.json();
    expect(book.status).toBe('imported');
    expect(book.path).toBe(expectedTarget);
    expect(book.audioCodec).toBe('aac');
    expect(book.audioBitrate).toBe(128000);
    expect(book.audioSampleRate).toBe(44100);
    expect(book.audioChannels).toBe(2);
    expect(book.audioFileCount).toBe(2);
    expect(book.audioDuration).toBe(3600);
    expect(book.enrichmentStatus).toBe('file-enriched');

    // Download record: status transitioned to imported
    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl.status).toBe('imported');
  });

  it('fires on_import webhook notification with correct payload', async () => {
    const { downloadId } = await seedBookAndDownload('Notification Test Book', 'Test Author');

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    const { handler: webhookHandler, captured } = webhookCaptureHandler();
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      webhookHandler,
    );

    await e2e.services.import.importDownload(downloadId);

    // Bounded-timeout polling for fire-and-forget notification
    await waitForRequests(captured, 1);

    expect(captured).toHaveLength(1);
    const payload = captured[0].body as Record<string, unknown>;
    expect(payload.event).toBe('on_import');
    expect(payload.book).toEqual(expect.objectContaining({ title: 'Notification Test Book' }));
    expect(payload.import).toEqual(expect.objectContaining({
      libraryPath: expect.stringContaining('Notification Test Book'),
      fileCount: 2,
    }));
  });

  it('sets download to failed and fires on_failure notification when save path is invalid', async () => {
    const { bookId, downloadId } = await seedBookAndDownload('Failure Test Book', 'Test Author');
    const badSavePath = join(tmpdir(), `narratorr-nonexistent-${Date.now()}`);

    const { handler: webhookHandler, captured } = webhookCaptureHandler();
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, badSavePath),
      webhookHandler,
    );

    await expect(e2e.services.import.importDownload(downloadId)).rejects.toThrow();

    // Download status → failed with error message
    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl.status).toBe('failed');
    expect(dl.errorMessage).toBeTruthy();

    // Book status unchanged (failure happens before book update)
    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.json().status).toBe('downloading');

    // on_failure notification fired
    await waitForRequests(captured, 1);
    const payload = captured[0].body as Record<string, unknown>;
    expect(payload.event).toBe('on_failure');
    expect(payload.error).toEqual(expect.objectContaining({ stage: 'import' }));
  });

  it('calls removeDownload when deleteAfterImport is enabled and seed time is met', async () => {
    await e2e.services.settings.set('import', { deleteAfterImport: true, minSeedTime: 60 });

    // completedAt 2 hours ago — well past the 60-min seed time
    const { downloadId } = await seedBookAndDownload('Delete After Import Book', 'Test Author', {
      completedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    let deleteCalled = false;
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      http.post(`${QB_BASE}/api/v2/torrents/delete`, () => {
        deleteCalled = true;
        return new HttpResponse('');
      }),
    );

    await e2e.services.import.importDownload(downloadId);

    expect(deleteCalled).toBe(true);
  });

  it('does NOT call removeDownload when seed time has not elapsed', async () => {
    await e2e.services.settings.set('import', { deleteAfterImport: true, minSeedTime: 60 });

    // completedAt 1 minute ago — seed time NOT met (needs 60 min)
    const { downloadId } = await seedBookAndDownload('No Delete Book', 'Test Author', {
      completedAt: new Date(Date.now() - 1 * 60 * 1000),
    });

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    let deleteCalled = false;
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      http.post(`${QB_BASE}/api/v2/torrents/delete`, () => {
        deleteCalled = true;
        return new HttpResponse('');
      }),
    );

    await e2e.services.import.importDownload(downloadId);

    expect(deleteCalled).toBe(false);
  });
});
