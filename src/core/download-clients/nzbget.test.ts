import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { NZBGetClient } from './nzbget.js';

const RPC_URL = 'http://localhost:6789/jsonrpc';

const activeGroup = {
  NZBID: 123,
  NZBName: 'The Way of Kings',
  Status: 'DOWNLOADING',
  FileSizeMB: 1024,
  DownloadedSizeMB: 512,
  RemainingSizeMB: 512,
  DownloadTimeSec: 300,
  Category: 'audiobooks',
  DestDir: '/downloads/complete/The Way of Kings',
  MinPostTime: 1704067200, // 2024-01-01 00:00:00 UTC
};

const historyItem = {
  NZBID: 456,
  Name: 'Words of Radiance',
  Status: 'SUCCESS/ALL',
  FileSizeMB: 2048,
  DownloadTimeSec: 600,
  Category: 'audiobooks',
  DestDir: '/downloads/complete/Words of Radiance',
  HistoryTime: 1704110400, // 2024-01-01 12:00:00 UTC
  MinPostTime: 1704067200,
};

function rpcHandler(
  methodHandlers: Record<string, (params: unknown[]) => unknown>,
) {
  return http.post(RPC_URL, async ({ request }) => {
    const body = (await request.json()) as {
      method: string;
      params: unknown[];
    };
    const handler = methodHandlers[body.method];
    if (handler) {
      return HttpResponse.json({ result: handler(body.params) });
    }
    return HttpResponse.json({ result: null });
  });
}

