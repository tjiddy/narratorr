import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { SABnzbdClient } from './sabnzbd.js';
import type { DownloadArtifact } from './types.js';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError } from './errors.js';

const API_BASE = 'http://localhost:8080';
const API_KEY = 'testapikey';

const queueSlot = {
  nzo_id: 'SABnzbd_nzo_abc123',
  filename: 'The Way of Kings',
  status: 'Downloading',
  mb: '1024.00',
  mbleft: '512.00',
  percentage: '50',
  timeleft: '0:30:00',
  cat: 'audiobooks',
  storage: '/downloads/complete/The Way of Kings',
};

const historySlot = {
  nzo_id: 'SABnzbd_nzo_def456',
  name: 'Words of Radiance',
  status: 'Completed',
  bytes: 2147483648,
  download_time: 3600,
  completed: 1704110400, // 2024-01-01 12:00:00 UTC
  category: 'audiobooks',
  storage: '/downloads/complete/Words of Radiance',
  fail_message: '',
};

function nzbUrl(url: string): DownloadArtifact {
  return { type: 'nzb-url', url };
}

describe('SABnzbdClient', () => {
  const server = useMswServer();
  let client: SABnzbdClient;

  beforeEach(() => {
    client = new SABnzbdClient({
      host: 'localhost',
      port: 8080,
      apiKey: API_KEY,
      useSsl: false,
    });
  });

  describe('properties', () => {
    it('has correct type, name, and protocol', () => {
      expect(client.type).toBe('sabnzbd');
      expect(client.name).toBe('SABnzbd');
      expect(client.protocol).toBe('usenet');
    });
  });

  describe('addDownload', () => {
    it('sends NZB URL and returns nzo_id', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            status: true,
            nzo_ids: ['SABnzbd_nzo_new123'],
          });
        }),
      );

      const id = await client.addDownload(
        nzbUrl('https://indexer.test/getnzb/abc.nzb?apikey=test'),
      );

      expect(id).toBe('SABnzbd_nzo_new123');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('mode')).toBe('addurl');
      expect(url.searchParams.get('name')).toBe(
        'https://indexer.test/getnzb/abc.nzb?apikey=test',
      );
      expect(url.searchParams.get('apikey')).toBe(API_KEY);
      expect(url.searchParams.get('output')).toBe('json');
    });

    it('sends category when provided', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            status: true,
            nzo_ids: ['SABnzbd_nzo_new123'],
          });
        }),
      );

      await client.addDownload(nzbUrl('https://indexer.test/nzb'), {
        category: 'audiobooks',
      });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('cat')).toBe('audiobooks');
    });

    it('sends paused priority when paused option set', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            status: true,
            nzo_ids: ['SABnzbd_nzo_new123'],
          });
        }),
      );

      await client.addDownload(nzbUrl('https://indexer.test/nzb'), { paused: true });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('priority')).toBe('-1');
    });

    it('throws on failed add', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.json({ status: false, nzo_ids: [] });
        }),
      );

      await expect(
        client.addDownload(nzbUrl('https://indexer.test/nzb')),
      ).rejects.toThrow('failed to add');
    });

    it('submits nzb-bytes artifact via multipart POST with mode=addlocalfile', async () => {
      let capturedUrl = '';
      let capturedContentType = '';
      server.use(
        http.post(`${API_BASE}/api`, async ({ request }) => {
          capturedUrl = request.url;
          capturedContentType = request.headers.get('content-type') ?? '';
          return HttpResponse.json({ status: true, nzo_ids: ['SABnzbd_nzo_bytes1'] });
        }),
      );

      const nzbData = Buffer.from('<nzb><file/></nzb>');
      const id = await client.addDownload({ type: 'nzb-bytes', data: nzbData });

      expect(id).toBe('SABnzbd_nzo_bytes1');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('mode')).toBe('addlocalfile');
      expect(url.searchParams.get('apikey')).toBe(API_KEY);
      expect(url.searchParams.get('output')).toBe('json');
      expect(capturedContentType).toContain('multipart/form-data');
    });

    it('multipart request body contains correct NZB content', async () => {
      let capturedBody: FormData | null = null;
      server.use(
        http.post(`${API_BASE}/api`, async ({ request }) => {
          capturedBody = await request.formData();
          return HttpResponse.json({ status: true, nzo_ids: ['SABnzbd_nzo_bytes2'] });
        }),
      );

      const nzbContent = '<nzb><file subject="test"/></nzb>';
      const nzbData = Buffer.from(nzbContent);
      await client.addDownload({ type: 'nzb-bytes', data: nzbData });

      expect(capturedBody).not.toBeNull();
      const file = capturedBody!.get('name') as File;
      expect(file).toBeInstanceOf(File);
      const fileText = await file.text();
      expect(fileText).toBe(nzbContent);
    });

    it('forwards category and priority options in multipart nzb-bytes request', async () => {
      let capturedUrl = '';
      server.use(
        http.post(`${API_BASE}/api`, async ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ status: true, nzo_ids: ['SABnzbd_nzo_bytes3'] });
        }),
      );

      const nzbData = Buffer.from('<nzb><file/></nzb>');
      await client.addDownload({ type: 'nzb-bytes', data: nzbData }, { category: 'audiobooks', paused: true });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('cat')).toBe('audiobooks');
      expect(url.searchParams.get('priority')).toBe('-1');
    });

    it('throws DownloadClientError when addlocalfile returns status: false', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => {
          return HttpResponse.json({ status: false, nzo_ids: [] });
        }),
      );

      const nzbData = Buffer.from('<nzb><file/></nzb>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toThrow('failed to add');
    });

    it('throws DownloadClientError when addlocalfile returns empty nzo_ids', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => {
          return HttpResponse.json({ status: true, nzo_ids: [] });
        }),
      );

      const nzbData = Buffer.from('<nzb><file/></nzb>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toThrow('failed to add');
    });

    it('rejects zero-length nzb-bytes with DownloadClientError before any network call', async () => {
      let requestMade = false;
      server.use(
        http.post(`${API_BASE}/api`, () => {
          requestMade = true;
          return HttpResponse.json({ status: true, nzo_ids: ['SABnzbd_nzo_empty'] });
        }),
      );

      const emptyBuffer = Buffer.alloc(0);
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: emptyBuffer }),
      ).rejects.toThrow(DownloadClientError);
      expect(requestMade).toBe(false);
    });

    it('throws DownloadClientAuthError on 401 multipart response', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 401, statusText: 'Unauthorized' });
        }),
      );

      const nzbData = Buffer.from('<nzb/>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toThrow(DownloadClientAuthError);
    });

    it('throws DownloadClientTimeoutError on multipart request timeout', async () => {
      server.use(
        http.post(`${API_BASE}/api`, async () => {
          await delay('infinite');
          return HttpResponse.json({ status: true, nzo_ids: ['SABnzbd_nzo_timeout'] });
        }),
      );

      const originalTimeout = AbortSignal.timeout;
      AbortSignal.timeout = () => AbortSignal.abort(new DOMException('The operation was aborted', 'TimeoutError'));

      const nzbData = Buffer.from('<nzb/>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toBeInstanceOf(DownloadClientTimeoutError);

      AbortSignal.timeout = originalTimeout;
    });

    it('throws DownloadClientError on non-OK multipart response', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
        }),
      );

      const nzbData = Buffer.from('<nzb/>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toThrow('HTTP 500');
    });

    it('throws DownloadClientError on non-JSON multipart response (proxy intercept)', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => {
          return new HttpResponse('<html>Login</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const nzbData = Buffer.from('<nzb/>');
      await expect(
        client.addDownload({ type: 'nzb-bytes', data: nzbData }),
      ).rejects.toThrow('reverse proxy');
    });

    it('rejects torrent artifact with usenet-only error', async () => {
      await expect(
        client.addDownload({ type: 'magnet-uri', uri: 'magnet:?xt=urn:btih:abc123', infoHash: 'abc123' }),
      ).rejects.toThrow('only supports usenet artifacts');
    });

    it('throws DownloadClientError with ZodError cause when nzo_ids is a string instead of array', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => HttpResponse.json({ status: true, nzo_ids: 'abc' })),
      );

      const err = await client
        .addDownload(nzbUrl('https://indexer.test/getnzb/abc.nzb'))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError with ZodError cause when add response is missing status field', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => HttpResponse.json({ nzo_ids: ['SABnzbd_nzo_x'] })),
      );

      const err = await client
        .addDownload(nzbUrl('https://indexer.test/getnzb/abc.nzb'))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError with ZodError cause when addlocalfile response is malformed', async () => {
      server.use(
        http.post(`${API_BASE}/api`, () => HttpResponse.json({ status: 'not-a-bool', nzo_ids: [] })),
      );

      const err = await client
        .addDownload({ type: 'nzb-bytes', data: Buffer.from('fake-nzb') })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });
  });

  describe('getDownload', () => {
    it('finds item in queue by nzo_id', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');

          if (mode === 'queue') {
            return HttpResponse.json({
              queue: { slots: [queueSlot] },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');

      expect(item).not.toBeNull();
      expect(item!.id).toBe('SABnzbd_nzo_abc123');
      expect(item!.name).toBe('The Way of Kings');
      expect(item!.progress).toBe(50);
      expect(item!.status).toBe('downloading');
      expect(item!.size).toBe(Math.round(1024 * 1024 * 1024));
      expect(item!.downloaded).toBe(Math.round(512 * 1024 * 1024));
    });

    it('finds item in history if not in queue', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          if (mode === 'history') {
            return HttpResponse.json({
              history: { slots: [historySlot] },
            });
          }
          return HttpResponse.json({});
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');

      expect(item).not.toBeNull();
      expect(item!.id).toBe('SABnzbd_nzo_def456');
      expect(item!.name).toBe('Words of Radiance');
      expect(item!.progress).toBe(100);
      expect(item!.status).toBe('completed');
      expect(item!.size).toBe(2147483648);
    });

    it('returns null for unknown ID', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('nonexistent');
      expect(item).toBeNull();
    });

    it('maps queue kbpersec to downloadSpeed in bytes/sec using binary KiB (* 1024)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode === 'queue') {
            return HttpResponse.json({
              queue: { slots: [{ ...queueSlot, kbpersec: '1024' }] },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      // SABnzbd computes kbpersec as bytes_per_sec / 1024, so reversing yields * 1024.
      expect(item!.downloadSpeed).toBe(1_048_576);
    });

    it('maps kbpersec="0" (stalled) to downloadSpeed=0, not undefined', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode === 'queue') {
            return HttpResponse.json({
              queue: { slots: [{ ...queueSlot, kbpersec: '0' }] },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.downloadSpeed).toBe(0);
    });

    it('leaves downloadSpeed undefined when kbpersec is absent', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [queueSlot] } });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.downloadSpeed).toBeUndefined();
    });

    it('leaves downloadSpeed undefined for history-only items (no rate in history)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          if (mode === 'history') {
            return HttpResponse.json({ history: { slots: [historySlot] } });
          }
          return HttpResponse.json({});
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.downloadSpeed).toBeUndefined();
    });

    it('sends limit=1000 on both queue and history requests when queue misses', async () => {
      const capturedByMode = new Map<string, string>();
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode) capturedByMode.set(mode, request.url);

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          if (mode === 'history') {
            return HttpResponse.json({ history: { slots: [] } });
          }
          return HttpResponse.json({});
        }),
      );

      await client.getDownload('nonexistent');

      const queueUrl = capturedByMode.get('queue');
      const historyUrl = capturedByMode.get('history');
      expect(queueUrl).toBeDefined();
      expect(historyUrl).toBeDefined();
      expect(new URL(queueUrl!).searchParams.get('limit')).toBe('1000');
      expect(new URL(historyUrl!).searchParams.get('limit')).toBe('1000');
    });
  });

  describe('getAllDownloads', () => {
    it('returns combined queue and history items', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');

          if (mode === 'queue') {
            return HttpResponse.json({
              queue: { slots: [queueSlot] },
            });
          }
          if (mode === 'history') {
            return HttpResponse.json({
              history: { slots: [historySlot] },
            });
          }
          return HttpResponse.json({});
        }),
      );

      const items = await client.getAllDownloads();

      expect(items).toHaveLength(2);
      expect(items[0]!.id).toBe('SABnzbd_nzo_abc123');
      expect(items[1]!.id).toBe('SABnzbd_nzo_def456');
    });

    it('sends category filter', async () => {
      const capturedUrls: string[] = [];
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrls.push(request.url);
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      await client.getAllDownloads('audiobooks');

      for (const captured of capturedUrls) {
        const url = new URL(captured);
        expect(url.searchParams.get('cat')).toBe('audiobooks');
      }
    });

    it('sends limit=1000 on both queue and history requests', async () => {
      const capturedByMode = new Map<string, string>();
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode) capturedByMode.set(mode, request.url);

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      await client.getAllDownloads();

      const queueUrl = capturedByMode.get('queue');
      const historyUrl = capturedByMode.get('history');
      expect(queueUrl).toBeDefined();
      expect(historyUrl).toBeDefined();
      expect(new URL(queueUrl!).searchParams.get('limit')).toBe('1000');
      expect(new URL(historyUrl!).searchParams.get('limit')).toBe('1000');
    });

    it('sends limit=1000 alongside category filter on both requests', async () => {
      const capturedByMode = new Map<string, string>();
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          const mode = url.searchParams.get('mode');
          if (mode) capturedByMode.set(mode, request.url);

          if (mode === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      await client.getAllDownloads('audiobooks');

      const queueUrl = capturedByMode.get('queue');
      const historyUrl = capturedByMode.get('history');
      expect(queueUrl).toBeDefined();
      expect(historyUrl).toBeDefined();
      const queueParams = new URL(queueUrl!).searchParams;
      const historyParams = new URL(historyUrl!).searchParams;
      expect(queueParams.get('limit')).toBe('1000');
      expect(queueParams.get('cat')).toBe('audiobooks');
      expect(historyParams.get('limit')).toBe('1000');
      expect(historyParams.get('cat')).toBe('audiobooks');
    });
  });

  describe('pauseDownload', () => {
    it('sends pause command with nzo_id', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ status: true });
        }),
      );

      await client.pauseDownload('SABnzbd_nzo_abc123');

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('mode')).toBe('queue');
      expect(url.searchParams.get('name')).toBe('pause');
      expect(url.searchParams.get('value')).toBe('SABnzbd_nzo_abc123');
    });
  });

  describe('resumeDownload', () => {
    it('sends resume command with nzo_id', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ status: true });
        }),
      );

      await client.resumeDownload('SABnzbd_nzo_abc123');

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('mode')).toBe('queue');
      expect(url.searchParams.get('name')).toBe('resume');
      expect(url.searchParams.get('value')).toBe('SABnzbd_nzo_abc123');
    });
  });

  describe('removeDownload', () => {
    it('sends delete to both queue and history', async () => {
      const capturedUrls: string[] = [];
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrls.push(request.url);
          return HttpResponse.json({ status: true });
        }),
      );

      await client.removeDownload('SABnzbd_nzo_abc123');

      // Should call delete on both queue and history
      expect(capturedUrls).toHaveLength(2);

      const queueUrl = new URL(capturedUrls[0]!);
      expect(queueUrl.searchParams.get('mode')).toBe('queue');
      expect(queueUrl.searchParams.get('name')).toBe('delete');
      expect(queueUrl.searchParams.get('value')).toBe('SABnzbd_nzo_abc123');
      expect(queueUrl.searchParams.get('del_files')).toBe('0');

      const historyUrl = new URL(capturedUrls[1]!);
      expect(historyUrl.searchParams.get('mode')).toBe('history');
      expect(historyUrl.searchParams.get('name')).toBe('delete');
    });

    it('sends del_files=1 when deleteFiles is true', async () => {
      const capturedUrls: string[] = [];
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrls.push(request.url);
          return HttpResponse.json({ status: true });
        }),
      );

      await client.removeDownload('SABnzbd_nzo_abc123', true);

      const url = new URL(capturedUrls[0]!);
      expect(url.searchParams.get('del_files')).toBe('1');
    });
  });

  describe('test', () => {
    it('returns success with version on valid response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.json({ version: '4.2.1' });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('SABnzbd 4.2.1');
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
    });

    it('returns descriptive error when server returns HTML instead of JSON', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse('<!doctype html><html><body>Not Found</body></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('didn\'t respond as expected');
    });
  });

  describe('status mapping', () => {
    it('maps Downloading to downloading', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, status: 'Downloading' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.status).toBe('downloading');
    });

    it('maps Paused to paused', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, status: 'Paused' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.status).toBe('paused');
    });

    it('maps Failed history to error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{ ...historySlot, status: 'Failed' }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.status).toBe('error');
    });

    it('sets progress to 0 for Failed history items (not hardcoded 100)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: { slots: [{ ...historySlot, status: 'Failed' }] },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.progress).toBe(0);
    });

    it('maps non-empty fail_message to errorMessage on failed history item', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{ ...historySlot, status: 'Failed', fail_message: 'CRC error in articles' }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.errorMessage).toBe('CRC error in articles');
    });

    it('omits errorMessage when fail_message is empty string', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: { slots: [{ ...historySlot, status: 'Failed', fail_message: '' }] },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.errorMessage).toBeUndefined();
    });

    it('keeps progress at 100 for Completed history items (regression guard)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: { slots: [{ ...historySlot, status: 'Completed' }] },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.progress).toBe(100);
      expect(item!.errorMessage).toBeUndefined();
    });
  });

  describe('timeleft parsing', () => {
    it('parses HH:MM:SS format', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, timeleft: '1:30:45' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.eta).toBe(5445); // 1*3600 + 30*60 + 45
    });

    it('returns undefined for zero timeleft', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, timeleft: '0:00:00' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.eta).toBeUndefined();
    });
  });

  describe('getCategories', () => {
    it('returns category names from get_cats response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'get_cats') {
            return HttpResponse.json({ categories: ['audiobooks', 'movies', '*'] });
          }
          return HttpResponse.json({});
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks', 'movies']);
    });

    it('filters out the * wildcard category', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'get_cats') {
            return HttpResponse.json({ categories: ['*'] });
          }
          return HttpResponse.json({});
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('returns empty array when no categories exist', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'get_cats') {
            return HttpResponse.json({ categories: [] });
          }
          return HttpResponse.json({});
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('throws DownloadClientError with ZodError cause when categories field is missing', async () => {
      // Behavior change from #743: a malformed get_cats response (missing
      // `categories`) is a boundary failure, not a graceful empty list.
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'get_cats') {
            return HttpResponse.json({});
          }
          return HttpResponse.json({});
        }),
      );

      const err = await client.getCategories().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError with ZodError cause when categories is a non-array', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'get_cats') {
            return HttpResponse.json({ categories: 'not-an-array' });
          }
          return HttpResponse.json({});
        }),
      );

      const err = await client.getCategories().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientAuthError on auth failure (HTTP 401)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      await expect(client.getCategories()).rejects.toBeInstanceOf(DownloadClientAuthError);
    });

    it('throws DownloadClientError on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(client.getCategories()).rejects.toBeInstanceOf(DownloadClientError);
    });

    it('throws DownloadClientError on malformed response (HTML instead of JSON)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse('<html>Not JSON</html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const error = await client.getCategories().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DownloadClientError);
      expect((error as DownloadClientError).message).toContain('didn\'t respond as expected');
    });

    it('throws DownloadClientTimeoutError on request timeout', async () => {
      server.use(
        http.get(`${API_BASE}/api`, async () => {
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

  describe('edge cases — malformed data', () => {
    it('handles malformed mb/percentage strings (NaN)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{
                  ...queueSlot,
                  mb: 'notanumber',
                  mbleft: 'also-nan',
                  percentage: 'abc',
                }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item).not.toBeNull();
      // parseFloat('notanumber') || 0 = 0
      expect(item!.size).toBe(0);
      expect(item!.downloaded).toBe(0);
      // parseInt('abc') || 0 = 0
      expect(item!.progress).toBe(0);
    });

    it('handles timeleft with 2 parts (invalid format)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, timeleft: '30:00' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      // 2 parts instead of 3 → undefined
      expect(item!.eta).toBeUndefined();
    });

    it('handles timeleft with 4 parts (days:hours:minutes:seconds)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, timeleft: '1:02:30:00' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      // 4 parts → undefined (only 3-part format supported)
      expect(item!.eta).toBeUndefined();
    });

    it('handles download_time > completed (negative addedAt calc)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{
                ...historySlot,
                download_time: 99999999, // Way more than completed timestamp
                completed: 1000,
              }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item).not.toBeNull();
      // addedAt = completed - download_time → negative epoch, but still a valid Date
      expect(item!.addedAt.getTime()).toBeLessThan(item!.completedAt!.getTime());
    });

    it('handles completed = 0 in history slot', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{
                ...historySlot,
                completed: 0,
                download_time: 100,
              }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.completedAt).toBeUndefined();
    });

    it('maps Fetching queue status to downloading', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, status: 'Fetching' }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.status).toBe('downloading');
    });

    it('maps Extracting history status to downloading', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{ ...historySlot, status: 'Extracting' }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.status).toBe('downloading');
    });

    it('maps unknown history status to downloading (post-processing fallback)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({
            history: {
              slots: [{ ...historySlot, status: 'SomeNewStatus' }],
            },
          });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_def456');
      expect(item!.status).toBe('downloading');
    });

    it.each(['Queued', 'QuickCheck', 'Fetching', 'Moving', 'Running', 'Verifying', 'Repairing'])(
      'maps SABnzbd post-processing status "%s" to downloading',
      async (sabStatus) => {
        server.use(
          http.get(`${API_BASE}/api`, ({ request }) => {
            const url = new URL(request.url);
            if (url.searchParams.get('mode') === 'queue') {
              return HttpResponse.json({ queue: { slots: [] } });
            }
            return HttpResponse.json({
              history: {
                slots: [{ ...historySlot, status: sabStatus }],
              },
            });
          }),
        );

        const item = await client.getDownload('SABnzbd_nzo_def456');
        expect(item!.status).toBe('downloading');
      },
    );

    it('handles empty storage in queue slot', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: {
                slots: [{ ...queueSlot, storage: undefined }],
              },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.savePath).toBe('');
    });
  });

  describe('schema validation', () => {
    it('throws DownloadClientError with ZodError cause when queue is null', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => HttpResponse.json({ queue: null })),
      );

      const err = await client.getDownload('id').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('throws DownloadClientError when history.slots is a non-array', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({ queue: { slots: [] } });
          }
          return HttpResponse.json({ history: { slots: 'not-an-array' } });
        }),
      );

      const err = await client.getDownload('id').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DownloadClientError);
      const zod = await import('zod');
      expect((err as DownloadClientError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('test() returns success: false when version response is malformed (missing field)', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => HttpResponse.json({ no_version_field: true })),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unexpected version response/);
    });

    it('test() returns success: false when version field is wrong type', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => HttpResponse.json({ version: 42 })),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unexpected version response/);
    });

    it('passes through unknown extra fields in queue/history slots', async () => {
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get('mode') === 'queue') {
            return HttpResponse.json({
              queue: { slots: [{ ...queueSlot, futureField: 'x' }] },
            });
          }
          return HttpResponse.json({ history: { slots: [] } });
        }),
      );

      const item = await client.getDownload('SABnzbd_nzo_abc123');
      expect(item!.id).toBe('SABnzbd_nzo_abc123');
    });
  });
});
