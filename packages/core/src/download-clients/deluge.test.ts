import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { DelugeClient } from './deluge.js';

const config = { host: 'localhost', port: 8112, password: 'deluge', useSsl: false };
const BASE_URL = 'http://localhost:8112';
const SESSION_COOKIE = '_session_id=abc123deadbeef';

const mockTorrentStatus = {
  hash: 'abc123def456',
  name: 'Test Torrent',
  state: 'Downloading',
  progress: 50,
  total_size: 1000000,
  total_done: 500000,
  total_uploaded: 100000,
  ratio: 0.2,
  num_seeds: 10,
  num_peers: 5,
  eta: 3600,
  save_path: '/downloads',
  time_added: 1700000000,
};

function rpcHandler(methodHandlers: Record<string, (params: unknown[]) => unknown>) {
  return http.post(`${BASE_URL}/json`, async ({ request }) => {
    const body = await request.json() as { method: string; params: unknown[]; id: number };
    const handler = methodHandlers[body.method];
    if (handler) {
      const headers: Record<string, string> = {};
      // Login responses set session cookie
      if (body.method === 'auth.login') {
        headers['Set-Cookie'] = `${SESSION_COOKIE}; Path=/; HttpOnly`;
      }
      return HttpResponse.json({ id: body.id, result: handler(body.params), error: null }, { headers });
    }
    return HttpResponse.json({ id: body.id, result: null, error: { message: `Unknown method: ${body.method}`, code: 0 } });
  });
}

function loginHandler() {
  return rpcHandler({ 'auth.login': () => true });
}