describe('NZBGetClient', () => {
  const server = useMswServer();
  let client: NZBGetClient;

  beforeEach(() => {
    client = new NZBGetClient({
      host: 'localhost',
      port: 6789,
      username: 'admin',
      password: 'password',
      useSsl: false,
    });
  });

  describe('properties', () => {
    it('has correct type, name, and protocol', () => {
      expect(client.type).toBe('nzbget');
      expect(client.name).toBe('NZBGet');
      expect(client.protocol).toBe('usenet');
    });
  });

  describe('addDownload', () => {
    it('sends append RPC call and returns ID', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: 789 });
        }),
      );

      const id = await client.addDownload(
        'https://indexer.test/getnzb/abc.nzb',
      );

      expect(id).toBe('789');
      expect(capturedBody!.method).toBe('append');
      expect(capturedBody!.params[1]).toBe(
        'https://indexer.test/getnzb/abc.nzb',
      );
    });

    it('sends category when provided', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: 789 });
        }),
      );

      await client.addDownload('https://indexer.test/nzb', {
        category: 'audiobooks',
      });

      // Category is params[2]
      expect(capturedBody!.params[2]).toBe('audiobooks');
    });

    it('sends paused priority when paused option set', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: 789 });
        }),
      );

      await client.addDownload('https://indexer.test/nzb', { paused: true });

      // Priority is params[3]: -1 = paused
      expect(capturedBody!.params[3]).toBe(-1);
    });

    it('throws on failed add (result 0)', async () => {
      server.use(
        rpcHandler({
          append: () => 0,
        }),
      );

      await expect(
        client.addDownload('https://indexer.test/nzb'),
      ).rejects.toThrow('failed to add');
    });
  });

  describe('getDownload', () => {
    it('finds item in active groups by NZBID', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [activeGroup],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');

      expect(item).not.toBeNull();
      expect(item!.id).toBe('123');
      expect(item!.name).toBe('The Way of Kings');
      expect(item!.progress).toBe(50);
      expect(item!.status).toBe('downloading');
      expect(item!.size).toBe(Math.round(1024 * 1024 * 1024));
      expect(item!.downloaded).toBe(Math.round(512 * 1024 * 1024));
    });

    it('finds item in history if not in active groups', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [historyItem],
        }),
      );

      const item = await client.getDownload('456');

      expect(item).not.toBeNull();
      expect(item!.id).toBe('456');
      expect(item!.name).toBe('Words of Radiance');
      expect(item!.progress).toBe(100);
      expect(item!.status).toBe('completed');
    });

    it('returns null for unknown ID', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [],
        }),
      );

      const item = await client.getDownload('999');
      expect(item).toBeNull();
    });
  });

  describe('getAllDownloads', () => {
    it('returns combined active and history items', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [activeGroup],
          history: () => [historyItem],
        }),
      );

      const items = await client.getAllDownloads();

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('123');
      expect(items[1].id).toBe('456');
    });

    it('filters by category', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [
            activeGroup,
            { ...activeGroup, NZBID: 999, Category: 'movies' },
          ],
          history: () => [historyItem],
        }),
      );

      const items = await client.getAllDownloads('audiobooks');

      expect(items).toHaveLength(2); // activeGroup + historyItem (both audiobooks)
      expect(items.every((i) => i.id !== '999')).toBe(true);
    });
  });

  describe('pauseDownload', () => {
    it('sends GroupPause editqueue command', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: true });
        }),
      );

      await client.pauseDownload('123');

      expect(capturedBody!.method).toBe('editqueue');
      expect(capturedBody!.params[0]).toBe('GroupPause');
      expect(capturedBody!.params[2]).toEqual([123]);
    });
  });

  describe('resumeDownload', () => {
    it('sends GroupResume editqueue command', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: true });
        }),
      );

      await client.resumeDownload('123');

      expect(capturedBody!.method).toBe('editqueue');
      expect(capturedBody!.params[0]).toBe('GroupResume');
      expect(capturedBody!.params[2]).toEqual([123]);
    });
  });

  describe('removeDownload', () => {
    it('sends GroupDelete by default', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: true });
        }),
      );

      await client.removeDownload('123');

      expect(capturedBody!.method).toBe('editqueue');
      expect(capturedBody!.params[0]).toBe('GroupDelete');
    });

    it('sends GroupFinalDelete when deleteFiles is true', async () => {
      let capturedBody: { method: string; params: unknown[] } | null = null;
      server.use(
        http.post(RPC_URL, async ({ request }) => {
          capturedBody = (await request.json()) as typeof capturedBody;
          return HttpResponse.json({ result: true });
        }),
      );

      await client.removeDownload('123', true);

      expect(capturedBody!.method).toBe('editqueue');
      expect(capturedBody!.params[0]).toBe('GroupFinalDelete');
    });
  });

  describe('test', () => {
    it('returns success with version on valid response', async () => {
      server.use(
        rpcHandler({
          version: () => '24.1',
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('NZBGet 24.1');
    });

    it('returns failure with redirect URL and proxy suggestion when server returns 302', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://auth.example.com/login' },
          });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('https://auth.example.com/login');
      expect(result.message).toMatch(/auth proxy/i);
      expect(result.message).toMatch(/internal address|whitelist/i);
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
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

    it('returns failure on RPC error', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.json({ error: 'Invalid API key' });
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid API key');
    });
  });

  describe('status mapping', () => {
    it('maps DOWNLOADING to downloading', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, Status: 'DOWNLOADING' }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.status).toBe('downloading');
    });

    it('maps PAUSED to paused', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, Status: 'PAUSED' }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.status).toBe('paused');
    });

    it('maps PP_QUEUED to downloading', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, Status: 'PP_QUEUED' }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.status).toBe('downloading');
    });

    it('maps SUCCESS/* history to completed', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'SUCCESS/ALL' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.status).toBe('completed');
    });

    it('maps FAILURE/* history to error', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'FAILURE/UNPACK' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.status).toBe('error');
    });

    it('sets progress to 0 for FAILURE/* history items (not hardcoded 100)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'FAILURE/CRC' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.progress).toBe(0);
    });

    it('sets progress to 0 for DELETED/* history items (not hardcoded 100)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'DELETED/MANUAL' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.progress).toBe(0);
    });

    it('keeps progress at 100 for SUCCESS/* history items (regression guard)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'SUCCESS/ALL' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.progress).toBe(100);
    });
  });

  describe('getCategories', () => {
    it('returns category names from config RPC response', async () => {
      server.use(
        rpcHandler({
          config: () => [
            { Name: 'Category1.Name', Value: 'audiobooks' },
            { Name: 'Category1.DestDir', Value: '/downloads/audiobooks' },
            { Name: 'Category2.Name', Value: 'movies' },
            { Name: 'Category2.DestDir', Value: '/downloads/movies' },
            { Name: 'MainDir', Value: '/downloads' },
          ],
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks', 'movies']);
    });

    it('returns empty array when no categories in config', async () => {
      server.use(
        rpcHandler({
          config: () => [
            { Name: 'MainDir', Value: '/downloads' },
            { Name: 'TempDir', Value: '/tmp' },
          ],
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('filters out empty category name values', async () => {
      server.use(
        rpcHandler({
          config: () => [
            { Name: 'Category1.Name', Value: 'audiobooks' },
            { Name: 'Category2.Name', Value: '' },
          ],
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual(['audiobooks']);
    });

    it('returns empty array when config returns null', async () => {
      server.use(
        rpcHandler({
          config: () => null,
        }),
      );

      const categories = await client.getCategories();
      expect(categories).toEqual([]);
    });

    it('throws on auth failure (HTTP 401)', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      await expect(client.getCategories()).rejects.toThrow('401');
    });

    it('throws on network error', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return HttpResponse.error();
        }),
      );

      await expect(client.getCategories()).rejects.toThrow();
    });

    it('throws on malformed response (HTML instead of JSON)', async () => {
      server.use(
        http.post(RPC_URL, () => {
          return new HttpResponse('<html>Not JSON</html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      await expect(client.getCategories()).rejects.toThrow('didn\'t respond as expected');
    });

    it('throws on request timeout', async () => {
      server.use(
        http.post(RPC_URL, async () => {
          await delay('infinite');
          return HttpResponse.json({ result: [] });
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

  describe('edge cases — division by zero and boundary values', () => {
    it('handles DownloadTimeSec=0 (no division by zero in ETA)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, DownloadTimeSec: 0, RemainingSizeMB: 512 }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item).not.toBeNull();
      // DownloadTimeSec = 0 → speedMbps calc skipped → eta = undefined
      expect(item!.eta).toBeUndefined();
    });

    it('handles RemainingSizeMB=0 (download complete, no ETA)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, RemainingSizeMB: 0, DownloadedSizeMB: 1024, FileSizeMB: 1024 }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.eta).toBeUndefined();
      expect(item!.progress).toBe(100);
    });

    it('handles unknown history status (fallback to completed)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'UNKNOWN_STATUS' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.status).toBe('completed');
    });

    it('maps DELETED/* history to error', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, Status: 'DELETED/MANUAL' }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.status).toBe('error');
    });

    it('handles null groups and history from RPC', async () => {
      server.use(
        rpcHandler({
          listgroups: () => null,
          history: () => null,
        }),
      );

      const items = await client.getAllDownloads();
      expect(items).toEqual([]);
    });

    it('handles FileSizeMB=0 (progress = 0, no division by zero)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, FileSizeMB: 0, DownloadedSizeMB: 0 }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.progress).toBe(0);
      expect(item!.size).toBe(0);
    });

    it('handles MinPostTime=0 in active group (falls back to new Date())', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{ ...activeGroup, MinPostTime: 0 }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      expect(item!.addedAt).toBeInstanceOf(Date);
    });

    it('handles HistoryTime=0 in history item (completedAt undefined)', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [],
          history: () => [{ ...historyItem, HistoryTime: 0 }],
        }),
      );

      const item = await client.getDownload('456');
      expect(item!.completedAt).toBeUndefined();
    });

    it('computes ETA correctly with valid download stats', async () => {
      server.use(
        rpcHandler({
          listgroups: () => [{
            ...activeGroup,
            DownloadedSizeMB: 100,
            RemainingSizeMB: 100,
            DownloadTimeSec: 100,
          }],
          history: () => [],
        }),
      );

      const item = await client.getDownload('123');
      // speedMbps = 100/100 = 1, eta = 100/1 = 100
      expect(item!.eta).toBe(100);
    });
  });

  describe('Zod response validation', () => {
    it('rpc() with valid response shape parses correctly and returns result', async () => {
      server.use(
        rpcHandler({
          version: () => '21.1',
        }),
      );

      const result = await client.test();
      expect(result.success).toBe(true);
    });

    it('rpc() with { error: "some error" } throws with descriptive message', async () => {
      server.use(
        http.post(RPC_URL, async () => {
          return HttpResponse.json({ result: null, error: 'Authentication failed' });
        }),
      );

      await expect(client.getAllDownloads()).rejects.toThrow('NZBGet RPC error: Authentication failed');
    });

    it('rpc() with malformed JSON shape throws parse error', async () => {
      server.use(
        http.post(RPC_URL, async () => {
          return HttpResponse.json({ unexpected: 'shape' });
        }),
      );

      await expect(client.getAllDownloads()).rejects.toThrow('NZBGet returned unexpected response');
    });

    it('getAllDownloads() when listgroups returns null returns empty array', async () => {
      server.use(
        rpcHandler({
          listgroups: () => null,
          history: () => null,
        }),
      );

      const items = await client.getAllDownloads();
      expect(items).toEqual([]);
    });
  });
});
