import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { TransmissionClient } from './transmission.js';
import type { DownloadArtifact } from './types.js';


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
  leftUntilDone: 500000,
};

function magnetArtifact(uri: string, infoHash: string): DownloadArtifact {
  return { type: 'magnet-uri', uri, infoHash };
}

function torrentBytesArtifact(data: Buffer = Buffer.from('fake'), infoHash = 'fakehash123'): DownloadArtifact {
  return { type: 'torrent-bytes', data, infoHash };
}

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

    it('retries once when 409 lacks X-Transmission-Session-Id header, second 409 throws', async () => {
      let callCount = 0;
      server.use(
        http.post(RPC_URL, () => {
          callCount++;
          return new HttpResponse(null, { status: 409 });
        }),
      );

      const result = await client.test();
      expect(callCount).toBe(2);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Session ID rotation failed: repeated 409');
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
    it('sends torrent-add RPC with magnet URI and returns hash', async () => {
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

      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123def456', 'abc123def456');
      const hash = await client.addDownload(artifact);
      expect(hash).toBe('abc123def456');
      expect(capturedBody).toMatchObject({
        method: 'torrent-add',
        arguments: { filename: 'magnet:?xt=urn:btih:abc123def456' },
      });
    });

    it('sends torrent-add RPC with torrent bytes as metainfo', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const torrentData = Buffer.from('fake-torrent-data');
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

      const artifact = torrentBytesArtifact(torrentData, 'abc123def456');
      const hash = await client.addDownload(artifact);
      expect(hash).toBe('abc123def456');
      expect(capturedBody).toMatchObject({
        method: 'torrent-add',
        arguments: { metainfo: torrentData.toString('base64') },
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

      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123def456', 'abc123def456');
      const hash = await client.addDownload(artifact);
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

      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123', 'abc123');
      await client.addDownload(artifact, {
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

      const artifact = magnetArtifact('magnet:?xt=urn:btih:abc123', 'abc123');
      await expect(client.addDownload(artifact)).rejects.toThrow(
        'Could not extract torrent hash',
      );
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

    it('throws on malformed RPC response', async () => {
      server.use(
        http.post(RPC_URL, async () => {
          return HttpResponse.json(
            'not-an-object',
            { headers: { 'X-Transmission-Session-Id': SESSION_ID, 'content-type': 'application/json' } },
          );
        }),
      );

      await expect(client.getDownload('abc123')).rejects.toThrow('unexpected response');
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
      [0, 0, 'completed'],
      [1, 500000, 'downloading'],
      [2, 500000, 'downloading'],
      [3, 500000, 'downloading'],
      [4, 500000, 'downloading'],
      [5, 0, 'seeding'],
      [6, 0, 'seeding'],
    ] as const)('maps Transmission status %d (leftUntilDone=%d) to %s', async (statusCode, leftUntilDone, expectedStatus) => {
      server.use(rpcHandler('torrent-get', { torrents: [{ ...mockTorrent, status: statusCode, leftUntilDone }] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe(expectedStatus);
    });

    it('maps unknown status to downloading (fallback)', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [{ ...mockTorrent, status: 99 }] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });
  });

  describe('getCategories', () => {
    it('returns empty array (no native category support)', async () => {
      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('has supportsCategories = false', () => {
      expect(client.supportsCategories).toBe(false);
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

      const artifact = magnetArtifact('magnet:?xt=urn:btih:ABC123', 'abc123');
      const hash = await client.addDownload(artifact);
      expect(hash).toBe('abc123def456');
    });
  });

  describe('leftUntilDone completion and errorString', () => {
    it('returns completed when leftUntilDone=0 and status=Stopped(0)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, status: 0, leftUntilDone: 0, percentDone: 1.0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('completed');
    });

    it('returns seeding when leftUntilDone=0 and status=Seeding(6)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, status: 6, leftUntilDone: 0, percentDone: 1.0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('seeding');
    });

    it('returns seeding when leftUntilDone=0 and status=SeedingWait(5)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, status: 5, leftUntilDone: 0, percentDone: 1.0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('seeding');
    });

    it('returns downloading when leftUntilDone > 0 and status=Downloading(4)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, status: 4, leftUntilDone: 500000 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns downloading when totalSize=0 (no metadata)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, totalSize: 0, leftUntilDone: 0, status: 4 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('downloading');
    });

    it('returns error when errorString is non-empty (regardless of other fields)', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, errorString: 'Tracker error: not registered', status: 6, leftUntilDone: 0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('error');
    });

    it('returns seeding when errorString is empty and leftUntilDone=0 and Seeding', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, errorString: '', status: 6, leftUntilDone: 0, percentDone: 1.0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('seeding');
    });

    it('detects completion via leftUntilDone=0 even when percentDone < 1.0', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, percentDone: 0.9999, status: 0, leftUntilDone: 0 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result!.status).toBe('completed');
    });
  });
});
