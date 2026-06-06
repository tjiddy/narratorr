import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { DelugeClient } from './deluge.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientAuthError, DownloadClientError } from './errors.js';

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
  is_finished: false,
};

function magnetArtifact(uri: string): DownloadArtifact {
  const match = uri.match(/btih:([a-fA-F0-9]+)/);
  return { type: 'magnet-uri', uri, infoHash: match?.[1] ?? 'abc123' };
}

function torrentBytesArtifact(data?: Buffer): DownloadArtifact {
  return { type: 'torrent-bytes', data: data ?? Buffer.from('fake'), infoHash: 'fakehash123' };
}

function rpcHandler(methodHandlers: Record<string, (params: unknown[]) => unknown>) {
  // Default the daemon handshake to "already connected" so the web.connect path
  // short-circuits; tests that exercise the handshake override web.connected.
  const handlers: Record<string, (params: unknown[]) => unknown> = { 'web.connected': () => true, ...methodHandlers };
  return http.post(`${BASE_URL}/json`, async ({ request }) => {
    const body = await request.json() as { method: string; params: unknown[]; id: number };
    const handler = handlers[body.method];
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

    it('throws DownloadClientError (not auth) on non-auth login HTTP failure', async () => {
      server.use(
        http.post(`${BASE_URL}/json`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );
      client = new DelugeClient(config);

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect(error).not.toBeInstanceOf(DownloadClientAuthError);
      expect((error as DownloadClientError).message).toContain('500');
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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

  describe('daemon handshake (web.connect)', () => {
    // Builds a handler that auths, answers the handshake methods per the supplied
    // config, then answers daemon.info. Records every method seen + connect params.
    function handshakeHandler(opts: {
      connected: boolean;
      hosts?: unknown;
      onCall?: (method: string, params: unknown[], cookie: string | null) => void;
    }) {
      return http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        opts.onCall?.(body.method, body.params, request.headers.get('cookie'));
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'web.connected') return HttpResponse.json({ id: body.id, result: opts.connected, error: null });
        if (body.method === 'web.get_hosts') return HttpResponse.json({ id: body.id, result: opts.hosts ?? null, error: null });
        if (body.method === 'web.connect') return HttpResponse.json({ id: body.id, result: [], error: null });
        if (body.method === 'daemon.info') return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
        return HttpResponse.json({ id: body.id, result: null, error: { message: `Unknown method: ${body.method}`, code: 2 } });
      });
    }

    it('connects web→daemon when web.connected is false', async () => {
      const methods: string[] = [];
      let connectParams: unknown[] = [];
      server.use(handshakeHandler({
        connected: false,
        hosts: [['host-id-1', '127.0.0.1', 58846, 'localhost']],
        onCall: (method, params) => {
          methods.push(method);
          if (method === 'web.connect') connectParams = params;
        },
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(methods).toContain('web.get_hosts');
      expect(methods).toContain('web.connect');
      expect(connectParams[0]).toBe('host-id-1');
    });

    it('does not reconnect when web.connected is true', async () => {
      const methods: string[] = [];
      server.use(handshakeHandler({
        connected: true,
        onCall: (method) => methods.push(method),
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(methods).not.toContain('web.get_hosts');
      expect(methods).not.toContain('web.connect');
    });

    it('throws an actionable error when web.get_hosts is empty', async () => {
      server.use(handshakeHandler({ connected: false, hosts: [] }));

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('Connection Manager');
      expect((error as DownloadClientError).message).not.toContain('Unknown method');
    });

    it('throws an actionable error when web.get_hosts is null', async () => {
      server.use(handshakeHandler({ connected: false, hosts: null }));

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('Connection Manager');
    });

    it.each([
      { label: 'first entry null', hosts: [null] },
      { label: 'first entry object', hosts: [{}] },
      { label: 'first entry empty array', hosts: [[]] },
      { label: 'first entry id null', hosts: [[null, '127.0.0.1']] },
      { label: 'first entry id empty string', hosts: [['', '127.0.0.1']] },
    ])('throws actionable error and never calls web.connect — $label', async ({ hosts }) => {
      const methods: string[] = [];
      let connectParams: unknown[] | null = null;
      server.use(handshakeHandler({
        connected: false,
        hosts,
        onCall: (method, params) => {
          methods.push(method);
          if (method === 'web.connect') connectParams = params;
        },
      }));

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('Connection Manager');
      expect(methods).not.toContain('web.connect');
      expect(connectParams).toBeNull();
    });

    it('test() succeeds end-to-end against a WebUI that starts un-connected', async () => {
      server.use(handshakeHandler({
        connected: false,
        hosts: [['host-id-1', '127.0.0.1', 58846, 'localhost']],
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Deluge 2.1.1');
    });

    it('carries the auth.login session cookie on every handshake call', async () => {
      const cookies: Record<string, string | null> = {};
      server.use(handshakeHandler({
        connected: false,
        hosts: [['host-id-1', '127.0.0.1', 58846, 'localhost']],
        onCall: (method, _params, cookie) => {
          if (method !== 'auth.login') cookies[method] = cookie;
        },
      }));

      await client.test();
      expect(cookies['web.connected']).toContain(SESSION_COOKIE);
      expect(cookies['web.get_hosts']).toContain(SESSION_COOKIE);
      expect(cookies['web.connect']).toContain(SESSION_COOKIE);
    });

    it('surfaces a rawRpc() data.error as a plain DownloadClientError without re-login/retry', async () => {
      // A `data.error` (even code 1) reached through rawRpc() during the handshake
      // must NOT trigger the auth-retry path — rawRpc keeps its own plain-throw
      // policy at the helper boundary, so no inner re-login loop occurs.
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
        // web.connected goes through rawRpc(); return an RPC error with code 1.
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: null, error: { message: 'Not authenticated', code: 1 } });
        }
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect(error).not.toBeInstanceOf(DownloadClientAuthError);
      expect((error as DownloadClientError).message).toContain('Deluge RPC error');
      // No retry: auth.login ran exactly once, web.connected was not re-attempted.
      expect(methods.filter((m) => m === 'auth.login')).toHaveLength(1);
      expect(methods.filter((m) => m === 'web.connected')).toHaveLength(1);
    });

    it('surfaces a rawRpc() non-401/403 transport failure as a plain DownloadClientError without re-login/retry', async () => {
      // A generic HTTP failure (e.g. 500) reached through rawRpc()'s shared parse
      // path must surface as a plain DownloadClientError and NOT set wasAuthFailure
      // or trigger the auth re-login/retry — locking the divergence at the helper
      // boundary (the 401/403 auth pre-check lives in rpc(), not in the helper).
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
        // web.connected goes through rawRpc(); fail it with a non-401/403 HTTP status.
        if (body.method === 'web.connected') {
          return new HttpResponse(null, { status: 500 });
        }
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      const error = await client.getAllDownloads().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect(error).not.toBeInstanceOf(DownloadClientAuthError);
      expect((error as DownloadClientError).message).toContain('HTTP 500');
      // No retry: auth.login ran exactly once, web.connected was not re-attempted.
      expect(methods.filter((m) => m === 'auth.login')).toHaveLength(1);
      expect(methods.filter((m) => m === 'web.connected')).toHaveLength(1);
    });

    it('re-runs the handshake on the re-login retry path without looping', async () => {
      const methods: string[] = [];
      let daemonInfoCalls = 0;
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        methods.push(body.method);
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'web.connected') return HttpResponse.json({ id: body.id, result: false, error: null });
        if (body.method === 'web.get_hosts') return HttpResponse.json({ id: body.id, result: [['host-id-1', '127.0.0.1', 58846, 'localhost']], error: null });
        if (body.method === 'web.connect') return HttpResponse.json({ id: body.id, result: [], error: null });
        // daemon.info: first call reports an expired session (code 1) → forces re-login.
        daemonInfoCalls++;
        if (daemonInfoCalls === 1) {
          return HttpResponse.json({ id: body.id, result: null, error: { message: 'Not authenticated', code: 1 } });
        }
        return HttpResponse.json({ id: body.id, result: '2.1.1', error: null });
      }));

      const result = await client.test();
      expect(result.success).toBe(true);
      // Handshake ran on both the initial login and the retry re-login.
      expect(methods.filter((m) => m === 'web.connected')).toHaveLength(2);
      expect(methods.filter((m) => m === 'web.connect')).toHaveLength(2);
    });
  });

  describe('addDownload', () => {
    it('adds magnet URI via core.add_torrent_magnet', async () => {
      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123&dn=test');
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_magnet': () => 'abc123hash',
      }));

      const result = await client.addDownload(artifact);
      expect(result).toBe('abc123hash');
    });

    it('adds torrent bytes via core.add_torrent_file', async () => {
      const artifact = torrentBytesArtifact();
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_file': () => 'url123hash',
      }));

      const result = await client.addDownload(artifact);
      expect(result).toBe('url123hash');
    });

    it('sets category via label plugin after adding', async () => {
      const methods: string[] = [];
      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123');
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        methods.push(body.method);
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'web.connected') return HttpResponse.json({ id: body.id, result: true, error: null });
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: true, error: null });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await client.addDownload(artifact, { category: 'audiobooks' });
      expect(methods).toContain('label.set_torrent');
    });

    it('calls onWarn when label plugin is unavailable', async () => {
      const onWarn = vi.fn();
      const warnClient = new DelugeClient({ ...config, onWarn });
      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123');
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'web.connected') return HttpResponse.json({ id: body.id, result: true, error: null });
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: null, error: { message: 'Unknown method', code: 0 } });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      await warnClient.addDownload(artifact, { category: 'audiobooks' });
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('Label plugin not available'));
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('audiobooks'));
    });

    it('succeeds without category when label plugin is unavailable', async () => {
      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123');
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };
        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly` } },
          );
        }
        if (body.method === 'web.connected') return HttpResponse.json({ id: body.id, result: true, error: null });
        if (body.method === 'core.add_torrent_magnet') return HttpResponse.json({ id: body.id, result: 'hash123', error: null });
        if (body.method === 'label.set_torrent') return HttpResponse.json({ id: body.id, result: null, error: { message: 'Unknown method', code: 0 } });
        return HttpResponse.json({ id: body.id, result: null, error: null });
      }));

      const result = await client.addDownload(artifact, { category: 'audiobooks' });
      expect(result).toBe('hash123');
    });

    it('throws when Deluge returns no hash', async () => {
      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123');
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.add_torrent_magnet': () => null,
      }));

      await expect(client.addDownload(artifact)).rejects.toThrow('no torrent hash');
    });

    it('rejects nzb-url artifact with torrent-only error', async () => {
      await expect(
        client.addDownload({ type: 'nzb-url', url: 'https://indexer.test/nzb' }),
      ).rejects.toThrow('only supports torrent artifacts');
    });

    it('rejects nzb-bytes artifact with DownloadClientError', async () => {
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: Buffer.from('<nzb/>') }),
      ).rejects.toThrow('only supports torrent artifacts');
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

    it('maps download_rate to downloadSpeed in bytes/sec', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, download_rate: 524288 }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.downloadSpeed).toBe(524288);
    });

    it('preserves download_rate=0 (stalled) rather than coercing to undefined', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, download_rate: 0 }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.downloadSpeed).toBe(0);
    });

    it('leaves downloadSpeed undefined when download_rate field is absent', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => mockTorrentStatus,
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.downloadSpeed).toBeUndefined();
    });

    it('requests download_rate in TORRENT_STATUS_KEYS', async () => {
      const capturedKeys: string[][] = [];
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': (params) => {
          capturedKeys.push(params[1] as string[]);
          return mockTorrentStatus;
        },
      }));

      await client.getDownload('abc123def456');
      expect(capturedKeys[0]).toContain('download_rate');
    });

    it('maps Seeding + is_finished=true to completed', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Seeding', is_finished: true }),
      }));

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('completed');
    });

    it('maps Seeding + is_finished=false to downloading', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Seeding', is_finished: false }),
      }));

      const result = await client.getDownload('abc123');
      expect(result!.status).toBe('downloading');
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: body.id, result: true, error: null });
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

  describe('state mapping — is_finished and Moving', () => {
    it('returns completed when is_finished=true and state is not Checking or Moving', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Seeding', is_finished: true }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('completed');
    });

    it('returns downloading when is_finished=true and state is Checking', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Checking', is_finished: true }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns downloading when is_finished=true and state is Moving', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Moving', is_finished: true }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns downloading when is_finished=false and state is Seeding', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Seeding', is_finished: false }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns downloading when state is Moving (files being relocated)', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Moving', is_finished: false }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns error when state is Error', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Error', is_finished: false }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('error');
    });

    it('returns paused when state is Paused', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Paused', is_finished: false }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('paused');
    });

    it('returns downloading when state is Queued', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, state: 'Queued', is_finished: false }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });
  });

  describe('schema validation', () => {
    it('throws DownloadClientError when RPC envelope has neither result nor error', async () => {
      server.use(http.post(`${BASE_URL}/json`, async ({ request }) => {
        const body = await request.json() as { method: string };
        if (body.method === 'auth.login') {
          return HttpResponse.json({ id: 1, result: true, error: null });
        }
        if (body.method === 'web.connected') {
          return HttpResponse.json({ id: 3, result: true, error: null });
        }
        // Malformed envelope: no `result` property at all and no error
        return HttpResponse.json({ id: 2 });
      }));

      const err = await client.getAllDownloads().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError when torrent-status response is missing required keys', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ name: 'half', state: 'Downloading' }),
      }));

      const err = await client.getDownload('abc123def456').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('passes through unknown extra fields in torrent-status', async () => {
      server.use(rpcHandler({
        'auth.login': () => true,
        'core.get_torrent_status': () => ({ ...mockTorrentStatus, futureField: 'x' }),
      }));

      const result = await client.getDownload('abc123def456');
      expect(result?.id).toBe('abc123def456');
    });
  });
});
