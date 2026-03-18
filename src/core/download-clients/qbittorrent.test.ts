import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { QBittorrentClient } from './qbittorrent.js';

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
          return HttpResponse.json('v4.6.0');
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
          return HttpResponse.json('v4.6.0');
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
          return HttpResponse.json('v4.6.0');
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Login failed: No session cookie received');
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

    it('does not retry infinitely (throws after second 403)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(client.getAllDownloads()).rejects.toThrow('Request failed: HTTP 403');
    });
  });

  describe('addDownload', () => {
    it('extracts hex hash from magnet URI', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      const magnetUri = 'magnet:?xt=urn:btih:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0&dn=Test';
      const hash = await client.addDownload(magnetUri);
      expect(hash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    });

    it('converts base32 hash to hex', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      // JBSWY3DPEHPK3PXP is a valid base32 string
      const magnetUri = 'magnet:?xt=urn:btih:JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&dn=Test';
      const hash = await client.addDownload(magnetUri);
      // base32 "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" should be converted to hex
      expect(hash).toMatch(/^[a-f0-9]{40}$/);
    });

    it('throws when no hash in magnet URI', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      await expect(client.addDownload('magnet:?dn=Test')).rejects.toThrow(
        'Could not extract info hash from magnet URI',
      );
    });

    it('throws for .torrent URLs before sending request', async () => {
      // No MSW handler needed — the error should fire before any HTTP request
      const url = 'https://example.com/file.torrent?passkey=SECRET123';
      await expect(client.addDownload(url)).rejects.toThrow(
        'qBittorrent adapter only supports magnet URIs',
      );
      // Verify the URL (which may contain passkeys/tokens) is NOT leaked in the error message
      await expect(client.addDownload(url)).rejects.toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('SECRET123'),
        }),
      );
    });

    it('throws when btih contains invalid characters', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      // Invalid chars prevent regex match entirely — neither hex [a-f0-9]{40} nor base32 [a-z2-7]{32} matches
      await expect(
        client.addDownload('magnet:?xt=urn:btih:INVALID!@%23%24CHARS&dn=Test'),
      ).rejects.toThrow('Could not extract info hash from magnet URI');
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
          return HttpResponse.json('v4.6.0');
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

    it('returns empty array when API returns null', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse('', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('throws on auth failure (403 after retry)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(client.getCategories()).rejects.toThrow('403');
    });

    it('throws on network error', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(client.getCategories()).rejects.toThrow();
    });

    it('throws on malformed response (HTML instead of JSON)', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, () => {
          return new HttpResponse('<html>Not JSON</html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      await expect(client.getCategories()).rejects.toThrow('didn\'t respond as expected');
    });

    it('throws on request timeout', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/categories`, async () => {
          await delay('infinite');
          return HttpResponse.json({});
        }),
      );

      const originalTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException('The operation was aborted', 'TimeoutError'));

      await expect(client.getCategories()).rejects.toThrow();

      AbortSignal.timeout = originalTimeout;
    });

    it('has supportsCategories = true', () => {
      expect(client.supportsCategories).toBe(true);
    });
  });

  describe('edge cases — boundary values and malformed data', () => {
    it('handles invalid base32 characters in hash (skips them)', async () => {
      server.use(
        http.post(`${BASE_URL}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      // Base32 with invalid chars (0, 1, 8, 9) — they get skipped in base32ToHex
      const magnetUri = 'magnet:?xt=urn:btih:JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&dn=Test';
      const hash = await client.addDownload(magnetUri);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

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

    it('handles whitespace-only response body as empty', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('   ', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      // Whitespace is truthy but JSON.parse('   ') throws — this tests error path
      await expect(client.getDownload('abc123')).rejects.toThrow();
    });

    it('handles null response from getAllDownloads', async () => {
      server.use(
        http.get(`${BASE_URL}/api/v2/torrents/info`, () => {
          return new HttpResponse('', {
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      );

      const results = await client.getAllDownloads();
      expect(results).toEqual([]);
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
});
