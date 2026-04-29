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
 * Fixture-backed e2e test for the import → enrich pipeline.
 *
 * This file deliberately does NOT mock `scanAudioDirectory` — it copies the
 * tracked `e2e/assets/silent.m4b` fixture into a temp download path and
 * exercises the real music-metadata parser end-to-end. ImportService.
 * enrichAfterImport (`src/server/services/import.service.ts:183-191`)
 * silently absorbs enrichment failures and continues, so a passing import
 * alone does not prove the scanner ran. We therefore assert
 * scanner-derived book fields (codec, fileFormat, fileCount, duration,
 * enrichmentStatus) directly to prove real metadata reached the DB.
 *
 * The sibling `import-flow.e2e.test.ts` keeps its mocked scanner for speed;
 * this is the one fixture-backed integration case.
 */

const FIXTURE_PATH = join(import.meta.dirname, '..', '..', '..', 'e2e', 'assets', 'silent.m4b');

const mswServer = setupServer(
  // Default webhook sink — present so onUnhandledRequest:'error' never fires
  // for fire-and-forget notifications during the import flow.
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
);

describe('Import flow E2E — real audio scanner', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  // The shared qbGetTorrentHandler hardcodes content_path as `${savePath}/Test Audiobook`,
  // so the download folder name must match.
  const DOWNLOAD_FOLDER = 'Test Audiobook';

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-real-scan-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-real-scan-lib-'));

    // Copy the tracked fixture into the simulated download folder.
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

    // Real scanner ran — enrichmentStatus only flips to 'file-enriched' inside
    // enrichBookFromAudio when scanAudioDirectory returns non-null with codec.
    expect(book.enrichmentStatus).toBe('file-enriched');

    // music-metadata stores `metadata.format.codec` raw — spellings like
    // 'AAC', 'AAC LC', or 'MPEG-4/AAC' are all legitimate for an AAC fixture.
    // Match case-insensitively so a parser-version bump doesn't break us.
    expect(book.audioCodec).toMatch(/aac/i);

    // Deterministic — derived from extname(filePath).slice(1).toLowerCase()
    // at src/core/utils/audio-scanner.ts:172.
    expect(book.audioFileFormat).toBe('m4b');

    // Single-file fixture.
    expect(book.audioFileCount).toBe(1);

    // Documented 10-second length; allow ±1s for Math.round and parser drift.
    expect(book.audioDuration).toBeGreaterThanOrEqual(9);
    expect(book.audioDuration).toBeLessThanOrEqual(11);
  });
});
