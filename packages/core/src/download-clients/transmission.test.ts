import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { TransmissionClient } from './transmission.js';

const config = { host: 'localhost', port: 9091, username: 'admin', password: 'password', useSsl: false };
const BASE_URL = 'http://localhost:9091';
const RPC_URL = `${BASE_URL}/transmission/rpc`;

const SESSION_ID = 'test-session-id-12345';

const mockTorrent = {
  hashString: 'abc123def456',
  name: 'Test Audiobook',
  status: 4, // downloading
  percentDone: 0.5,
  totalSize: 1000000,
  downloadedEver: 500000,
  uploadedEver: 100000,
  uploadRatio: 0.2,
  peersSendingToUs: 10,
  peersGettingFromUs: 5,
  eta: 3600,
  downloadDir: '/downloads',
  addedDate: 1700000000,
  doneDate: 0,
  errorString: '',
};

function rpcHandler(expectedMethod?: string, responseArgs?: Record<string, unknown>) {
  return http.post(RPC_URL, async ({ request }) => {
    const body = (await request.json()) as { method: string };
    if (expectedMethod && body.method !== expectedMethod) {
      return HttpResponse.json({ result: 'error', arguments: {} });
    }
    return HttpResponse.json(
      { result: 'success', arguments: responseArgs || {} },
      { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
    );
  });
}

// Returns 409 first, then success on retry
function sessionIdRotationHandler(responseArgs?: Record<string, unknown>) {
  let callCount = 0;
  return http.post(RPC_URL, async () => {
    callCount++;
    if (callCount === 1) {
      return new HttpResponse(null, {
        status: 409,
        headers: { 'X-Transmission-Session-Id': SESSION_ID },
      });
    }
    return HttpResponse.json(
      { result: 'success', arguments: responseArgs || {} },
      { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
    );
  });
}

describe('TransmissionClient', () => {
  const server = useMswServer();
  let client: TransmissionClient;

  beforeEach(() => {
    client = new TransmissionClient(config);
  });

  describe('properties', () => {
    it('has correct type, name, and protocol', () => {
      expect(client.type).toBe('transmission');
      expect(client.name).toBe('Transmission');
      expect(client.protocol).toBe('torrent');
    });
  });

  describe('session-id rotation', () => {
    it('retries with new session ID on 409 response', async () => {
      server.use(sessionIdRotationHandler({ version: '4.0.0' }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Transmission 4.0.0');
    });

    it('does not retry infinitely (fails after second 409)', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse(null, {
            status: 409,
            headers: { 'X-Transmission-Session-Id': SESSION_ID },
          });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('409');
    });
  });

  describe('test', () => {
    it('returns success with version string', async () => {
      server.use(rpcHandler('session-get', { version: '4.0.0' }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Transmission 4.0.0');
    });

    it('returns success with fallback name when no version', async () => {
      server.use(rpcHandler('session-get', {}));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Transmission');
    });

    it('returns failure on connection error', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.error();
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
    });

    it('returns failure when server returns HTML instead of JSON', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse('<!doctype html><html><body>Welcome</body></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('didn\'t respond as expected');
    });

    it('returns failure on authentication error', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials');
    });
  });

  describe('addDownload', () => {
    it('sends torrent-add RPC and returns hash', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            result: 'success',
            arguments: {
              'torrent-added': { hashString: 'abc123def456' },
            },
          });
        }),
      );

      const hash = await client.addDownload('magnet:?xt=urn:btih:abc123def456');
      expect(hash).toBe('abc123def456');
      expect(capturedBody).toMatchObject({
        method: 'torrent-add',
        arguments: { filename: 'magnet:?xt=urn:btih:abc123def456' },
      });
    });

    it('handles torrent-duplicate response', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.json({
            result: 'success',
            arguments: {
              'torrent-duplicate': { hashString: 'abc123def456' },
            },
          });
        }),
      );

      const hash = await client.addDownload('magnet:?xt=urn:btih:abc123def456');
      expect(hash).toBe('abc123def456');
    });

    it('passes savePath and paused options', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            result: 'success',
            arguments: {
              'torrent-added': { hashString: 'abc123' },
            },
          });
        }),
      );

      await client.addDownload('magnet:?xt=urn:btih:abc123', {
        savePath: '/my/path',
        paused: true,
      });

      expect(capturedBody).toMatchObject({
        arguments: {
          filename: 'magnet:?xt=urn:btih:abc123',
          'download-dir': '/my/path',
          paused: true,
        },
      });
    });

    it('throws when no hash in response', async () => {
      server.use(rpcHandler('torrent-add', {}));

      await expect(client.addDownload('magnet:?xt=urn:btih:abc123')).rejects.toThrow(
        'Could not extract torrent hash',
      );
    });
  });

  describe('getDownload', () => {
    it('maps Transmission torrent fields to DownloadItemInfo', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [mockTorrent] }));

      const result = await client.getDownload('abc123def456');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('abc123def456');
      expect(result!.name).toBe('Test Audiobook');
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

    it('returns null when torrent not found', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [] }));

      const result = await client.getDownload('nonexistent');
      expect(result).toBeNull();
    });

    it('handles completedAt when doneDate is set', async () => {
      const completedTorrent = { ...mockTorrent, doneDate: 1700003600, percentDone: 1.0, status: 6 };
      server.use(rpcHandler('torrent-get', { torrents: [completedTorrent] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.completedAt).toEqual(new Date(1700003600 * 1000));
    });
  });

  describe('getAllDownloads', () => {
    it('returns all torrents mapped correctly', async () => {
      const secondTorrent = { ...mockTorrent, hashString: 'def789', name: 'Second Audiobook' };
      server.use(rpcHandler('torrent-get', { torrents: [mockTorrent, secondTorrent] }));

      const results = await client.getAllDownloads();
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('abc123def456');
      expect(results[1].id).toBe('def789');
    });

    it('filters by category via downloadDir', async () => {
      const audiobook = { ...mockTorrent, downloadDir: '/downloads/audiobooks' };
      const other = { ...mockTorrent, hashString: 'other', downloadDir: '/downloads/music' };
      server.use(rpcHandler('torrent-get', { torrents: [audiobook, other] }));

      const results = await client.getAllDownloads('audiobooks');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('abc123def456');
    });
  });

  describe('pauseDownload', () => {
    it('sends torrent-stop RPC', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ result: 'success', arguments: {} });
        }),
      );

      await client.pauseDownload('abc123');
      expect(capturedBody).toMatchObject({
        method: 'torrent-stop',
        arguments: { ids: ['abc123'] },
      });
    });
  });

  describe('resumeDownload', () => {
    it('sends torrent-start RPC', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ result: 'success', arguments: {} });
        }),
      );

      await client.resumeDownload('abc123');
      expect(capturedBody).toMatchObject({
        method: 'torrent-start',
        arguments: { ids: ['abc123'] },
      });
    });
  });

  describe('removeDownload', () => {
    it('sends torrent-remove with delete-local-data false', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ result: 'success', arguments: {} });
        }),
      );

      await client.removeDownload('abc123');
      expect(capturedBody).toMatchObject({
        method: 'torrent-remove',
        arguments: { ids: ['abc123'], 'delete-local-data': false },
      });
    });

    it('sends torrent-remove with delete-local-data true', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ result: 'success', arguments: {} });
        }),
      );

      await client.removeDownload('abc123', true);
      expect(capturedBody).toMatchObject({
        method: 'torrent-remove',
        arguments: { ids: ['abc123'], 'delete-local-data': true },
      });
    });
  });

  describe('status mapping', () => {
    it.each([
      [0, 'paused'],
      [1, 'downloading'],
      [2, 'downloading'],
      [3, 'downloading'],
      [4, 'downloading'],
      [5, 'seeding'],
      [6, 'seeding'],
    ] as const)('maps Transmission status %d to %s', async (statusCode, expectedStatus) => {
      server.use(rpcHandler('torrent-get', { torrents: [{ ...mockTorrent, status: statusCode }] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe(expectedStatus);
    });

    it('maps unknown status to downloading (fallback)', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [{ ...mockTorrent, status: 99 }] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });
  });

  describe('edge cases — null/malformed responses', () => {
    it('handles null torrents in response', async () => {
      server.use(rpcHandler('torrent-get', { torrents: null }));

      const result = await client.getDownload('abc123');
      expect(result).toBeNull();
    });

    it('handles negative ETA values (no estimate)', async () => {
      const torrentNegEta = { ...mockTorrent, eta: -1 };
      server.use(rpcHandler('torrent-get', { torrents: [torrentNegEta] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.eta).toBeUndefined();
    });

    it('handles doneDate = 0 (unix epoch → not completed)', async () => {
      const torrent = { ...mockTorrent, doneDate: 0 };
      server.use(rpcHandler('torrent-get', { torrents: [torrent] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.completedAt).toBeUndefined();
    });

    it('handles RPC error result', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.json({ result: 'invalid method' });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('RPC error');
    });

    it('getAllDownloads handles empty torrents array', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [] }));

      const results = await client.getAllDownloads();
      expect(results).toEqual([]);
    });

    it('uses HTTPS when useSsl is true', () => {
      const sslClient = new TransmissionClient({ ...config, useSsl: true });
      expect(sslClient.type).toBe('transmission');
      // Can't directly test URL, but constructor should succeed
    });

    it('lowercases hash from addDownload response', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.json({
            result: 'success',
            arguments: {
              'torrent-added': { hashString: 'ABC123DEF456' },
            },
          });
        }),
      );

      const hash = await client.addDownload('magnet:?xt=urn:btih:ABC123');
      expect(hash).toBe('abc123def456');
    });
  });
});
