import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { QBittorrentClient } from './qbittorrent.js';
import { TransmissionClient } from './transmission.js';
import { DelugeClient } from './deluge.js';
import { BlackholeClient } from './blackhole.js';
import { writeFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
  };
});

const fakeTorrentFile = Buffer.from('d8:announce35:http://tracker.example.com/announce4:infod6:lengthi12345e4:name8:test.txte');

// Torrent where an earlier string value contains '4:info' bytes before the real info key
const fakeTorrentWithInfoInString = Buffer.from(
  'd7:comment26:tracker says: see 4:infod8:announce35:http://tracker.example.com/announce4:infod6:lengthi12345e4:name8:test.txte',
);

describe('Torrent file handoff — data: URI pipeline', () => {
  const server = useMswServer();

  describe('qBittorrent — torrentFile handling', () => {
    const qbConfig = { host: 'localhost', port: 8080, username: 'admin', password: 'pass', useSsl: false };
    const QB_BASE = 'http://localhost:8080';

    function qbLoginHandler() {
      return http.post(`${QB_BASE}/api/v2/auth/login`, () => {
        return new HttpResponse('Ok.', {
          headers: { 'Set-Cookie': 'SID=test-sid; path=/' },
        });
      });
    }

    it('uses multipart file upload when torrentFile provided', async () => {
      let capturedContentType = '';
      let bodyContainsTorrent = false;

      server.use(
        qbLoginHandler(),
        http.post(`${QB_BASE}/api/v2/torrents/add`, async ({ request }) => {
          capturedContentType = request.headers.get('content-type') || '';
          const text = await request.text();
          bodyContainsTorrent = text.includes('application/x-bittorrent');
          return new HttpResponse('Ok.');
        }),
      );

      const client = new QBittorrentClient(qbConfig);
      const hash = await client.addDownload('unused-url', { torrentFile: fakeTorrentFile });

      expect(capturedContentType).toContain('multipart/form-data');
      expect(bodyContainsTorrent).toBe(true);
      expect(hash).toBe('e4c4ed54fbde46fb891a9ef51a368f7cde76eb74');
    });

    it('extracts correct info hash when 4:info appears in earlier string payload', async () => {
      let capturedContentType = '';

      server.use(
        qbLoginHandler(),
        http.post(`${QB_BASE}/api/v2/torrents/add`, async ({ request }) => {
          capturedContentType = request.headers.get('content-type') || '';
          return new HttpResponse('Ok.');
        }),
      );

      const client = new QBittorrentClient(qbConfig);
      const hash = await client.addDownload('unused-url', { torrentFile: fakeTorrentWithInfoInString });

      expect(capturedContentType).toContain('multipart/form-data');
      // Should produce the same info hash since the info dict is identical
      expect(hash).toBe('e4c4ed54fbde46fb891a9ef51a368f7cde76eb74');
    });

    it('uses existing magnet-only path when torrentFile not provided', async () => {
      server.use(
        qbLoginHandler(),
        http.post(`${QB_BASE}/api/v2/torrents/add`, () => {
          return new HttpResponse('');
        }),
      );

      const client = new QBittorrentClient(qbConfig);
      const magnet = 'magnet:?xt=urn:btih:a94a8fe5ccb19ba61c4c0873d391e987982fbbd3&dn=test';
      const hash = await client.addDownload(magnet);
      expect(hash).toBe('a94a8fe5ccb19ba61c4c0873d391e987982fbbd3');
    });

    it('rejects non-magnet URL when torrentFile not provided', async () => {
      server.use(qbLoginHandler());

      const client = new QBittorrentClient(qbConfig);
      await expect(client.addDownload('https://example.com/file.torrent'))
        .rejects.toThrow('only supports magnet URIs');
    });
  });

  describe('Transmission — torrentFile handling', () => {
    const trConfig = { host: 'localhost', port: 9091, username: 'admin', password: 'pass', useSsl: false };
    const TR_BASE = 'http://localhost:9091';
    const RPC_URL = `${TR_BASE}/transmission/rpc`;
    const SESSION_ID = 'test-session';

    it('uses metainfo base64 parameter when torrentFile provided', async () => {
      let capturedMetainfo = '';

      server.use(
        http.post(RPC_URL, async ({ request }) => {
          const body = await request.json() as { method: string; arguments: Record<string, unknown> };
          if (body.method === 'torrent-add') {
            capturedMetainfo = body.arguments.metainfo as string;
            return HttpResponse.json(
              { result: 'success', arguments: { 'torrent-added': { hashString: 'abc123' } } },
              { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
            );
          }
          return HttpResponse.json(
            { result: 'success', arguments: {} },
            { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
          );
        }),
      );

      const client = new TransmissionClient(trConfig);
      const hash = await client.addDownload('unused', { torrentFile: fakeTorrentFile });
      expect(hash).toBe('abc123');
      expect(capturedMetainfo).toBe(fakeTorrentFile.toString('base64'));
    });

    it('uses existing URL path when torrentFile not provided', async () => {
      let capturedFilename = '';

      server.use(
        http.post(RPC_URL, async ({ request }) => {
          const body = await request.json() as { method: string; arguments: Record<string, unknown> };
          if (body.method === 'torrent-add') {
            capturedFilename = body.arguments.filename as string;
            return HttpResponse.json(
              { result: 'success', arguments: { 'torrent-added': { hashString: 'def456' } } },
              { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
            );
          }
          return HttpResponse.json(
            { result: 'success', arguments: {} },
            { headers: { 'X-Transmission-Session-Id': SESSION_ID } },
          );
        }),
      );

      const client = new TransmissionClient(trConfig);
      const magnetUrl = 'magnet:?xt=urn:btih:abc123';
      const hash = await client.addDownload(magnetUrl);
      expect(hash).toBe('def456');
      expect(capturedFilename).toBe(magnetUrl);
    });
  });

  describe('Deluge — torrentFile handling', () => {
    const delugeConfig = { host: 'localhost', port: 8112, password: 'deluge', useSsl: false };
    const DELUGE_BASE = 'http://localhost:8112';

    function delugeHandler() {
      return http.post(`${DELUGE_BASE}/json`, async ({ request }) => {
        const body = await request.json() as { method: string; params: unknown[]; id: number };

        if (body.method === 'auth.login') {
          return HttpResponse.json(
            { id: body.id, result: true, error: null },
            { headers: { 'Set-Cookie': '_session_id=test; path=/' } },
          );
        }
        if (body.method === 'core.add_torrent_file') {
          return HttpResponse.json({ id: body.id, result: 'hash-from-file', error: null });
        }
        if (body.method === 'core.add_torrent_magnet') {
          return HttpResponse.json({ id: body.id, result: 'hash-from-magnet', error: null });
        }
        return HttpResponse.json({ id: body.id, result: null, error: null });
      });
    }

    it('uses add_torrent_file RPC when torrentFile provided', async () => {
      let capturedMethod = '';
      let capturedParams: unknown[] = [];

      server.use(
        http.post(`${DELUGE_BASE}/json`, async ({ request }) => {
          const body = await request.json() as { method: string; params: unknown[]; id: number };
          if (body.method === 'auth.login') {
            return HttpResponse.json(
              { id: body.id, result: true, error: null },
              { headers: { 'Set-Cookie': '_session_id=test; path=/' } },
            );
          }
          capturedMethod = body.method;
          capturedParams = body.params;
          return HttpResponse.json({ id: body.id, result: 'torrent-hash-123', error: null });
        }),
      );

      const client = new DelugeClient(delugeConfig);
      const hash = await client.addDownload('unused', { torrentFile: fakeTorrentFile });
      expect(hash).toBe('torrent-hash-123');
      expect(capturedMethod).toBe('core.add_torrent_file');
      expect(capturedParams[0]).toBe('upload.torrent');
      expect(capturedParams[1]).toBe(fakeTorrentFile.toString('base64'));
    });

    it('uses existing magnet path when torrentFile not provided', async () => {
      server.use(delugeHandler());

      const client = new DelugeClient(delugeConfig);
      const hash = await client.addDownload('magnet:?xt=urn:btih:abc');
      expect(hash).toBe('hash-from-magnet');
    });
  });

  describe('Blackhole — torrentFile handling', () => {
    it('writes bytes directly to watch directory when torrentFile provided', async () => {
      const client = new BlackholeClient({ watchDir: '/tmp/watch', protocol: 'torrent' });
      await client.addDownload('unused-url', { torrentFile: fakeTorrentFile });

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/[/\\]tmp[/\\]watch[/\\]download-/),
        fakeTorrentFile,
      );
    });

    it('uses existing fetch-and-write path when torrentFile not provided', async () => {
      server.use(
        http.get('https://example.com/file.torrent', () => {
          return new HttpResponse(Buffer.from('torrent-content'), {
            headers: { 'Content-Type': 'application/x-bittorrent' },
          });
        }),
      );

      const client = new BlackholeClient({ watchDir: '/tmp/watch', protocol: 'torrent' });
      await client.addDownload('https://example.com/file.torrent');

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/[/\\]tmp[/\\]watch[/\\]file\.torrent$/),
        expect.any(Buffer),
      );
    });
  });
});