describe('DelugeClient', () => {
  const server = useMswServer();
  let client: DelugeClient;

  beforeEach(() => {
    client = new DelugeClient(config);
    server.use(loginHandler());
  });

  describe('authentication', () => {
    it('authenticates via auth.login JSON-RPC call', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'daemon.info': () => '2.1.1',
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Deluge 2.1.1');
    });

    it('fails on invalid password', async () => {
      server.use(rpcHandler({
        'auth.login': () => false,
      }));
      client = new DelugeClient(config);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid password');
    });

    it('re-authenticates on session expiry (auth error code)', async () => {
      let callCount = 0;
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        callCount++;
        if (callCount === 1) {
          // First call: session expired
          return HttpResponse.json({ id: body.id, result: null, error: { message: 'Not authenticated', code: 1 } });
        }
        // After re-auth
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
    });

    it('sends session cookie on authenticated RPC calls', async () => {
      let capturedCookie: string | null = null;
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        capturedCookie = request.headers.get('cookie');
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      await client.test();
      expect(capturedCookie).toContain(SESSION_COOKIE);
    });

    it('re-authenticates on HTTP 403', async () => {
      let callCount = 0;
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(null, { status: 403 });
        }
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
    });
  });

  describe('addDownload', () => {
    it('adds magnet URI via core.add_torrent_magnet', async () => {
      const magnetUri = 'magnet:?xt=urn:btih:abc123&dn=test';
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_magnet': () => 'abc123hash',
      }));

      const result = await client.addDownload(magnetUri);
      expect(result).toBe('abc123hash');
    });

    it('adds torrent URL via core.add_torrent_url', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_url': () => 'url123hash',
      }));

      const result = await client.addDownload('https://example.com/file.torrent');
      expect(result).toBe('url123hash');
    });

    it('sets category via label plugin after adding', async () => {
      const methods: string[] = [];
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        methods.push(body.method);
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: true, error: null });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await client.addDownload('magnet:?xt=urn:btih:abc123', { category: 'audiobooks' });
      expect(methods).toContain('label.set_torrent');
    });

    it('calls onWarn when label plugin is unavailable', async () => {
      const onWarn = vi.fn();
      const warnClient = new DelugeClient({ ...config, onWarn });
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: null, error: { message: 'Unknown method', code: 0 } });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await warnClient.addDownload('magnet:?xt=urn:btih:abc123', { category: 'audiobooks' });
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('Label plugin not available'));
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('audiobooks'));
    });

    it('succeeds without category when label plugin is unavailable', async () => {
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: null, error: { message: 'Unknown method', code: 0 } });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      const result = await client.addDownload('magnet:?xt=urn:btih:abc123', { category: 'audiobooks' });
      expect(result).toBe('hash123');
    });

    it('throws when Deluge returns no hash', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_magnet': () => null,
      }));

      await expect(client.addDownload('magnet:?xt=urn:btih:abc123')).rejects.toThrow('no torrent hash');
    });
  });

  describe('getDownload', () => {
    it('returns mapped status from core.get_torrent_status', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => mockTorrentStatus,
      }));

      const result = await client.getDownload('abc123def456');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('abc123def456');
      expect(result!.name).toBe('Test Torrent');
      expect(result!.progress).toBe(50);
      expect(result!.status).toBe('downloading');
      expect(result!.savePath).toBe('/downloads');
    });

    it('returns null when torrent not found', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({}),
      }));

      const result = await client.getDownload('nonexistent');
      expect(result).toBeNull();
    });

    it('maps Seeding state correctly', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Seeding' }),
      }));

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('seeding');
    });
  });

  describe('getAllDownloads', () => {
    it('returns all torrents', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrents_status': () => ({
          hash1: mockTorrentStatus,
          hash2: { ...mockTorrentStatus, name: 'Torrent 2' },
        }),
      }));

      const result = await client.getAllDownloads();
      expect(result).toHaveLength(2);
    });

    it('filters by label when category provided', async () => {
      let receivedFilter: Record<string, unknown> = {};
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'core.get_torrents_status') {
          receivedFilter = body.params[0] as Record<string, unknown>;
          return HttpResponse.json({ id: body.id, result: {}, error: null });
        }
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await client.getAllDownloads('audiobooks');
      expect(receivedFilter.label).toBe('audiobooks');
    });

    it('returns empty array when no torrents', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrents_status': () => null,
      }));

      const result = await client.getAllDownloads();
      expect(result).toEqual([]);
    });
  });

  describe('getCategories', () => {
    it('returns available labels', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'label.get_labels': () => ['audiobooks', 'music'],
      }));

      const result = await client.getCategories();
      expect(result).toEqual(['audiobooks', 'music']);
    });

    it('returns empty array when label plugin not installed', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
      }));

      const result = await client.getCategories();
      expect(result).toEqual([]);
    });
  });

  describe('removeDownload', () => {
    it('calls core.remove_torrent with deleteFiles flag', async () => {
      let receivedParams: unknown[] = [];
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'core.remove_torrent') {
          receivedParams = body.params;
          return HttpResponse.json({ id: body.id, result: true, error: null });
        }
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await client.removeDownload('hash123', true);
      expect(receivedParams[0]).toBe('hash123');
      expect(receivedParams[1]).toBe(true);
    });
  });

  describe('error handling', () => {
    it('throws descriptive error when response is not valid JSON', async () => {
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        // Return HTML instead of JSON (e.g., reverse proxy error page)
        return new HttpResponse('<html>Bad Gateway</html>', { headers: { 'Content-Type': 'text/html' } });
      }));

      await expect(client.getDownload('abc123')).rejects.toThrow('server didn\'t respond as expected');
    });

    it('throws on non-recoverable HTTP error (500)', async () => {
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        return new HttpResponse(null, { status: 500 });
      }));

      await expect(client.getDownload('abc123')).rejects.toThrow('HTTP 500');
    });

    it('throws RPC error message from Deluge', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
      }));
      // Default rpcHandler returns error for unknown methods
      await expect(client.getDownload('abc123')).rejects.toThrow('Deluge RPC error');
    });
  });

  describe('test', () => {
    it('returns success with version on valid auth', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'daemon.info': () => '2.1.1',
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Deluge 2.1.1');
    });

    it('returns failure on connection error', async () => {
      server.use(http.post(`${BASE_URL}/json`, () => {
        return HttpResponse.error();
      }));
      client = new DelugeClient(config);

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    });
  });
});
