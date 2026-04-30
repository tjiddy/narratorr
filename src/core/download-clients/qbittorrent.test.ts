import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { QBittorrentClient } from './qbittorrent.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError } from './errors.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

const config = { host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false };
const BASE_URL = 'http://localhost:8080';

const mockTorrent = {
  hash: 'abc123',
  name: 'Test Torrent',
  state: 'downloading',
  progress: 0.5,
  total_size: 1000000,
  downloaded: 500000,
  uploaded: 100000,
  ratio: 0.2,
  num_seeds: 10,
  num_leechs: 5,
  eta: 3600,
  save_path: '/downloads',
  added_on: 1700000000,
  completion_on: 0,
};

function loginHandler() {
  return http.post(`${BASE_URL}/api/v2/auth/login`, () => {
    return new HttpResponse('Ok.', {
      headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
    });
  });
}

describe('QBittorrentClient', () => {
  const server = useMswServer();
  let client: QBittorrentClient;

  beforeEach(() => {
    client = new QBittorrentClient(config);
    // Set up default login handler for all tests
    server.use(loginHandler());
  });

  describe('login', () => {
    it('extracts SID cookie on successful login', async () => {
      // login is private, so we exercise it via test() which calls login()
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
    });

    it('throws on bad credentials (Fails. response)', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/auth/login`, () => {
          return new HttpResponse('Fails.', {
            headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
          });
        }),
      );

      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Login failed: Invalid credentials');
    });

    it('throws when no cookie received', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/auth/login`, () => {
          return new HttpResponse('');
        }),
      );

      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Login failed: No session cookie received');
    });

    it('throws DownloadClientError (not auth) on non-auth login HTTP failure', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/auth/login`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect(error).not.toBeInstanceOf(DownloadClientAuthError);
      expect((error as DownloadClientError).message).toContain('500');
    });
  });

  describe('request', () => {
    it('retries once on 403 (session expired)', async () => {
      let callCount = 0;

      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          callCount++;
          if (callCount === 1) {
            return new HttpResponse(null, { status: 403 });
          }
          return HttpResponse.json([mockTorrent]);
        }),
      );

      const result = await client.getAllDownloads();
      expect(result).toHaveLength(1);
      expect(callCount).toBe(2);
    });

    it('throws DownloadClientError with ZodError cause for non-JSON success response (e.g. Ok.)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('Ok.');
        }),
      );

      // After #743: non-JSON bodies must surface as a typed validation failure
      // at the boundary, not silently coerce to "no torrents".
      const err = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError for HTML response from proxy interception', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('<html><body>Authelia Login</body></html>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }),
      );

      const error = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('didn\'t respond as expected');
    });

    it('does not retry infinitely (throws DownloadClientAuthError after second 403)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(client.getAllDownloads()).rejects.toBeInstanceOf(DownloadClientAuthError);
    });
  });

  describe('addDownload', () => {
    it('returns infoHash from magnet-uri artifact', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: 'magnet:?xt=urn:btih:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0&dn=Test',
        infoHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      };
      const hash = await client.addDownload(artifact);
      expect(hash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    });

    it('succeeds when qBittorrent returns plain text Ok. response', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('Ok.');
        }),
      );

      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: 'magnet:?xt=urn:btih:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0&dn=Test',
        infoHash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      };
      const hash = await client.addDownload(artifact);
      expect(hash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    });

    describe('torrent-bytes upload', () => {
      const fakeTorrentFile = Buffer.from('d8:announce35:http://tracker.example.com/announce4:infod6:lengthi12345e4:name8:test.txte');

      it('uploads torrent bytes via multipart FormData, returns pre-extracted info hash', async () => {
        let capturedContentType = '';
        let bodyContainsTorrent = false;

        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, async ({ request }) => {
            capturedContentType = request.headers.get('content-type') || '';
            const text = await request.text();
            bodyContainsTorrent = text.includes('application/x-bittorrent');
            return new HttpResponse('');
          }),
        );

        const artifact: DownloadArtifact = {
          type: 'torrent-bytes',
          data: fakeTorrentFile,
          infoHash: 'e4c4ed54fbde46fb891a9ef51a368f7cde76eb74',
        };
        const hash = await client.addDownload(artifact);
        expect(capturedContentType).toContain('multipart/form-data');
        expect(bodyContainsTorrent).toBe(true);
        expect(hash).toBe('e4c4ed54fbde46fb891a9ef51a368f7cde76eb74');
      });

      it('forwards savePath, category, and paused options through torrent-bytes path', async () => {
        let capturedBody = '';

        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, async ({ request }) => {
            capturedBody = await request.text();
            return new HttpResponse('');
          }),
        );

        const artifact: DownloadArtifact = {
          type: 'torrent-bytes',
          data: fakeTorrentFile,
          infoHash: 'fakehash123',
        };
        await client.addDownload(artifact, {
          savePath: '/audiobooks',
          category: 'books',
          paused: true,
        });

        expect(capturedBody).toContain('savepath');
        expect(capturedBody).toContain('/audiobooks');
        expect(capturedBody).toContain('category');
        expect(capturedBody).toContain('books');
        expect(capturedBody).toContain('paused');
        expect(capturedBody).toContain('true');
      });
    });

    describe('torrent-bytes retry/auth', () => {
      const fakeTorrentFile = Buffer.from('d8:announce35:http://tracker.example.com/announce4:infod6:lengthi12345e4:name8:test.txte');
      const torrentArtifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: fakeTorrentFile,
        infoHash: 'e4c4ed54fbde46fb891a9ef51a368f7cde76eb74',
      };

      it('retries once on 403 (session expired) during torrent-bytes upload', async () => {
        let uploadCallCount = 0;
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            uploadCallCount++;
            if (uploadCallCount === 1) {
              return new HttpResponse(null, { status: 403 });
            }
            return new HttpResponse('');
          }),
        );

        const hash = await client.addDownload(torrentArtifact);
        expect(hash).toBe('e4c4ed54fbde46fb891a9ef51a368f7cde76eb74');
        expect(uploadCallCount).toBe(2);
      });

      it('throws DownloadClientAuthError after retry exhaustion on torrent-bytes upload', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 403 });
          }),
        );

        await expect(client.addDownload(torrentArtifact)).rejects.toBeInstanceOf(DownloadClientAuthError);
      });

      it('throws DownloadClientError on non-auth HTTP failure during torrent-bytes upload', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 500 });
          }),
        );

        const error = await client.addDownload(torrentArtifact).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadClientError);
        expect(error).not.toBeInstanceOf(DownloadClientAuthError);
      });

      it('throws DownloadClientTimeoutError on timeout during torrent-bytes upload', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, async () => {
            await delay('infinite');
            return new HttpResponse('');
          }),
        );

        const originalTimeout = AbortSignal.timeout;
        AbortSignal.timeout = () => AbortSignal.abort(new DOMException('The operation was aborted', 'TimeoutError'));

        await expect(client.addDownload(torrentArtifact)).rejects.toBeInstanceOf(DownloadClientTimeoutError);

        AbortSignal.timeout = originalTimeout;
      });
    });

    it('rejects nzb-url artifact with torrent-only error', async () => {
      await expect(
        client.addDownload({ type: 'nzb-url', url: 'https://indexer.test/nzb' }),
      ).rejects.toThrow('only supports torrent artifacts');
    });
  });

  describe('getDownload', () => {
    it('returns mapped torrent info', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([mockTorrent]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('abc123');
      expect(result!.name).toBe('Test Torrent');
      expect(result!.progress).toBe(50);
      expect(result!.status).toBe('downloading');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.size).toBe(1000000);
      expect(result!.downloaded).toBe(500000);
      expect(result!.uploaded).toBe(100000);
      expect(result!.ratio).toBe(0.2);
      expect(result!.seeders).toBe(10);
      expect(result!.leechers).toBe(5);
      expect(result!.eta).toBe(3600);
      expect(result!.addedAt).toEqual(new Date(1700000000 * 1000));
      expect(result!.completedAt).toBeUndefined();
    });

    it('returns null when no torrents found', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([]);
        }),
      );

      const result = await client.getDownload('nonexistent');
      expect(result).toBeNull();
    });

    it('throws on malformed torrent response', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ unexpected: 'shape' }]);
        }),
      );

      await expect(client.getDownload('abc123')).rejects.toThrow('unexpected torrent data');
    });

    it('maps dlspeed to downloadSpeed in bytes/sec', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, dlspeed: 1_048_576 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.downloadSpeed).toBe(1_048_576);
    });

    it('preserves dlspeed=0 (stalled) rather than coercing to undefined', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, dlspeed: 0 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.downloadSpeed).toBe(0);
    });

    it('leaves downloadSpeed undefined when dlspeed field is absent', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([mockTorrent]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.downloadSpeed).toBeUndefined();
    });
  });

  describe('getAllDownloads', () => {
    it('returns all mapped torrents', async () => {
      const secondTorrent = { ...mockTorrent, hash: 'def456', name: 'Second Torrent' };

      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([mockTorrent, secondTorrent]);
        }),
      );

      const results = await client.getAllDownloads();
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('abc123');
      expect(results[1].id).toBe('def456');
    });

    it('passes category as query parameter', async () => {
      let capturedUrl = '';

      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json([mockTorrent]);
        }),
      );

      await client.getAllDownloads('audiobooks');
      expect(capturedUrl).toContain('category=audiobooks');
    });
  });

  describe('pauseDownload', () => {
    it('sends pause request', async () => {
      let called = false;

      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/pause`, () => {
          called = true;
          return new HttpResponse('');
        }),
      );

      await client.pauseDownload('abc123');
      expect(called).toBe(true);
    });
  });

  describe('resumeDownload', () => {
    it('sends resume request', async () => {
      let called = false;

      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/resume`, () => {
          called = true;
          return new HttpResponse('');
        }),
      );

      await client.resumeDownload('abc123');
      expect(called).toBe(true);
    });
  });

  describe('removeDownload', () => {
    it('sends delete request', async () => {
      let called = false;

      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/delete`, () => {
          called = true;
          return new HttpResponse('');
        }),
      );

      await client.removeDownload('abc123');
      expect(called).toBe(true);
    });
  });

  describe('mapState', () => {
    it('maps stalledDL to downloading', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'stalledDL' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });

    it('maps pausedDL to paused', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'pausedDL' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('paused');
    });

    it('maps uploading to seeding', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'uploading' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('maps stalledUP to seeding', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'stalledUP' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('maps pausedUP to seeding', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'pausedUP' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('maps error to error', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'error' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('error');
    });

    it('maps missingFiles to error', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'missingFiles' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('error');
    });

    it('maps stoppedDL to paused', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'stoppedDL' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('paused');
    });

    it('maps stoppedUP to seeding', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'stoppedUP' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('maps forcedMetaDL to downloading', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'forcedMetaDL' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });

    it('maps checkingUP to downloading (not seeding — integrity unconfirmed)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'checkingUP' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });

    it('maps unknown state to downloading (fallback)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, state: 'someNewState' }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });
  });

  describe('test', () => {
    it('returns success with version string', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('qBittorrent v4.6.0');
    });

    it('returns failure on error', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/auth/login`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    });

    it('returns failure when server returns HTML instead of JSON', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('<!doctype html><html><body>Welcome</body></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('didn\'t respond as expected');
    });

    it('sends session cookie and Referer header on version fetch', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, ({ request }) => {
          const cookie = request.headers.get('cookie');
          const referer = request.headers.get('referer');
          if (!cookie?.includes('SID=') || referer !== BASE_URL) {
            return new HttpResponse(null, { status: 403 });
          }
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('qBittorrent v4.6.0');
    });

    it('returns failure when version endpoint returns non-2xx status', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('404');
    });
  });

  describe('getCategories', () => {
    it('returns category names from API response', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return HttpResponse.json({
            audiobooks: { name: 'audiobooks', savePath: '/downloads/audiobooks' },
            music: { name: 'music', savePath: '/downloads/music' },
          });
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks', 'music']);
    });

    it('returns empty array when no categories exist', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return HttpResponse.json({});
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('throws DownloadClientError with ZodError cause when API returns empty body', async () => {
      // Behavior change from #743: an empty body is a boundary failure, not
      // a graceful empty category list.
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse('', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const err = await client.getCategories().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientAuthError on auth failure (403 after retry)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(client.getCategories()).rejects.toBeInstanceOf(DownloadClientAuthError);
    });

    it('throws DownloadClientError on network error', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(client.getCategories()).rejects.toBeInstanceOf(DownloadClientError);
    });

    it('throws DownloadClientError on malformed response (HTML instead of JSON)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse('<html>Not JSON</html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const error = await client.getCategories().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('didn\'t respond as expected');
    });

    it('throws DownloadClientError with ZodError cause when categories is a string instead of object', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => HttpResponse.json('not-an-object')),
      );

      const err = await client.getCategories().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('passes through unknown extra fields in category entries and still maps successfully', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => HttpResponse.json({
          audiobooks: { name: 'audiobooks', savePath: '/x', futureField: 'unknown' },
        })),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks']);
    });

    it('throws DownloadClientTimeoutError on request timeout', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, async () => {
          await delay('infinite');
          return HttpResponse.json({});
        }),
      );

      const originalTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException('The operation was aborted', 'TimeoutError'));

      await expect(client.getCategories()).rejects.toBeInstanceOf(DownloadClientTimeoutError);

      AbortSignal.timeout = originalTimeout;
    });

    it('has supportsCategories = true', () => {
      expect(client.supportsCategories).toBe(true);
    });
  });

  describe('content_path derivation', () => {
    it('uses content_path dirname/basename for savePath/name when content_path is present', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'The Devils -  Joe Abercrombie',
            save_path: '/downloads',
            content_path: '/downloads/Joe Abercrombie - The Devils',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('Joe Abercrombie - The Devils');
    });

    it('falls back to save_path/name when content_path is undefined', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'My Torrent',
            save_path: '/downloads',
            // no content_path
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('My Torrent');
    });

    it('falls back to save_path/name when content_path is empty string', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'My Torrent',
            save_path: '/downloads',
            content_path: '',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('My Torrent');
    });

    it('handles single-file torrent content_path', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'book.m4b',
            save_path: '/downloads',
            content_path: '/downloads/book.m4b',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('book.m4b');
    });

    it('handles nested subdirectory content_path', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'Author - Title',
            save_path: '/downloads',
            content_path: '/downloads/category/Author - Title',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads/category');
      expect(result!.name).toBe('Author - Title');
    });

    it('handles content_path with trailing slash without producing empty name', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'folder',
            save_path: '/downloads',
            content_path: '/downloads/folder/',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('folder');
    });

    it('content_path matching join(save_path, name) produces same result as fallback', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            name: 'Test Torrent',
            save_path: '/downloads',
            content_path: '/downloads/Test Torrent',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.savePath).toBe('/downloads');
      expect(result!.name).toBe('Test Torrent');
    });

    it('getAllDownloads — mixed batch with some items having content_path and some without', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([
            {
              ...mockTorrent,
              hash: 'aaa',
              name: 'Wrong Name',
              save_path: '/downloads',
              content_path: '/downloads/Correct Name',
            },
            {
              ...mockTorrent,
              hash: 'bbb',
              name: 'Fallback Name',
              save_path: '/other',
              // no content_path
            },
          ]);
        }),
      );

      const results = await client.getAllDownloads();
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Correct Name');
      expect(results[0].savePath).toBe('/downloads');
      expect(results[1].name).toBe('Fallback Name');
      expect(results[1].savePath).toBe('/other');
    });
  });

  describe('edge cases — boundary values and malformed data', () => {
    it('handles ETA at boundary value 8640000 (excluded)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, eta: 8640000 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.eta).toBeUndefined();
    });

    it('handles ETA just below boundary (included)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, eta: 8639999 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.eta).toBe(8639999);
    });

    it('handles negative ETA', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, eta: -1 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.eta).toBeUndefined();
    });

    it('handles whitespace-only response body with HTML content-type as DownloadClientError', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('   ', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const error = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('didn\'t respond as expected');
    });

    it('throws DownloadClientError with ZodError cause for whitespace-only body (non-JSON, non-HTML)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('   ', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const err = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError with ZodError cause for empty body in getAllDownloads', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const err = await client.getAllDownloads().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('handles completion_on = 0 as not completed', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, completion_on: 0 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.completedAt).toBeUndefined();
    });

    it('maps completion_on > 0 to completedAt date', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, completion_on: 1700003600 }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.completedAt).toEqual(new Date(1700003600 * 1000));
    });
  });

  describe('content_path containment validation', () => {
    it('returns seeding when content_path is descendant of save_path', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            state: 'uploading',
            save_path: '/downloads/complete',
            content_path: '/downloads/complete/My Audiobook',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('returns downloading when content_path is NOT within save_path (incomplete dir)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            state: 'uploading',
            save_path: '/downloads/complete',
            content_path: '/downloads/incomplete/My Audiobook',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });

    it('returns seeding when content_path is missing/undefined', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          const torrent = { ...mockTorrent, state: 'uploading' };
          // No content_path field
          return HttpResponse.json([torrent]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });

    it('returns downloading for near-miss path prefix (save_path=/downloads, content_path=/downloads2/file)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            state: 'uploading',
            save_path: '/downloads',
            content_path: '/downloads2/My Audiobook',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
    });

    it('normalizes content_path trailing slash before comparison', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{
            ...mockTorrent,
            state: 'uploading',
            save_path: '/downloads/complete',
            content_path: '/downloads/complete/My Audiobook/',
          }]);
        }),
      );

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });
  });

  describe('schema validation', () => {
    it('throws DownloadClientError with ZodError cause when response is not an array', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => HttpResponse.json({ not: 'an array' })),
      );

      const err = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('getAllDownloads throws DownloadClientError with ZodError cause for malformed response', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => HttpResponse.json({ broken: true })),
      );

      const err = await client.getAllDownloads().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('passes through extra unknown fields and still maps successfully', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => HttpResponse.json([
          { ...mockTorrent, futureField: 'unknown', anotherNew: 42 },
        ])),
      );

      const result = await client.getDownload('abc123');
      expect(result?.id).toBe('abc123');
    });
  });
});
