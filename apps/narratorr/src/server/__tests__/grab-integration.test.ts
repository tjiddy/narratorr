import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createMockDb, createMockLogger, mockDbChain } from './helpers.js';
import { DownloadService } from '../services/download.service.js';
import { DownloadClientService } from '../services/download-client.service.js';

const QB_BASE = 'http://localhost:8080';
const MAGNET_HASH = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
const MAGNET_URI = `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=Test+Audiobook`;

const mockClientRow = {
  id: 1,
  name: 'qBittorrent',
  type: 'qbittorrent' as const,
  enabled: true,
  priority: 50,
  settings: { host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false },
  createdAt: new Date(),
};

function loginHandler() {
  return http.post(`${QB_BASE}/api/v2/auth/login`, () => {
    return new HttpResponse('Ok.', {
      headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
    });
  });
}

function addTorrentHandler() {
  return http.post(`${QB_BASE}/api/v2/torrents/add`, () => {
    return new HttpResponse('');
  });
}

function addTorrent500Handler() {
  return http.post(`${QB_BASE}/api/v2/torrents/add`, () => {
    return new HttpResponse('Internal Server Error', { status: 500 });
  });
}

const mswServer = setupServer();

describe('Grab flow integration', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let clientService: DownloadClientService;
  let downloadService: DownloadService;

  beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => mswServer.resetHandlers());
  afterAll(() => mswServer.close());

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();

    // DB returns the qbittorrent client for all select queries (getFirstEnabledForProtocol + getById)
    db.select.mockReturnValue(mockDbChain([mockClientRow]));

    clientService = new DownloadClientService(db as any, log as any);
    downloadService = new DownloadService(db as any, clientService, log as any);
  });

  it('grabs a magnet URI, extracts the correct hash, and calls the adapter via MSW', async () => {
    mswServer.use(loginHandler(), addTorrentHandler());

    // insert returns download record, then select returns download+book for getById
    db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
    const downloadRecord = {
      id: 1,
      bookId: null,
      indexerId: null,
      downloadClientId: 1,
      title: 'Test Audiobook',
      protocol: 'torrent',
      infoHash: MAGNET_HASH,
      downloadUrl: MAGNET_URI,
      size: null,
      seeders: null,
      status: 'downloading',
      progress: 0,
      externalId: MAGNET_HASH,
      errorMessage: null,
      addedAt: new Date(),
      completedAt: null,
    };
    // After insert, getById is called — need to set select to return the download+book join
    // The first select call is for getFirstEnabledForProtocol, second for getById in clientService,
    // third for getById in downloadService. Use mockReturnValue to handle all.
    db.select
      .mockReturnValueOnce(mockDbChain([mockClientRow]))   // getFirstEnabledForProtocol
      .mockReturnValueOnce(mockDbChain([mockClientRow]))   // getAdapter → getById
      .mockReturnValueOnce(mockDbChain([{ download: downloadRecord, book: null }])); // getById after insert

    const result = await downloadService.grab({
      downloadUrl: MAGNET_URI,
      title: 'Test Audiobook',
    });

    expect(result.infoHash).toBe(MAGNET_HASH);
    expect(result.status).toBe('downloading');
    expect(db.insert).toHaveBeenCalled();
  });

  it('throws when qBittorrent returns 500', async () => {
    mswServer.use(loginHandler(), addTorrent500Handler());

    db.select
      .mockReturnValueOnce(mockDbChain([mockClientRow]))   // getFirstEnabledForProtocol
      .mockReturnValueOnce(mockDbChain([mockClientRow]));   // getAdapter → getById

    await expect(
      downloadService.grab({
        downloadUrl: MAGNET_URI,
        title: 'Test Audiobook',
      }),
    ).rejects.toThrow(/Request failed/);
  });
});
