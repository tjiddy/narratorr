import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { transmissionSelects, type TransmissionIdentifiable } from '../__tests__/download-client-id-semantics.js';
import { ZodError } from 'zod';
import { TransmissionClient } from './transmission.js';
import { DownloadClientError } from './errors.js';
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

type RpcBody = { method: string; arguments?: Record<string, unknown> };

/**
 * Routes `torrent-get`'s `ids` through the shared Transmission selection model, so an OMITTED
 * `ids` serves the WIDENING answer a missing guard would exploit rather than a convenient empty
 * list. The pre-#2488 handler answered a fixed `torrents` array regardless of `ids` and was
 * structurally unable to see this class of defect ([[shared-test-double-defaults]]).
 */
function rpcHandler(expectedMethod?: string, responseArgs?: Record<string, unknown>) {
  return http.post(RPC_URL, async ({ request }) => {
    const body = (await request.json()) as RpcBody;
    if (expectedMethod && body.method !== expectedMethod) {
      return HttpResponse.json({ result: 'error', arguments: {} });
    }
    return HttpResponse.json(
      { result: 'success', arguments: selectTorrents(body, responseArgs) },
      { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
    );
  });
}

function selectTorrents(body: RpcBody, responseArgs?: Record<string, unknown>): Record<string, unknown> {
  if (body.method !== 'torrent-get' || !responseArgs) return responseArgs || {};
  const torrents = responseArgs.torrents as readonly TransmissionIdentifiable[];
  return { ...responseArgs, torrents: transmissionSelects(body.arguments?.ids, torrents) };
}

/**
 * Serves `responseArgs` verbatim and makes NO id decision — for envelope- and parser-level cases
 * whose payload is deliberately malformed and therefore cannot carry an identity to select on.
 */
function rawRpcHandler(expectedMethod: string, responseArgs: Record<string, unknown>) {
  return http.post(RPC_URL, async ({ request }) => {
    const body = (await request.json()) as RpcBody;
    if (body.method !== expectedMethod) {
      return HttpResponse.json({ result: 'error', arguments: {} });
    }
    return HttpResponse.json(
      { result: 'success', arguments: responseArgs },
      { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
    );
  });
}

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

    it('returns failure when session-get version is non-string (number)', async () => {
      server.use(rpcHandler('session-get', { version: 123 }));

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('unexpected session-get response');
    });

    it('returns success with fallback name when session-get version is null', async () => {
      server.use(rpcHandler('session-get', { version: null }));

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected to Transmission');
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

    it('leaves downloadSpeed undefined (deferred — see #655 out-of-scope note)', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [mockTorrent] }));

      const result = await client.getDownload('abc123def456');
      expect(result!.downloadSpeed).toBeUndefined();
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
      expect(results[0]!.id).toBe('abc123def456');
      expect(results[1]!.id).toBe('def789');
    });

    it('filters by category via downloadDir', async () => {
      const audiobook = { ...mockTorrent, downloadDir: '/downloads/audiobooks' };
      const other = { ...mockTorrent, hashString: 'other', downloadDir: '/downloads/music' };
      server.use(rpcHandler('torrent-get', { torrents: [audiobook, other] }));

      const results = await client.getAllDownloads('audiobooks');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('abc123def456');
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
    it('throws DownloadClientError when torrents is null (not an array)', async () => {
      server.use(rawRpcHandler('torrent-get', { torrents: null }));

      await expect(client.getDownload('abc123')).rejects.toThrow(/Transmission returned unexpected torrent data/);
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

    it('getAllDownloads treats a null arguments wrapper like an empty result', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.json(
            { result: 'success', arguments: null },
            { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
          );
        }),
      );

      const results = await client.getAllDownloads();
      expect(results).toEqual([]);
    });

    it('getAllDownloads handles empty torrents array', async () => {
      server.use(rpcHandler('torrent-get', { torrents: [] }));

      const results = await client.getAllDownloads();
      expect(results).toEqual([]);
    });

    it('uses HTTPS when useSsl is true', () => {
      const sslClient = new TransmissionClient({ ...config, useSsl: true });
      expect(sslClient.type).toBe('transmission');
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

  describe('schema validation', () => {
    it('throws DownloadClientError with ZodError cause when torrents is a string', async () => {
      server.use(rawRpcHandler('torrent-get', { torrents: 'not-an-array' as unknown as object }));

      const err = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      expect((err as DownloadClientError).cause).toBeInstanceOf(ZodError);
    });

    it('throws DownloadClientError when torrent item is missing hashString (mapTorrent field)', async () => {
      // A torrent with no hashString carries no identity to select on, so this stays raw.
      const { hashString: _, ...torrentMissingHash } = mockTorrent;
      server.use(rawRpcHandler('torrent-get', { torrents: [torrentMissingHash] }));

      const err = await client.getDownload('abc123').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      expect((err as DownloadClientError).cause).toBeInstanceOf(ZodError);
    });

    it('throws DownloadClientError when torrent item is missing leftUntilDone (mapStatus field)', async () => {
      const { leftUntilDone: _, ...torrentMissingLeft } = mockTorrent;
      server.use(rpcHandler('torrent-get', { torrents: [torrentMissingLeft] }));

      // The id must match the fixture's hashString, or the double answers [] and never parses.
      const err = await client.getDownload(mockTorrent.hashString).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      expect((err as DownloadClientError).cause).toBeInstanceOf(ZodError);
    });

    it('preserves cause from envelope-level result: error response', async () => {
      server.use(http.post(RPC_URL, () => HttpResponse.json({ result: 'session-broken' }, {
        headers: { 'X-Transmission-Session-Id': SESSION_ID },
      })));

      await expect(client.getDownload('abc123')).rejects.toThrow(DownloadClientError);
    });

    it('passes through unknown extra fields and still maps successfully', async () => {
      server.use(rpcHandler('torrent-get', {
        torrents: [{ ...mockTorrent, futureField: 'unknown', anotherNew: 42 }],
      }));

      const result = await client.getDownload('abc123def456');
      expect(result?.id).toBe('abc123def456');
    });

    it('test() returns success: false when version-get response is malformed', async () => {
      server.use(http.post(RPC_URL, () => HttpResponse.json({ result: 'not-success-not-error', extra: null }, {
        headers: { 'X-Transmission-Session-Id': SESSION_ID },
      })));

      const result = await client.test();
      expect(result.success).toBe(false);
    });
  });

  /**
   * #2488 — `downloads.external_id` is nullable text and every server-side caller guards on FALSY,
   * so a whitespace-only id is truthy and reaches this adapter. Transmission's `ids` is a
   * per-element lookup and an OMITTED `ids` means EVERY torrent (rpc-spec.md §3.1), which puts
   * `torrent-remove` + `delete-local-data` one dropped key away from the whole session. The guard
   * refuses ahead of request construction, so the body is structurally impossible to build.
   *
   * The observable is the RPC COUNT and the body contents, never a param readback
   * ([[url-strips-trailing-query-whitespace]]).
   */
  describe('blank external-id refusal (#2488)', () => {
    const BLANKS = [
      ['empty', ''],
      ['spaces', '   '],
      ['tab', '\t'],
      ['newline', '\n '],
      ['mixed whitespace', ' \t\n '],
    ] as const;

    const unrelated = { ...mockTorrent, hashString: '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b', name: "Someone Else's Audiobook" };

    /**
     * Records every RPC the client sent and answers `torrent-get` through the shared model, so an
     * `ids`-less probe has a torrent to wrongly adopt or delete.
     */
    function trackRpc() {
      const bodies: RpcBody[] = [];
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          const body = (await request.json()) as RpcBody;
          bodies.push(body);
          return HttpResponse.json(
            { result: 'success', arguments: selectTorrents(body, { torrents: [mockTorrent, unrelated] }) },
            { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
          );
        }),
      );
      return {
        bodies,
        of: (method: string) => bodies.filter((b) => b.method === method),
      };
    }

    it.each(BLANKS)('getDownload returns null and issues zero RPCs for a %s id', async (_label, blank) => {
      const rpc = trackRpc();

      expect(await client.getDownload(blank)).toBeNull();

      expect(rpc.bodies).toEqual([]);
    });

    // A refusal must be free every time, not memoized or otherwise stateful.
    it('stays free on repeated blank calls', async () => {
      const rpc = trackRpc();

      expect(await client.getDownload('   ')).toBeNull();
      expect(await client.getDownload('   ')).toBeNull();

      expect(rpc.bodies).toEqual([]);
    });

    it.each([
      ['pauseDownload', 'torrent-stop'],
      ['resumeDownload', 'torrent-start'],
    ] as const)('%s throws a typed error and sends no %s', async (method, rpcMethod) => {
      const rpc = trackRpc();

      await expect(client[method]('   ')).rejects.toThrow(DownloadClientError);

      expect(rpc.of(rpcMethod)).toEqual([]);
      expect(rpc.bodies).toEqual([]);
    });

    it.each(BLANKS)('removeDownload(%s, true) throws and sends no destructive torrent-remove', async (_label, blank) => {
      const rpc = trackRpc();

      await expect(client.removeDownload(blank, true)).rejects.toThrow(DownloadClientError);

      expect(rpc.of('torrent-remove')).toEqual([]);
      expect(rpc.bodies).toEqual([]);
    });

    it('removeDownload refuses the default deleteFiles arm too', async () => {
      const rpc = trackRpc();

      await expect(client.removeDownload('   ')).rejects.toThrow(DownloadClientError);

      expect(rpc.bodies).toEqual([]);
    });

    it('names the blank stored external ID so an operator can repair the record', async () => {
      trackRpc();

      const error = await client.removeDownload('', true).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toMatch(/blank/i);
      expect((error as DownloadClientError).message).toMatch(/external id/i);
    });

    /**
     * Positive controls for the absence assertions above: an empty `bodies` array otherwise proves
     * only that the handler was never wired ([[vacuous-assertion-observation-points]]).
     */
    it.each([
      ['torrent-stop', (c: TransmissionClient) => c.pauseDownload(mockTorrent.hashString)],
      ['torrent-start', (c: TransmissionClient) => c.resumeDownload(mockTorrent.hashString)],
      ['torrent-remove', (c: TransmissionClient) => c.removeDownload(mockTorrent.hashString, true)],
    ] as const)('control: the same tracker collects one %s for a valid id', async (rpcMethod, call) => {
      const rpc = trackRpc();

      await call(client);

      expect(rpc.of(rpcMethod)).toHaveLength(1);
      expect(rpc.of(rpcMethod)[0]!.arguments?.ids).toEqual([mockTorrent.hashString]);
    });

    it('control: the same tracker serves the torrent for a valid read', async () => {
      const rpc = trackRpc();

      expect((await client.getDownload(mockTorrent.hashString))!.id).toBe(mockTorrent.hashString);

      expect(rpc.of('torrent-get')).toHaveLength(1);
    });

    /**
     * The boundary that separates "blank" from "unresolvable": this is a blankness guard, not hash
     * format validation, so non-blank garbage keeps taking the normal RPC path (#2485 kept 'a' live
     * on qBittorrent for the same reason).
     */
    it.each([['a'], ['0'], ['12abc']])('takes the normal RPC path for non-blank garbage %s', async (garbage) => {
      const rpc = trackRpc();

      expect(await client.getDownload(garbage)).toBeNull();

      expect(rpc.of('torrent-get')).toHaveLength(1);
      expect(rpc.of('torrent-get')[0]!.arguments?.ids).toEqual([garbage]);
    });

    it('sends the TRIMMED value for a padded valid hash and resolves it like its trimmed form', async () => {
      const rpc = trackRpc();

      expect((await client.getDownload(`  ${mockTorrent.hashString}  `))!.id).toBe(mockTorrent.hashString);

      expect(rpc.of('torrent-get')[0]!.arguments?.ids).toEqual([mockTorrent.hashString]);
    });

    it.each([
      ['torrent-stop', (c: TransmissionClient) => c.pauseDownload(`  ${mockTorrent.hashString}  `)],
      ['torrent-remove', (c: TransmissionClient) => c.removeDownload(`  ${mockTorrent.hashString}  `, true)],
    ] as const)('sends the trimmed value on %s for a padded valid hash', async (rpcMethod, call) => {
      const rpc = trackRpc();

      await call(client);

      expect(rpc.of(rpcMethod)[0]!.arguments?.ids).toEqual([mockTorrent.hashString]);
    });

    it('leaves the blank call out of a race with a valid resolution', async () => {
      const rpc = trackRpc();

      const [blank, valid] = await Promise.all([
        client.getDownload('   '),
        client.getDownload(mockTorrent.hashString),
      ]);

      expect(blank).toBeNull();
      expect(valid!.id).toBe(mockTorrent.hashString);
      // Exactly the valid call's own request, and nothing from the blank one.
      expect(rpc.bodies).toHaveLength(1);
    });
  });
});
