import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  WEBHOOK_URL,
  TORRENT_HASH,
  qbLoginHandler,
  qbGetTorrentHandler,
} from './msw-handlers.js';

/**
 * Exercise the real music-metadata scanner with the tracked silent fixture. Import absorbs
 * enrichment failures, so successful import alone does not prove scanning ran; assert
 * `enrichmentStatus === 'file-enriched'` plus persisted audio metadata.
 */

const FIXTURE_PATH = join(import.meta.dirname, '..', '..', '..', 'e2e', 'assets', 'silent.m4b');

const mswServer = setupServer(
  // Absorb fire-and-forget notifications under strict unhandled-request mode.
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
);

describe('Import flow E2E — real audio scanner', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  // Must match the content path hardcoded by qbGetTorrentHandler.
  const DOWNLOAD_FOLDER = 'Test Audiobook';

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-real-scan-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-real-scan-lib-'));

    const downloadSource = join(downloadParent, DOWNLOAD_FOLDER);
    await mkdir(downloadSource, { recursive: true });
    await copyFile(FIXTURE_PATH, join(downloadSource, 'silent.m4b'));

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
      minFreeSpaceGB: 0,
      redownloadFailed: true,
    });
  });

  afterEach(() => {
    mswServer.resetHandlers();
    e2e.services.downloadClient.clearAdapterCache();
  });

  afterAll(async () => {
    mswServer.close();
    await e2e.cleanup();
    await rm(downloadParent, { recursive: true, force: true });
    await rm(libraryDir, { recursive: true, force: true });
  });

  it('imports a real m4b fixture and populates scanner-derived audio fields on the book', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(
      e2e,
      downloadClientId,
      'Silent Fixture',
      'Test Author',
    );

    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    await e2e.services.import.importDownload(downloadId);

    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.statusCode).toBe(200);
    const book = bookRes.json();

    // Only a successful real scan sets file-enriched.
    expect(book.enrichmentStatus).toBe('file-enriched');

    // Parser versions expose several legitimate AAC spellings.
    expect(book.audioCodec).toMatch(/aac/i);

    expect(book.audioFileFormat).toBe('m4b');

    expect(book.audioFileCount).toBe(1);

    // Allow rounding and parser drift around the fixture's ten-second duration.
    expect(book.audioDuration).toBeGreaterThanOrEqual(9);
    expect(book.audioDuration).toBeLessThanOrEqual(11);
  });
});
