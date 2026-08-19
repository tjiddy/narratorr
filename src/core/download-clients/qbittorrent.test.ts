import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { servesFullList } from '../__tests__/qb-hash-filter.js';
import { QBittorrentClient } from './qbittorrent.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError } from './errors.js';

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
    server.use(loginHandler());
  });

  /**
   * MSW matches on path only, so the fast-path (`?hashes=`) and fallback (list) requests both land
   * on ONE handler — discriminate inside the resolver. A handler that ignores `hashes` makes the
   * fallback unreachable and every hybrid assertion below vacuous.
   */
  function trackInfoRequests(respond: (params: URLSearchParams) => Response) {
    const urls: string[] = [];
    server.use(
      http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => {
        urls.push(request.url);
        return respond(new URL(request.url).searchParams);
      }),
    );
    return {
      urls,
      params: (index: number) => new URL(urls[index]!).searchParams,
    };
  }

  /**
   * A real `?hashes=<id>` filter answers `onFastPath`; anything qBittorrent would serve unfiltered
   * — absent, empty, or pipe-only `hashes` — answers `onFallback` (#2485 AC7).
   */
  function byHashes(onFastPath: unknown[], onFallback: unknown[]) {
    return (params: URLSearchParams) => HttpResponse.json(servesFullList(params) ? onFallback : onFastPath);
  }

  function trackControlPosts(action: string) {
    const bodies: string[] = [];
    server.use(
      http.post(`${BASE_URL}/api/v2/torrents/${action}`, async ({ request }) => {
        bodies.push(await request.text());
        return new HttpResponse('');
      }),
    );
    return bodies;
  }

  describe('login', () => {
    it('extracts SID cookie on successful login', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/app/version`, () => {
          return new HttpResponse('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
    });

    it('accepts qBittorrent 5.x port-scoped session cookie names', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/auth/login`, () => {
          return new HttpResponse(null, {
            status: 204,
            headers: { 'Set-Cookie': 'QBT_SID_8080=test-session-id; HttpOnly; SameSite=Strict; path=/' },
          });
        }),
        http.get(`${BASE_URL}/api/v2/app/version`, ({ request }) => {
          expect(request.headers.get('Cookie')).toContain('QBT_SID_8080=test-session-id');
          return new HttpResponse('v5.2.0');
        }),
      );

      const result = await client.test();
      expect(result).toEqual({ success: true, message: 'qBittorrent v5.2.0' });
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

    describe('duplicate-add adoption (HTTP 409)', () => {
      const dupInfoHash = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
      const magnetArtifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: `magnet:?xt=urn:btih:${dupInfoHash}&dn=Test`,
        infoHash: dupInfoHash,
      };
      const fakeTorrentFile = Buffer.from('d8:announce35:http://tracker.example.com/announce4:infod6:lengthi12345e4:name8:test.txte');
      const fileArtifact: DownloadArtifact = {
        type: 'torrent-bytes',
        data: fakeTorrentFile,
        infoHash: dupInfoHash,
      };

      it('magnet path: adopts existing torrent on 409 when present', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 409 });
          }),
          http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
            return HttpResponse.json([{ ...mockTorrent, hash: dupInfoHash }]);
          }),
        );

        const hash = await client.addDownload(magnetArtifact);
        expect(hash).toBe(dupInfoHash);
      });

      it('torrent-bytes path: adopts existing torrent on 409 when present', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 409 });
          }),
          http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
            return HttpResponse.json([{ ...mockTorrent, hash: dupInfoHash }]);
          }),
        );

        const hash = await client.addDownload(fileArtifact);
        expect(hash).toBe(dupInfoHash);
      });

      it('magnet path: rethrows original 409 when torrent absent (race/removed)', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 409 });
          }),
          http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
            return HttpResponse.json([]);
          }),
        );

        const error = await client.addDownload(magnetArtifact).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toContain('409');
      });

      it('torrent-bytes path: rethrows original 409 when torrent absent (race/removed)', async () => {
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 409 });
          }),
          http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
            return HttpResponse.json([]);
          }),
        );

        const error = await client.addDownload(fileArtifact).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toContain('409');
      });

      it('magnet path: does NOT adopt on non-409 failure (e.g. 400)', async () => {
        let infoCalled = false;
        server.use(
          http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
            return new HttpResponse(null, { status: 400 });
          }),
          http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
            infoCalled = true;
            return HttpResponse.json([{ ...mockTorrent, hash: dupInfoHash }]);
          }),
        );

        const error = await client.addDownload(magnetArtifact).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toContain('400');
        expect(infoCalled).toBe(false);
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

    it('parses null nullable fields and maps them identically to omitting them', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([
            { ...mockTorrent, dlspeed: null, content_path: null },
          ]);
        }),
      );

      const withNulls = await client.getDownload('abc123');

      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([mockTorrent]);
        }),
      );
      const omitted = await client.getDownload('abc123');

      expect(withNulls).toEqual(omitted);
    });

    it('coalesces dlspeed:null to undefined without clobbering a real 0', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return HttpResponse.json([{ ...mockTorrent, dlspeed: null }]);
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
      expect(results[0]!.id).toBe('abc123');
      expect(results[1]!.id).toBe('def456');
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

    // #2433 C5 — one category home: an omitted argument scopes to the configured category.
    describe('category defaulting (#2433)', () => {
      function captureUrl() {
        const urls: string[] = [];
        server.use(
          http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => {
            urls.push(request.url);
            return HttpResponse.json([mockTorrent]);
          }),
        );
        return urls;
      }

      it('defaults the scope to the configured category', async () => {
        const urls = captureUrl();

        await new QBittorrentClient({ ...config, category: 'audiobooks' }).getAllDownloads();

        expect(new URL(urls[0]!).searchParams.get('category')).toBe('audiobooks');
      });

      it('lets an explicit category win over the configured one', async () => {
        const urls = captureUrl();

        await new QBittorrentClient({ ...config, category: 'audiobooks' }).getAllDownloads('other');

        expect(new URL(urls[0]!).searchParams.get('category')).toBe('other');
      });

      it('treats an explicit empty category as unscoped', async () => {
        const urls = captureUrl();

        await new QBittorrentClient({ ...config, category: 'audiobooks' }).getAllDownloads('');

        expect(new URL(urls[0]!).searchParams.has('category')).toBe(false);
      });
    });
  });

  // Controls resolve the caller hash to the client's canonical one (#2423 AC5), so each of these
  // needs a torrents/info handler. Here nothing resolves, which pins the caller-hash fallback.
  describe('pauseDownload', () => {
    it('sends pause request with the caller hash when nothing resolves', async () => {
      const bodies = trackControlPosts('pause');
      trackInfoRequests(() => HttpResponse.json([]));

      await client.pauseDownload('abc123');
      expect(bodies).toHaveLength(1);
      expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe('abc123');
    });
  });

  describe('resumeDownload', () => {
    it('sends resume request with the caller hash when nothing resolves', async () => {
      const bodies = trackControlPosts('resume');
      trackInfoRequests(() => HttpResponse.json([]));

      await client.resumeDownload('abc123');
      expect(bodies).toHaveLength(1);
      expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe('abc123');
    });
  });

  describe('removeDownload', () => {
    it('sends delete request with the caller hash when nothing resolves', async () => {
      const bodies = trackControlPosts('delete');
      trackInfoRequests(() => HttpResponse.json([]));

      await client.removeDownload('abc123');
      expect(bodies).toHaveLength(1);
      expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe('abc123');
      expect(new URLSearchParams(bodies[0]!).get('deleteFiles')).toBe('false');
    });
  });

  /**
   * #2485 — `memoKey('')` already refused to key the memo, but `resolveTorrent` still probed
   * `?hashes=` with the RAW blank hash. Real qBittorrent drops empty parts from that filter and
   * answers the full list, so the unchecked `probed[0]` adoption — deliberate for memo hits
   * (#2433 A4) — handed back an arbitrary torrent, and `removeDownload('', true)` deleted its
   * files. The doubles here serve the full list on an ineffective filter, like the real client.
   */
  describe('blank-hash refusal (#2485)', () => {
    const V1 = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
    const CANONICAL = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';

    const hybrid = {
      ...mockTorrent,
      hash: CANONICAL,
      infohash_v1: V1,
      infohash_v2: `${CANONICAL}112233445566778899aabbcc`,
      name: 'Hybrid Torrent',
    };

    const BLANKS = [
      ['empty', ''],
      ['spaces', '   '],
      ['tab', '\t'],
      ['newline', '\n '],
      ['mixed whitespace', ' \t\n '],
    ] as const;

    /** Any unfiltered list carries a torrent, so a probing implementation has something to adopt. */
    function serveFullList() {
      return trackInfoRequests((params) => HttpResponse.json(servesFullList(params) ? [hybrid] : []));
    }

    it('returns null rather than adopting the first torrent the unfiltered list carries', async () => {
      const info = serveFullList();

      expect(await client.getDownload('')).toBeNull();
      expect(info.urls).toEqual([]);
    });

    /**
     * The request COUNT is the observable, not the param value: the URL parser strips raw trailing
     * whitespace before `searchParams` sees it, so a `?hashes=   ` probe reads back as `?hashes=`
     * and cannot be told apart from a correct refusal by inspecting the query.
     */
    it.each(BLANKS)('issues zero requests for a %s hash', async (_label, blank) => {
      const info = serveFullList();

      expect(await client.getDownload(blank)).toBeNull();

      expect(info.urls).toEqual([]);
    });

    // A refusal must be free every time, not memoized or otherwise stateful.
    it('stays free on repeated blank calls', async () => {
      const info = serveFullList();

      expect(await client.getDownload('   ')).toBeNull();
      expect(await client.getDownload('   ')).toBeNull();

      expect(info.urls).toEqual([]);
    });

    /**
     * The boundary that separates "blank" from "unresolvable": a guard written as "looks like a
     * 40-char hex hash" would over-reject here. Format validation is deliberately not part of this.
     */
    it('takes the normal probe-then-scan path for non-blank garbage', async () => {
      const info = serveFullList();

      expect(await client.getDownload('a')).toBeNull();

      expect(info.urls).toHaveLength(2);
      expect(info.params(0).get('hashes')).toBe('a');
      expect(info.params(1).has('hashes')).toBe(false);
    });

    // AC5 — the probe keys off the trimmed/lowercased form the memo already used.
    it('resolves a padded hash exactly like its trimmed form, probing the trimmed value', async () => {
      const info = trackInfoRequests((params) => HttpResponse.json(
        params.get('hashes') === V1 ? [hybrid] : [],
      ));

      expect((await client.getDownload(`  ${V1}  `))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(1);
      expect(info.params(0).get('hashes')).toBe(V1);
    });

    describe('controls refuse and never POST', () => {
      it.each([
        ['pauseDownload', 'pause'],
        ['resumeDownload', 'resume'],
      ] as const)('%s throws a typed error on a blank hash', async (method, action) => {
        const bodies = trackControlPosts(action);
        const info = serveFullList();

        await expect(client[method]('   ')).rejects.toThrow(DownloadClientError);

        expect(bodies).toEqual([]);
        expect(info.urls).toEqual([]);
      });

      it.each(BLANKS)('removeDownload(%s, true) throws and deletes nothing', async (_label, blank) => {
        const bodies = trackControlPosts('delete');
        const info = serveFullList();

        await expect(client.removeDownload(blank, true)).rejects.toThrow(DownloadClientError);

        expect(bodies).toEqual([]);
        expect(info.urls).toEqual([]);
      });

      it('removeDownload refuses the default deleteFiles arm too', async () => {
        const bodies = trackControlPosts('delete');
        serveFullList();

        await expect(client.removeDownload('   ')).rejects.toThrow(DownloadClientError);

        expect(bodies).toEqual([]);
      });

      it('names the blank stored external ID so an operator can repair the record', async () => {
        trackControlPosts('delete');
        serveFullList();

        const error = await client.removeDownload('', true).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toMatch(/blank/i);
        expect((error as DownloadClientError).message).toMatch(/external id/i);
      });

      /**
       * Positive control for the three absence assertions above: an empty `bodies` array otherwise
       * proves only that the handler was never wired ([[vacuous-assertion-observation-points]]).
       */
      it.each([
        ['pause', (c: QBittorrentClient) => c.pauseDownload(V1)],
        ['resume', (c: QBittorrentClient) => c.resumeDownload(V1)],
        ['delete', (c: QBittorrentClient) => c.removeDownload(V1, true)],
      ] as const)('control: the same %s tracker collects one body for a valid hash', async (action, call) => {
        const bodies = trackControlPosts(action);
        serveFullList();

        await call(client);

        expect(bodies).toHaveLength(1);
        expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe(CANONICAL);
      });
    });

    /**
     * A contract fence at the adapter boundary rather than a live path: `parseArtifact` cannot
     * currently produce a blank `infoHash` (`src/core/utils/download-url.ts:80-102,150-155` all
     * reject a missing hash), so the artifact is constructed directly.
     */
    it('rethrows a duplicate-add 409 rather than adopting a torrent for a blank infoHash', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => new HttpResponse(null, { status: 409 })),
      );
      const info = serveFullList();

      const error = await client.addDownload({
        type: 'magnet-uri',
        uri: 'magnet:?xt=urn:btih:&dn=Blank',
        infoHash: '',
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('HTTP 409');
      expect(info.urls).toEqual([]);
    });

    it('leaves the blank call out of a race with a valid resolution', async () => {
      const info = trackInfoRequests((params) => HttpResponse.json(
        servesFullList(params) ? [hybrid] : (params.get('hashes') === CANONICAL ? [hybrid] : []),
      ));

      const [blank, valid] = await Promise.all([client.getDownload(''), client.getDownload(V1)]);

      expect(blank).toBeNull();
      expect(valid!.id).toBe(CANONICAL);
      // The valid resolution's own probe + scan, and nothing from the blank one.
      expect(info.urls).toHaveLength(2);

      // One consistent memo entry survives: the next valid call rides it in a single request.
      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
    });
  });

  /**
   * #2423 — libtorrent 2.x re-keys a v1+v2 hybrid torrent's canonical API `hash` to the truncated
   * v2 hash once metadata arrives, moving the grabbed v1 to `infohash_v1`. Tracking by the
   * canonical hash alone lost the torrent 28 seconds after the add.
   */
  describe('hybrid v1/v2 hash identity (#2423)', () => {
    const V1 = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
    const CANONICAL = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
    const V2_FULL = `${CANONICAL}112233445566778899aabbcc`;

    /** The payload qBittorrent serves for the grabbed torrent once it discovers it is a hybrid. */
    const hybrid = {
      ...mockTorrent,
      hash: CANONICAL,
      infohash_v1: V1,
      infohash_v2: V2_FULL,
      name: 'Hybrid Torrent',
      state: 'metaDL',
      progress: 0.25,
      save_path: '/downloads/audiobooks',
    };

    describe('getDownload', () => {
      it('resolves a hybrid via the fallback list when the canonical-hash filter misses', async () => {
        const info = trackInfoRequests(byHashes([], [hybrid]));

        const result = await client.getDownload(V1);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(CANONICAL);
        expect(result!.name).toBe('Hybrid Torrent');
        expect(result!.progress).toBe(25);
        expect(result!.status).toBe('downloading');
        expect(result!.savePath).toBe('/downloads/audiobooks');
        expect(info.urls).toHaveLength(2);
        expect(info.params(0).get('hashes')).toBe(V1);
        expect(info.params(1).has('hashes')).toBe(false);
      });

      // MAM torrents are v1-only; the pre-#2423 request shape must survive byte-identical.
      it('answers a v1-only torrent on the fast path with exactly one request', async () => {
        const info = trackInfoRequests(byHashes([{ ...mockTorrent, hash: V1, infohash_v1: V1, infohash_v2: '' }], []));

        const result = await client.getDownload(V1.toUpperCase());

        expect(result!.id).toBe(V1);
        expect(info.urls).toHaveLength(1);
        expect(info.params(0).get('hashes')).toBe(V1);
      });

      it('matches on the truncated infohash_v2 when the canonical hash is unrelated', async () => {
        const reKeyed = { ...hybrid, hash: 'ffffffffffffffffffffffffffffffffffffffff', infohash_v1: '' };
        const info = trackInfoRequests(byHashes([], [reKeyed]));

        const result = await client.getDownload(CANONICAL);

        expect(result!.id).toBe('ffffffffffffffffffffffffffffffffffffffff');
        expect(info.urls).toHaveLength(2);
      });

      // F1 — without this arm an implementation that drops `hash` from the fallback matcher passes.
      it('matches on the canonical hash inside the fallback list', async () => {
        const plain = { ...mockTorrent, hash: V1, name: 'Slow To Register' };
        const info = trackInfoRequests(byHashes([], [plain]));

        const result = await client.getDownload(V1);

        expect(result!.id).toBe(V1);
        expect(result!.name).toBe('Slow To Register');
        expect(info.urls).toHaveLength(2);
      });

      it('returns null and issues exactly two requests when the torrent is genuinely absent', async () => {
        const info = trackInfoRequests(byHashes([], []));

        expect(await client.getDownload(V1)).toBeNull();
        expect(info.urls).toHaveLength(2);
      });

      it('matches an uppercase query against lowercase payload fields', async () => {
        trackInfoRequests(byHashes([], [hybrid]));

        const result = await client.getDownload(V1.toUpperCase());
        expect(result!.id).toBe(CANONICAL);
      });

      it('matches a lowercase query against an uppercase infohash_v1', async () => {
        trackInfoRequests(byHashes([], [{ ...hybrid, infohash_v1: V1.toUpperCase() }]));

        const result = await client.getDownload(V1);
        expect(result!.id).toBe(CANONICAL);
      });

      // Current builds emit "" for the axis a torrent does not have; that must never match.
      it('never matches empty-string hash fields, including on the first list element', async () => {
        const info = trackInfoRequests(byHashes([], [
          { ...mockTorrent, hash: 'dddddddddddddddddddddddddddddddddddddddd', infohash_v1: '', infohash_v2: '' },
          { ...mockTorrent, hash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', infohash_v1: '', infohash_v2: '' },
        ]));

        expect(await client.getDownload(V1)).toBeNull();
        expect(info.urls).toHaveLength(2);
      });

      // F2 — an unsafe matcher would pair an empty query with an empty candidate field.
      it('never matches an empty queried hash against empty candidate fields', async () => {
        trackInfoRequests(byHashes([], [
          { ...mockTorrent, hash: 'dddddddddddddddddddddddddddddddddddddddd', infohash_v1: '', infohash_v2: '' },
        ]));

        expect(await client.getDownload('')).toBeNull();
      });

      // qBittorrent < 4.4 (libtorrent 1.2) omits both fields entirely.
      it('parses an old-qBittorrent fallback payload that carries neither field', async () => {
        trackInfoRequests(byHashes([], [{ ...mockTorrent, hash: 'cccccccccccccccccccccccccccccccccccccccc' }]));

        expect(await client.getDownload(V1)).toBeNull();
      });

      it('throws rather than returning null when the FALLBACK payload is malformed', async () => {
        trackInfoRequests(byHashes([], [{ unexpected: 'shape' }]));

        const error = await client.getDownload(V1).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toContain('unexpected torrent data');
      });

      it('re-logs in and retries when the fallback request 403s, still resolving the hybrid', async () => {
        let fallbackCalls = 0;
        const info = trackInfoRequests((params) => {
          if (!servesFullList(params)) return HttpResponse.json([]);
          fallbackCalls++;
          if (fallbackCalls === 1) return new HttpResponse(null, { status: 403 });
          return HttpResponse.json([hybrid]);
        });

        const result = await client.getDownload(V1);

        expect(result!.id).toBe(CANONICAL);
        expect(info.urls).toHaveLength(3);
      });
    });

    describe('schema typing', () => {
      it('rejects a non-string infohash_v1', async () => {
        trackInfoRequests(byHashes([{ ...mockTorrent, infohash_v1: 123 }], []));

        await expect(client.getDownload(V1)).rejects.toThrow('unexpected torrent data');
      });

      // F4 — symmetric to the v1 case; proves infohash_v2 is a typed member, not passthrough.
      it('rejects a non-string infohash_v2', async () => {
        trackInfoRequests(byHashes([{ ...mockTorrent, infohash_v2: 456 }], []));

        await expect(client.getDownload(V1)).rejects.toThrow('unexpected torrent data');
      });
    });

    describe('fallback scoping', () => {
      it('scopes the fallback to the configured category', async () => {
        const scoped = new QBittorrentClient({ ...config, category: 'audio books' });
        const info = trackInfoRequests(byHashes([], [hybrid]));

        await scoped.getDownload(V1);

        expect(info.urls).toHaveLength(2);
        expect(info.urls[1]).toContain('category=audio%20books');
        expect(info.params(1).has('hashes')).toBe(false);
      });

      it('leaves the fallback unscoped when no category is configured', async () => {
        const info = trackInfoRequests(byHashes([], [hybrid]));

        await client.getDownload(V1);

        expect(info.params(1).has('category')).toBe(false);
        expect(info.params(1).has('hashes')).toBe(false);
      });
    });

    describe('control operations resolve to the canonical hash', () => {
      it.each([
        ['pauseDownload', 'pause'],
        ['resumeDownload', 'resume'],
      ] as const)('%s posts the canonical hash', async (method, action) => {
        const bodies = trackControlPosts(action);
        trackInfoRequests(byHashes([], [hybrid]));

        await client[method](V1);

        expect(bodies).toHaveLength(1);
        expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe(CANONICAL);
      });

      it('removeDownload posts the canonical hash and preserves deleteFiles', async () => {
        const bodies = trackControlPosts('delete');
        trackInfoRequests(byHashes([], [hybrid]));

        await client.removeDownload(V1, true);

        expect(bodies).toHaveLength(1);
        const body = new URLSearchParams(bodies[0]!);
        expect(body.get('hashes')).toBe(CANONICAL);
        expect(body.get('deleteFiles')).toBe('true');
      });

      // An already-gone torrent stays a no-op delete, not an error.
      it('removeDownload posts the caller hash unchanged when nothing resolves', async () => {
        const bodies = trackControlPosts('delete');
        trackInfoRequests(byHashes([], []));

        await expect(client.removeDownload(V1, true)).resolves.toBeUndefined();

        expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe(V1);
      });
    });

    // AC6 — composed behavior: adoptDuplicateOrRethrow goes through getDownload.
    it('adopts a hybrid already present under its v2 canonical on an HTTP 409 add', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => new HttpResponse(null, { status: 409 })),
      );
      trackInfoRequests(byHashes([], [hybrid]));

      const hash = await client.addDownload({
        type: 'magnet-uri',
        uri: `magnet:?xt=urn:btih:${V1}&dn=Hybrid`,
        infoHash: V1,
      });

      expect(hash).toBe(V1);
    });
  });

  /**
   * #2433 — nothing remembered the hash a hybrid actually resolved to, so every 30s monitor poll
   * and every control call re-paid the full fallback scan for the life of the download.
   *
   * Request counts here are order-dependent (the memo changes what the NEXT call costs), so every
   * case asserts the delta around its own call rather than one total at the end.
   */
  describe('canonical-hash memo (#2433)', () => {
    const V1 = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
    const CANONICAL = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
    const REKEYED = 'bb22cc33dd44ee55ff66aa77bb88cc99dd00aa11';

    const hybrid = {
      ...mockTorrent,
      hash: CANONICAL,
      infohash_v1: V1,
      infohash_v2: `${CANONICAL}112233445566778899aabbcc`,
      name: 'Hybrid Torrent',
    };

    /** The fast path answers by the requested `hashes` VALUE; the unfiltered scan answers `onScan`. */
    function trackByHash(onFastPath: (hashes: string) => unknown[], onScan: () => unknown[]) {
      return trackInfoRequests((params) => HttpResponse.json(
        servesFullList(params) ? onScan() : onFastPath(params.get('hashes')!),
      ));
    }

    /** Only the canonical hash answers the fast path — the grabbed v1 misses, as libtorrent 2.x leaves it. */
    function serveHybrid() {
      return trackByHash((hashes) => (hashes === CANONICAL ? [hybrid] : []), () => [hybrid]);
    }

    it('resolves a memoized hybrid in one request, keyed on the canonical hash', async () => {
      const info = serveHybrid();

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(2);

      const second = await client.getDownload(V1);

      expect(second!.id).toBe(CANONICAL);
      expect(second!.name).toBe('Hybrid Torrent');
      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
    });

    it.each([
      ['pauseDownload', 'pause'],
      ['resumeDownload', 'resume'],
    ] as const)('%s rides the memo: one request, posting the canonical hash', async (method, action) => {
      const info = serveHybrid();
      const bodies = trackControlPosts(action);
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      await client[method](V1);

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
      expect(bodies).toHaveLength(1);
      expect(new URLSearchParams(bodies[0]!).get('hashes')).toBe(CANONICAL);
    });

    it('removeDownload rides the memo and preserves deleteFiles', async () => {
      const info = serveHybrid();
      const bodies = trackControlPosts('delete');
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      await client.removeDownload(V1, true);

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
      const body = new URLSearchParams(bodies[0]!);
      expect(body.get('hashes')).toBe(CANONICAL);
      expect(body.get('deleteFiles')).toBe('true');
    });

    // A fast-path hit is already one request; memoizing an identity mapping would buy nothing.
    it('writes nothing on a fast-path hit, so a v1-only torrent stays at one request per call', async () => {
      const v1Only = { ...mockTorrent, hash: V1, infohash_v1: V1, infohash_v2: '' };
      const info = trackByHash(() => [v1Only], () => []);

      await client.getDownload(V1);
      await client.getDownload(V1);
      await client.getDownload(V1);

      expect(info.urls).toHaveLength(3);
      expect([0, 1, 2].map((i) => info.params(i).get('hashes'))).toEqual([V1, V1, V1]);
    });

    it('re-resolves on the caller hash and re-keys when the memoized canonical goes stale', async () => {
      const reKeyed = { ...hybrid, hash: REKEYED };
      let live = hybrid;
      const info = trackByHash(
        (hashes) => (hashes === live.hash ? [live] : []),
        () => [live],
      );

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(2);

      live = reKeyed;
      const afterRekey = await client.getDownload(V1);

      expect(afterRekey!.id).toBe(REKEYED);
      expect(info.urls).toHaveLength(4);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
      expect(info.params(3).has('hashes')).toBe(false);

      expect((await client.getDownload(V1))!.id).toBe(REKEYED);
      expect(info.urls).toHaveLength(5);
      expect(info.params(4).get('hashes')).toBe(REKEYED);
    });

    it('clears a stale entry on a genuine absence, so the next call probes the caller hash', async () => {
      let present = true;
      const info = trackByHash(
        (hashes) => (present && hashes === CANONICAL ? [hybrid] : []),
        () => (present ? [hybrid] : []),
      );
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      present = false;
      expect(await client.getDownload(V1)).toBeNull();
      expect(info.urls).toHaveLength(4);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);

      expect(await client.getDownload(V1)).toBeNull();
      expect(info.urls).toHaveLength(6);
      expect(info.params(4).get('hashes')).toBe(V1);
    });

    // Positive control for the clear above: absence must not be recorded either way.
    it('memoizes nothing on absence, so a torrent that appears later still resolves', async () => {
      let present = false;
      const info = trackByHash(() => [], () => (present ? [hybrid] : []));

      expect(await client.getDownload(V1)).toBeNull();
      expect(info.urls).toHaveLength(2);

      present = true;
      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(4);
      expect(info.params(2).get('hashes')).toBe(V1);
    });

    // The map is an instance field: two clients pointed at different hosts must never share entries.
    it('keeps the memo per instance', async () => {
      const info = serveHybrid();
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      const other = new QBittorrentClient(config);
      expect((await other.getDownload(V1))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(4);
      expect(info.params(2).get('hashes')).toBe(V1);
    });

    it('evicts on removeDownload so a later re-add starts from a clean mapping', async () => {
      const info = serveHybrid();
      trackControlPosts('delete');
      await client.getDownload(V1);
      await client.removeDownload(V1);
      expect(info.urls).toHaveLength(3);

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(5);
      expect(info.params(3).get('hashes')).toBe(V1);
    });

    it('leaves one consistent entry when two resolutions race', async () => {
      const info = serveHybrid();

      const [first, second] = await Promise.all([client.getDownload(V1), client.getDownload(V1)]);

      expect(first!.id).toBe(CANONICAL);
      expect(second!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(4);

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(5);
      expect(info.params(4).get('hashes')).toBe(CANONICAL);
    });

    /**
     * A9 rewritten for #2485. The old case asserted a blank hash fell through to a scan on its own
     * hash; since the early return it issues NO request at all, which subsumes the read half of A9
     * and the F3 write half both — a hash that never reaches the network can neither consult nor
     * record a mapping, and there is no scan left for it to resolve through.
     */
    it.each([['empty', ''], ['whitespace-only', '   ']])('leaves the memo untouched in both directions for a %s hash', async (_label, blank) => {
      const info = serveHybrid();
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      expect(await client.getDownload(blank)).toBeNull();
      await client.removeDownload(blank).catch(() => { /* the refusal itself is fenced elsewhere */ });

      // neither call reached the network
      expect(info.urls).toHaveLength(2);
      // and the V1 -> CANONICAL entry survived both, so the next call still costs exactly one request
      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
    });

    /**
     * F3's fence, re-observed. `memoKey`'s `.trim()` still carries the empty-vs-whitespace decision
     * — the early return keys off it — so degrading it to a plain truthiness check would send '   '
     * down the normal path. The observable is that a whitespace hash costs nothing and refuses,
     * against a double that would otherwise resolve it: an infohash_v1 of '   ' matches a queried
     * '   ' (the matcher only rejects EMPTY axes), which is what a non-trimming guard would adopt.
     */
    it('keeps a whitespace-only hash on the refusal path even when the list would resolve it', async () => {
      const blankAxis = { ...hybrid, infohash_v1: '   ' };
      const info = trackByHash((hashes) => (hashes === CANONICAL ? [blankAxis] : []), () => [blankAxis]);

      expect(await client.getDownload('   ')).toBeNull();
      await expect(client.removeDownload('   ')).rejects.toThrow(DownloadClientError);

      expect(info.urls).toEqual([]);
    });

    it('keys the memo case-insensitively', async () => {
      const info = serveHybrid();
      await client.getDownload(V1.toUpperCase());
      expect(info.urls).toHaveLength(2);

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
    });

    /**
     * F2 — A4: a memo probe hit is returned WITHOUT re-running isSameTorrent. A re-keyed hybrid
     * whose client reports `infohash_v1: ""` would fail that verification and permanently lose the
     * mapping in exactly the case the memo exists for; infohashes are content-derived, so a
     * canonical hash pointing at unrelated content is not a real failure mode.
     */
    it('trusts a memo hit whose canonical response reports a blank infohash_v1', async () => {
      const blankAxes = { ...hybrid, infohash_v1: '', infohash_v2: '' };
      const info = trackByHash((hashes) => (hashes === CANONICAL ? [blankAxes] : []), () => [hybrid]);
      await client.getDownload(V1);
      expect(info.urls).toHaveLength(2);

      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);

      // and the entry survived the unverifiable response
      expect((await client.getDownload(V1))!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(4);
      expect(info.params(3).get('hashes')).toBe(CANONICAL);
    });

    it('composes with the 409 duplicate-add adoption on a second add of the same hash', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => new HttpResponse(null, { status: 409 })),
      );
      const info = serveHybrid();
      const artifact: DownloadArtifact = {
        type: 'magnet-uri',
        uri: `magnet:?xt=urn:btih:${V1}&dn=Hybrid`,
        infoHash: V1,
      };

      expect(await client.addDownload(artifact)).toBe(V1);
      expect(info.urls).toHaveLength(2);

      expect(await client.addDownload(artifact)).toBe(V1);
      expect(info.urls).toHaveLength(3);
      expect(info.params(2).get('hashes')).toBe(CANONICAL);
    });
  });

  /**
   * #2433 — the scoped scan looks in `config.category`, but a torrent's real category is whatever
   * it was added under or later moved to. A scoped miss on a LIVE hybrid used to read as death.
   */
  describe('unscoped fall-through on a scoped miss (#2433)', () => {
    const V1 = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';
    const CANONICAL = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';

    const hybrid = {
      ...mockTorrent,
      hash: CANONICAL,
      infohash_v1: V1,
      infohash_v2: `${CANONICAL}112233445566778899aabbcc`,
      name: 'Hybrid Torrent',
    };

    function scopedClient(category = 'audiobooks') {
      return new QBittorrentClient({ ...config, category });
    }

    /** Discriminates the three phases of one resolution; `onScan` sees the scoped category, if any. */
    function trackScans(onScan: (category: string | null) => unknown[]) {
      return trackInfoRequests((params) => HttpResponse.json(
        servesFullList(params) ? onScan(params.get('category')) : [],
      ));
    }

    it('resolves a re-categorized hybrid through one unscoped scan', async () => {
      const info = trackScans((category) => (category ? [] : [hybrid]));

      const result = await scopedClient().getDownload(V1);

      expect(result!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(3);
      expect(info.params(1).get('category')).toBe('audiobooks');
      expect(info.params(2).has('category')).toBe(false);
      expect(info.params(2).has('hashes')).toBe(false);
    });

    it('does not escalate when the scoped scan already carries the torrent', async () => {
      const info = trackScans((category) => (category === 'audiobooks' ? [hybrid] : []));

      const result = await scopedClient().getDownload(V1);

      expect(result!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(2);
    });

    /**
     * B2 regression fence — with no category configured the scoped scan IS the unscoped one, so an
     * implementation that unconditionally appends a third request passes every other case here.
     */
    it('issues no duplicate scan when no category is configured', async () => {
      const info = trackScans(() => []);

      expect(await client.getDownload(V1)).toBeNull();

      expect(info.urls).toHaveLength(2);
      expect(info.params(1).has('category')).toBe(false);
    });

    it('costs exactly three requests and returns null on a genuine absence under a category', async () => {
      const info = trackScans(() => []);

      expect(await scopedClient().getDownload(V1)).toBeNull();

      expect(info.urls).toHaveLength(3);
      expect(info.params(2).has('category')).toBe(false);
    });

    it('encodes the scoped category and drops it entirely from the unscoped scan', async () => {
      const info = trackScans((category) => (category ? [] : [hybrid]));

      await scopedClient('audio books').getDownload(V1);

      expect(info.urls[1]).toContain('category=audio%20books');
      expect(info.urls[2]).not.toContain('category');
    });

    it('throws rather than returning null when the UNSCOPED payload is malformed', async () => {
      trackScans((category) => (category ? [] : [{ unexpected: 'shape' }]));

      const error = await scopedClient().getDownload(V1).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('unexpected torrent data');
    });

    it('re-logs in and retries when the unscoped scan 403s, still resolving the hybrid', async () => {
      let unscopedCalls = 0;
      const info = trackInfoRequests((params) => {
        if (!servesFullList(params) || params.has('category')) return HttpResponse.json([]);
        unscopedCalls++;
        if (unscopedCalls === 1) return new HttpResponse(null, { status: 403 });
        return HttpResponse.json([hybrid]);
      });

      const result = await scopedClient().getDownload(V1);

      expect(result!.id).toBe(CANONICAL);
      expect(info.urls).toHaveLength(4);
    });

    it('memoizes an unscoped resolution exactly like a scoped one', async () => {
      const scoped = scopedClient();
      const info = trackInfoRequests((params) => {
        if (params.get('hashes') === CANONICAL) return HttpResponse.json([hybrid]);
        if (!servesFullList(params) || params.has('category')) return HttpResponse.json([]);
        return HttpResponse.json([hybrid]);
      });
      await scoped.getDownload(V1);
      expect(info.urls).toHaveLength(3);

      expect((await scoped.getDownload(V1))!.id).toBe(CANONICAL);

      expect(info.urls).toHaveLength(4);
      expect(info.params(3).get('hashes')).toBe(CANONICAL);
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

    it('parses category entries with null inner name/savePath and returns the keys', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return HttpResponse.json({
            audiobooks: { name: null, savePath: null },
            music: { name: 'music', savePath: '/downloads/music' },
          });
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks', 'music']);
    });

    it('throws DownloadClientError with ZodError cause when API returns empty body', async () => {
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
            },
          ]);
        }),
      );

      const results = await client.getAllDownloads();
      expect(results).toHaveLength(2);
      expect(results[0]!.name).toBe('Correct Name');
      expect(results[0]!.savePath).toBe('/downloads');
      expect(results[1]!.name).toBe('Fallback Name');
      expect(results[1]!.savePath).toBe('/other');
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
