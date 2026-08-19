import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { join } from 'node:path';
import { mkdtemp, mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { downloads } from '@db/schema.js';
import { createE2EApp, seedBookAndDownload, type E2EApp } from './e2e-helpers.js';
import {
  WEBHOOK_URL,
  TORRENT_HASH,
  qbLoginHandler,
  qbGetTorrentHandler,
} from './msw-handlers.js';

/**
 * #2495 end-to-end: ABB serves audiobooks as bare `.mp4`, which is the same AAC-in-MP4 container
 * `.m4b` uses — so the tracked `silent.m4b` fixture copied under a `.mp4` name IS the real thing,
 * byte for byte. Prod download 439 dead-ended in Pending Review because the registry did not list
 * the extension; this drives the recovery path an operator actually takes (Approve a held
 * download) and asserts the file reaches the library with its extension intact, since
 * rename-to-`.m4b` was deliberately not adopted.
 */

const FIXTURE_PATH = join(import.meta.dirname, '..', '..', '..', 'e2e', 'assets', 'silent.m4b');

const mswServer = setupServer(
  http.post(WEBHOOK_URL, () => new HttpResponse(null, { status: 200 })),
);

describe('Import flow E2E — a bare .mp4 rescued from Pending Review (#2495)', () => {
  let e2e: E2EApp;
  let downloadParent: string;
  let libraryDir: string;
  let downloadClientId: number;

  // Must match the content path hardcoded by qbGetTorrentHandler.
  const DOWNLOAD_FOLDER = 'Test Audiobook';

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: 'error' });
    e2e = await createE2EApp();

    downloadParent = await mkdtemp(join(tmpdir(), 'narratorr-2495-dl-'));
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-2495-lib-'));

    const downloadSource = join(downloadParent, DOWNLOAD_FOLDER);
    await mkdir(downloadSource, { recursive: true });
    await copyFile(FIXTURE_PATH, join(downloadSource, 'FortuneFunhouseMissFortuneMysteriesBook19.mp4'));

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

  it('approves the held download, imports the .mp4, and lands it in the library with its extension intact', async () => {
    const { bookId, downloadId } = await seedBookAndDownload(
      e2e,
      downloadClientId,
      'Fortune Funhouse',
      'Miss Fortune',
    );
    // The dead-end state prod download 439 was stuck in.
    await e2e.db.update(downloads).set({ pipelineStage: 'pending_review' }).where(eq(downloads.id, downloadId));

    mswServer.use(
      qbLoginHandler(),
      qbGetTorrentHandler(TORRENT_HASH, downloadParent),
    );

    const approveRes = await e2e.app.inject({ method: 'POST', url: `/api/activity/${downloadId}/approve` });
    expect(approveRes.statusCode).toBe(200);

    await e2e.services.import.importDownload(downloadId);

    const [download] = await e2e.db.select().from(downloads).where(eq(downloads.id, downloadId));
    expect(download!.pipelineStage).not.toBe('pending_review');

    const bookRes = await e2e.app.inject({ method: 'GET', url: `/api/books/${bookId}` });
    expect(bookRes.statusCode).toBe(200);
    const book = bookRes.json();

    // Only a successful real scan of the .mp4 sets file-enriched — import alone absorbs failures.
    expect(book.enrichmentStatus).toBe('file-enriched');
    expect(book.audioCodec).toMatch(/aac/i);
    expect(book.audioFileFormat).toBe('mp4');
    expect(book.audioFileCount).toBe(1);

    // Paths persist POSIX-normalized; the library root is an OS-native tmpdir.
    expect(book.path.split('\\').join('/')).toBe(
      join(libraryDir, 'Miss Fortune', 'Fortune Funhouse').split('\\').join('/'),
    );

    // Rename-to-.m4b was declined: what ABB served is what the library holds.
    const landed = await readdir(book.path);
    expect(landed.filter(name => name.endsWith('.mp4'))).toHaveLength(1);
    expect(landed.some(name => name.endsWith('.m4b'))).toBe(false);
  });
});
