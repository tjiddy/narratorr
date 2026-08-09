import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { downloads } from '@db/schema.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  QB_BASE,
  WEBHOOK_URL,
  TORRENT_HASH,
  qbLoginHandler,
  qbGetTorrentHandler,
  webhookCaptureHandler,
  waitForRequests,
} from './msw-handlers.js';

// Real audio parsing needs valid media; these fixtures exercise only the import flow.
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

// Absorb fire-and-forget notifications; notification tests override this handler.
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

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-import-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-import-lib-'));

    const downloadSource = join(downloadParent, DOWNLOAD_FOLDER);
    await mkdir(downloadSource, { recursive: true });
    await writeFile(join(downloadSource, 'book.m4b'), Buffer.alloc(FILE_SIZE_1));
    await writeFile(join(downloadSource, 'chapter2.m4b'), Buffer.alloc(FILE_SIZE_2));

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
    // Torrent tests mutate these defaults.
    await e2e.services.settings.set('import', { deleteAfterImport: false, minSeedTime: 0, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true });
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
  });

  it('imports completed download: files copied to library, book status imported, enrichment fields populated', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId,'The Way of Kings', 'Brandon Sanderson');

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    const result = await e2e.services.import.importDownload(downloadId);

    const expectedTarget = join(libraryDir, 'Brandon Sanderson', 'The Way of Kings').split('\\').join('/');
    expect(result.downloadId).toBe(downloadId);
    expect(result.bookId).toBe(bookId);
    expect(result.targetPath).toBe(expectedTarget);
    expect(result.fileCount).toBe(2);
    expect(result.totalSize).toBe(FILE_SIZE_1 + FILE_SIZE_2);

    const targetFiles = await readdir(expectedTarget);
    // With no per-file token, every rendered stem collides and receives an ordinal (#1192).
    expect(targetFiles.sort()).toEqual([
      'Brandon Sanderson - The Way of Kings (1).m4b',
      'Brandon Sanderson - The Way of Kings (2).m4b',
    ]);

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

    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl!.pipelineStage).toBe('imported');
  });

  it('fires on_import webhook notification with correct payload', async () => {
    const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Notification Test Book', 'Test Author');

    vi.mocked(scanAudioDirectory).mockResolvedValueOnce(MOCK_SCAN_RESULT);

    const { handler: webhookHandler, captured } = webhookCaptureHandler();
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
      webhookHandler,
    );

    await e2e.services.importOrchestrator.importDownload(downloadId);

    await waitForRequests(captured, 1);

    expect(captured).toHaveLength(1);
    const payload = captured[0]!.body as Record<string, unknown>;
    expect(payload.event).toBe('on_import');
    expect(payload.book).toEqual(expect.objectContaining({ title: 'Notification Test Book' }));
    expect(payload.import).toEqual(expect.objectContaining({
      libraryPath: expect.stringContaining('Notification Test Book'),
      fileCount: 2,
    }));
  });

  it('sets download to failed and fires on_failure notification when save path is invalid', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Failure Test Book', 'Test Author');
    const badSavePath = join(tmpdir(), `narratorr-nonexistent-${Date.now()}`);

    const { handler: webhookHandler, captured } = webhookCaptureHandler();
    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, badSavePath),
      webhookHandler,
    );

    await expect(e2e.services.importOrchestrator.importDownload(downloadId)).rejects.toThrow();

    const [dl] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(dl!.clientStatus).toBe('failed');
    expect(dl!.pipelineStage).toBe('idle');
    expect(dl!.errorMessage).toBeTruthy();

    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.json().status).toBe('wanted');

    await waitForRequests(captured, 1);
    const payload = captured[0]!.body as Record<string, unknown>;
    expect(payload.event).toBe('on_failure');
    expect(payload.error).toEqual(expect.objectContaining({ stage: 'import' }));
  });

  it('calls removeDownload when deleteAfterImport is enabled and seed time is met', async () => {
    await e2e.services.settings.set('import', { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true });

    const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'Delete After Import Book', 'Test Author', {
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
    await e2e.services.settings.set('import', { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true });

    const { downloadId } = await seedBookAndDownload(e2e, downloadClientId,'No Delete Book', 'Test Author', {
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
