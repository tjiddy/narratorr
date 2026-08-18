import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { QBittorrentClient } from '@core/download-clients/qbittorrent.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { DownloadClientService } from '../services/download-client.service.js';
import type { NotifierService } from '../services/notifier.service.js';
import { monitorDownloads } from './monitor.js';

/**
 * #2423 — a monitor test that injects a fake adapter only exercises the branch where the adapter
 * ALREADY resolved the torrent. The defect lived in the branch where the real qBittorrent adapter
 * has to resolve a v2-rekeyed hybrid itself, so this cycle drives the real client over MSW.
 */
describe('#2423 monitor over the real QBittorrentClient', () => {
  const server = useMswServer();
  const BASE_URL = 'http://localhost:8080';

  const V1 = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
  const CANONICAL = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';

  /** qBittorrent's payload for the grabbed torrent after libtorrent re-keys it to its v2 hash. */
  const hybridTorrent = {
    hash: CANONICAL,
    infohash_v1: V1,
    infohash_v2: `${CANONICAL}112233445566778899aabbcc`,
    name: 'Hybrid Audiobook',
    state: 'downloading',
    progress: 0.25,
    total_size: 1_000_000,
    downloaded: 250_000,
    uploaded: 0,
    ratio: 0,
    num_seeds: 4,
    num_leechs: 1,
    eta: 600,
    save_path: '/downloads',
    added_on: 1_700_000_000,
    completion_on: 0,
  };

  const FROZEN_NOW = new Date('2026-08-17T23:09:30.000Z');

  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let notifierService: { notify: Mock };
  let updateChain: ReturnType<typeof mockDbChain>;
  let client: QBittorrentClient;

  // seedRow and monitorDownloads both read Date.now(); freeze it so the genuine-absence control is
  // outside grace by construction. Fake ONLY Date — full fake timers stall MSW and the native
  // AbortSignal.timeout inside fetchWithTimeout that the real adapter's requests depend on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
    db = createMockDb();
    log = createMockLogger();
    notifierService = { notify: vi.fn().mockResolvedValue(undefined) };
    updateChain = mockDbChain([{ id: 1 }]);
    db.update.mockReturnValue(updateChain);
    client = buildClient();

    server.use(
      http.post(`${BASE_URL}/api/v2/auth/login`, () => new HttpResponse('Ok.', {
        headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The row stores the grabbed v1 hash and is well outside the grace window (#2423 Part B). */
  function seedRow() {
    db.select.mockReturnValueOnce(mockDbChain([{
      id: 1, externalId: V1, downloadClientId: 10,
      clientStatus: 'downloading', pipelineStage: 'idle',
      bookId: null, title: 'Hybrid Audiobook', infoHash: V1, guid: null,
      completedAt: null, progress: 0, outputPath: null,
      addedAt: new Date(Date.now() - 10 * 60_000),
    }]));
  }

  function buildClient(category?: string) {
    return new QBittorrentClient({
      host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false,
      ...(category ? { category } : {}),
    });
  }

  /**
   * ONE adapter instance across cycles, mirroring the per-clientId cache in
   * DownloadClientService.getAdapter — that lifetime is what makes the #2433 memo survive polls.
   */
  async function runCycle() {
    await monitorDownloads(
      inject<Db>(db),
      inject<DownloadClientService>({ getAdapter: vi.fn().mockResolvedValue(client) }),
      inject<NotifierService>(notifierService),
      inject<FastifyBaseLogger>(log),
    );
  }

  function writtenPayloads() {
    return (updateChain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
  }

  it('records progress for a hybrid the client has re-keyed to its v2 hash', async () => {
    seedRow();
    server.use(
      http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => HttpResponse.json(
        new URL(request.url).searchParams.has('hashes') ? [] : [hybridTorrent],
      )),
    );

    await runCycle();

    expect(writtenPayloads()).toContainEqual(
      expect.objectContaining({ clientStatus: 'downloading', progress: 0.25 }),
    );
    expect(writtenPayloads().some((p) => p.clientStatus === 'failed')).toBe(false);
    expect(log.warn).not.toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    expect(notifierService.notify).not.toHaveBeenCalled();
  });

  // Without this the assertion above passes just as well against "the monitor never fails anything".
  it('control: still fails the row when the client genuinely holds no matching torrent', async () => {
    seedRow();
    const info = trackInfo(() => HttpResponse.json([]));

    await runCycle();

    expect(writtenPayloads()).toContainEqual(
      expect.objectContaining({ clientStatus: 'failed', errorMessage: 'Download not found in download client' }),
    );
    expect(log.warn).toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
    // #2433 — absence stays observable under the new request shape: with no category configured the
    // scan is already unscoped, so a genuine absence still costs exactly two requests.
    expect(info.urls).toHaveLength(2);
  });

  function trackInfo(respond: (params: URLSearchParams) => Response) {
    const urls: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => {
        urls.push(request.url);
        return respond(new URL(request.url).searchParams);
      }),
    );
    return { urls, params: (index: number) => new URL(urls[index]!).searchParams };
  }

  /**
   * #2433 — every 30s poll re-paid the full fallback scan for the life of a hybrid download, and
   * unscoped that is the entire /torrents/info payload per hybrid per cycle.
   */
  describe('the canonical-hash memo across polls', () => {
    it('re-resolves a hybrid in one request on the second cycle, persisting nothing', async () => {
      const info = trackInfo((params) => HttpResponse.json(
        params.has('hashes')
          ? (params.get('hashes') === CANONICAL ? [hybridTorrent] : [])
          : [hybridTorrent],
      ));

      seedRow();
      await runCycle();
      expect(info.urls).toHaveLength(2);

      seedRow();
      await runCycle();

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
      expect(writtenPayloads().filter((p) => p.clientStatus === 'downloading')).toHaveLength(2);
      expect(writtenPayloads().some((p) => p.clientStatus === 'failed')).toBe(false);
      expect(log.warn).not.toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
      // A11 — the memo is transient state; the row's identity is never rewritten.
      expect(writtenPayloads().every((p) => !('externalId' in p))).toBe(true);
    });

    it('does not false-fail a hybrid sitting under a category other than the configured one', async () => {
      client = buildClient('audiobooks');
      seedRow();
      const info = trackInfo((params) => HttpResponse.json(
        params.has('hashes') || params.has('category') ? [] : [hybridTorrent],
      ));

      await runCycle();

      expect(info.urls).toHaveLength(3);
      expect(writtenPayloads()).toContainEqual(
        expect.objectContaining({ clientStatus: 'downloading', progress: 0.25 }),
      );
      expect(writtenPayloads().some((p) => p.clientStatus === 'failed')).toBe(false);
      expect(log.warn).not.toHaveBeenCalledWith({ id: 1 }, 'Download not found in client');
      expect(notifierService.notify).not.toHaveBeenCalled();
    });
  });
});
