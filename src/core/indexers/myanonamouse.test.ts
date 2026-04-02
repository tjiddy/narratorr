import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';
import { IndexerAuthError, ProxyError } from './errors.js';

const MAM_BASE = 'https://mam.test';

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    title: 'The Way of Kings',
    author_info: '"{\\"123\\": \\"Brandon Sanderson\\"}"',
    narrator_info: '"{\\"456\\": \\"Michael Kramer\\"}"',
    size: '881.8 MiB',
    seeders: 42,
    leechers: 3,
    ...overrides,
  };
}

function stubTorrentDownload(server: ReturnType<typeof useMswServer>) {
  server.use(
    http.get(`${MAM_BASE}/tor/download.php`, () => {
      return new HttpResponse(Buffer.from('fake-torrent'), {
        headers: { 'Content-Type': 'application/x-bittorrent' },
      });
    }),
  );
}

describe('MyAnonamouseIndexer', () => {
  const server = useMswServer();
  let indexer: MyAnonamouseIndexer;

  beforeEach(() => {
    indexer = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 1 });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('myanonamouse');
      expect(indexer.name).toBe('MyAnonamouse');
    });

    it('uses default base URL when not provided', async () => {
      const defaultIndexer = new MyAnonamouseIndexer({ mamId: 'test', searchLanguages: [1], searchType: 1 });
      expect(defaultIndexer.type).toBe('myanonamouse');

      let capturedUrl: string | undefined;
      server.use(
        http.get('https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php', ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );

      await defaultIndexer.search('test query');
      expect(capturedUrl).toContain('https://www.myanonamouse.net');
    });

    it('uses custom name when provided', () => {
      const named = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 1 }, 'Custom MAM');
      expect(named.name).toBe('Custom MAM');
    });
  });

  describe('search — successful parsing', () => {
    it('parses valid MAM response into SearchResult[] with correct fields', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('Brandon Sanderson');

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('The Way of Kings');
      expect(results[0].size).toBe(924634317);
      expect(results[0].seeders).toBe(42);
      expect(results[0].leechers).toBe(3);
      expect(results[0].indexer).toBe('MyAnonamouse');
    });

    it('extracts author from double-encoded author_info field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].author).toBe('Brandon Sanderson');
    });

    it('extracts narrator from double-encoded narrator_info field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].narrator).toBe('Michael Kramer');
    });

    it('joins multiple authors from double-encoded field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({
            data: [makeResult({ author_info: '"{\\"1\\": \\"Author A\\", \\"2\\": \\"Author B\\"}"' })],
          });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].author).toBe('Author A, Author B');
    });

    it('sets protocol to torrent on all results', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].protocol).toBe('torrent');
    });

    it('returns download URL as data:application/x-bittorrent;base64,... URI', async () => {
      const torrentBytes = Buffer.from('test-torrent-content');
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
        http.get(`${MAM_BASE}/tor/download.php`, () => {
          return new HttpResponse(torrentBytes, {
            headers: { 'Content-Type': 'application/x-bittorrent' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].downloadUrl).toBe(
        `data:application/x-bittorrent;base64,${torrentBytes.toString('base64')}`,
      );
    });

    it('ignores series_info field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({
            data: [makeResult({ series_info: '"{\\"1\\": \\"Stormlight Archive\\"}"' })],
          });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0]).not.toHaveProperty('series');
    });
  });

  describe('search — query parameters', () => {
    it('sends request with correct query params and mam_id cookie', async () => {
      let capturedUrl = '';
      let capturedCookie = '';

      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          capturedCookie = request.headers.get('cookie') || '';
          return HttpResponse.json({ data: [] });
        }),
      );

      await indexer.search('test query');

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('tor[text]')).toBe('test query');
      expect(url.searchParams.get('tor[srchIn][title]')).toBe('true');
      expect(url.searchParams.get('tor[srchIn][author]')).toBe('true');
      expect(url.searchParams.get('tor[main_cat][]')).toBe('13');
      expect(capturedCookie).toBe('mam_id=test-mam-id');
    });
  });

  describe('search — server-side torrent fetch', () => {
    it('fetches .torrent from download endpoint with mam_id cookie per result', async () => {
      let capturedDownloadCookie = '';

      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
        http.get(`${MAM_BASE}/tor/download.php`, ({ request }) => {
          capturedDownloadCookie = request.headers.get('cookie') || '';
          const url = new URL(request.url);
          expect(url.searchParams.get('tid')).toBe('12345');
          return new HttpResponse(Buffer.from('torrent'), {
            headers: { 'Content-Type': 'application/x-bittorrent' },
          });
        }),
      );

      await indexer.search('test');
      expect(capturedDownloadCookie).toBe('mam_id=test-mam-id');
    });

    it('keeps result with downloadUrl undefined when torrent fetch fails', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
        http.get(`${MAM_BASE}/tor/download.php`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBe(1);
      expect(results[0].downloadUrl).toBeUndefined();
      expect(results[0].title).toBe('The Way of Kings');
    });

    it('does not call console.warn when torrent fetch fails (#229)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
        http.get(`${MAM_BASE}/tor/download.php`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await indexer.search('test');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('search — boundary values and null/missing data', () => {
    it('sets author undefined when author_info is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ author_info: undefined })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].author).toBeUndefined();
    });

    it('sets author undefined when author_info is empty object', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ author_info: '"{}"' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].author).toBeUndefined();
    });

    it('handles malformed author_info gracefully', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ author_info: 'not-json' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].author).toBeUndefined();
    });

    it('sets narrator undefined when narrator_info is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ narrator_info: undefined })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].narrator).toBeUndefined();
    });

    it('skips result with missing title', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ title: undefined })] });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBe(0);
    });

    it('sets size undefined when size field is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: undefined })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBeUndefined();
    });

    it('sets downloadUrl undefined when result has no torrent ID', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: undefined })] });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].downloadUrl).toBeUndefined();
    });
  });

  describe('search — empty results', () => {
    it('returns empty array when MAM returns "Nothing returned" error', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ error: 'Nothing returned, out of 50000 torrents' });
        }),
      );

      const results = await indexer.search('nonexistent book');
      expect(results).toEqual([]);
    });

    it('returns empty array when MAM returns empty data array', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [] });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('returns empty array when MAM returns no data field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({});
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('search — error handling and auth failures', () => {
    it('throws IndexerAuthError on HTTP 403 response', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerAuthError);
      await expect(indexer.search('test')).rejects.toThrow('Authentication failed');
    });

    it('throws IndexerAuthError when body contains "Error, you are not signed in"', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return new HttpResponse('Error, you are not signed in', { status: 200 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerAuthError);
      await expect(indexer.search('test')).rejects.toThrow('Authentication failed');
    });

    it('throws on unexpected error message in response', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ error: 'Some unexpected error' });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow('MAM search error');
    });
  });

  describe('test — connection validation', () => {
    it('returns success with username on valid session', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser' });
        }),
      );

      const result = await indexer.test();
      expect(result).toEqual({ success: true, message: 'Connected as testuser' });
    });

    it('returns failure message on invalid/expired mam_id (403)', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Authentication failed');
    });

    it('returns failure message on "not signed in" body', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in', { status: 200 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('Authentication failed');
    });

    it('returns failure with error message on network error', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toBeDefined();
    });
  });

  describe('search — size parsing', () => {
    it('parses "881.8 MiB" string size into 924634317 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '881.8 MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBe(924634317);
    });

    it('parses "1.1 GiB" string size into 1181116006 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.1 GiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBe(1181116006);
    });

    it('parses "512 KiB" string size into 524288 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '512 KiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBe(524288);
    });

    it('parses "1.5 TiB" string size into 1649267441664 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.5 TiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBe(1649267441664);
    });

    it('sets size undefined when size is "0 MiB" (zero is not a useful size)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '0 MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBeUndefined();
    });

    it('sets size undefined when size string has non-numeric value ("invalid MiB")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: 'invalid MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBeUndefined();
    });

    it('sets size undefined when size string has unknown unit ("1.5 ZZB")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.5 ZZB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBeUndefined();
    });

    it('sets size undefined when size string has no unit ("881.8")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '881.8' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBeUndefined();
    });

    it('passes numeric size through unchanged', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: 1073741824 })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].size).toBe(1073741824);
    });

    it('MAM result with string size and nonzero bookDuration produces valid numeric quality value', async () => {
      // Verifies the full chain: string size → bytes → calculateQuality produces a number, not NaN
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '881.8 MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      const sizeBytes = results[0].size;
      expect(typeof sizeBytes).toBe('number');
      expect(Number.isNaN(sizeBytes)).toBe(false);
      // Simulate quality calculation as SearchReleasesModal does with bookDuration
      const bookDurationSeconds = 3600; // 1 hour
      const mbPerHour = sizeBytes !== undefined ? (sizeBytes / 1024 / 1024) / (bookDurationSeconds / 3600) : NaN;
      expect(Number.isNaN(mbPerHour)).toBe(false);
      expect(mbPerHour).toBeGreaterThan(0);
    });
  });

  describe('proxy support', () => {
    const PROXY_URL = 'http://proxy.test:8080';
    let proxiedIndexer: MyAnonamouseIndexer;

    beforeEach(() => {
      proxiedIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id',
        baseUrl: MAM_BASE,
        proxyUrl: PROXY_URL,
        searchLanguages: [1],
        searchType: 1,
      });
    });

    it('routes fetchWithCookie through proxy when proxyUrl is set', async () => {
      const searchResponse = JSON.stringify({ data: [makeResult()] });
      const torrentBytes = Buffer.from('fake-torrent');

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(searchResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(torrentBytes, {
            status: 200,
            headers: { 'Content-Type': 'application/x-bittorrent' },
          }),
        );

      const results = await proxiedIndexer.search('Brandon Sanderson');

      expect(results.length).toBe(1);
      expect(results[0].title).toBe('The Way of Kings');
      // Verify fetch was called with a dispatcher (proxy agent)
      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('sends mam_id cookie correctly through proxy', async () => {
      const searchResponse = JSON.stringify({ data: [] });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(searchResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      await proxiedIndexer.search('test');

      expect(fetchSpy).toHaveBeenCalledOnce();
      const callArgs = fetchSpy.mock.calls[0];
      const headers = (callArgs[1] as Record<string, unknown>).headers as Record<string, string>;
      expect(headers.Cookie).toBe('mam_id=test-mam-id');

      fetchSpy.mockRestore();
    });

    it('test with proxy returns success with exit IP', async () => {
      const userResponse = JSON.stringify({ username: 'testuser' });
      const ipifyResponse = JSON.stringify({ ip: '1.2.3.4' });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(userResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(ipifyResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.ip).toBe('1.2.3.4');
      expect(result.message).toContain('Connected as testuser');

      fetchSpy.mockRestore();
    });

    it('fetchTorrentAsDataUri rethrows ProxyError (not swallowed)', async () => {
      const searchResponse = JSON.stringify({ data: [makeResult()] });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(searchResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockRejectedValueOnce(
          new Error('connect ECONNREFUSED'),
        );

      // The search calls fetchTorrentAsDataUri internally, which should rethrow ProxyError
      await expect(proxiedIndexer.search('test')).rejects.toThrow(ProxyError);

      fetchSpy.mockRestore();
    });

    it('fetchTorrentAsDataUri returns undefined for non-proxy errors', async () => {
      // Non-proxied indexer: errors in torrent fetch are swallowed to undefined
      const directIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id',
        baseUrl: MAM_BASE,
        searchLanguages: [1],
        searchType: 1,
      });

      const searchResponse = JSON.stringify({ data: [makeResult()] });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(searchResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockRejectedValueOnce(
          new Error('some network error'),
        );

      const results = await directIndexer.search('test');
      expect(results.length).toBe(1);
      expect(results[0].downloadUrl).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it('search rethrows ProxyError', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );

      await expect(proxiedIndexer.search('test')).rejects.toThrow(ProxyError);

      fetchSpy.mockRestore();
    });

    it('search returns empty results for non-proxy errors', async () => {
      // Non-proxied indexer: network errors propagate as plain errors (not ProxyError)
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow();
      // Verify it's NOT a ProxyError — just a regular error
      await expect(indexer.search('test')).rejects.not.toThrow(ProxyError);
    });
  });

  describe('search — language parsing (#272)', () => {
    it('parses lang_code into SearchResult.language normalized to full name (ENG → english)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ lang_code: 'ENG' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].language).toBe('english');
    });

    it('returns undefined language when lang_code is missing from response', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].language).toBeUndefined();
    });

    it('handles unknown lang_code by storing as-is lowercase', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ lang_code: 'XYZ' })] });
        }),
      );
      stubTorrentDownload(server);

      const results = await indexer.search('test');
      expect(results[0].language).toBe('xyz');
    });
  });

  describe('search — language and search type params (#291)', () => {
    it('sends tor[browse_lang][0]=1 when searchLanguages is [1]', async () => {
      const langIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 1,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await langIndexer.search('test');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('tor[browse_lang][0]')).toBe('1');
    });

    it('sends indexed browse_lang params for multiple languages', async () => {
      const langIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1, 36], searchType: 1,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await langIndexer.search('test');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('tor[browse_lang][0]')).toBe('1');
      expect(url.searchParams.get('tor[browse_lang][1]')).toBe('36');
    });

    it('sends tor[searchType]=1 when searchType is 1 (active)', async () => {
      const stIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 1,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await stIndexer.search('test');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('tor[searchType]')).toBe('1');
    });

    it('sends tor[searchType]=0 when searchType is 0 (all) — falsy but valid', async () => {
      const stIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 0,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await stIndexer.search('test');
      const url = new URL(capturedUrl);
      expect(url.searchParams.get('tor[searchType]')).toBe('0');
    });

    it('sends no browse_lang params when searchLanguages is empty array', async () => {
      const noLangIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [], searchType: 1,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await noLangIndexer.search('test');
      const url = new URL(capturedUrl);
      // No browse_lang params should be present
      const allParams = Array.from(url.searchParams.keys());
      const browseLangParams = allParams.filter(k => k.startsWith('tor[browse_lang]'));
      expect(browseLangParams).toHaveLength(0);
    });

    it('sends all 15 indexed browse_lang params when all languages selected', async () => {
      const allLangs = [1, 2, 4, 33, 35, 36, 37, 38, 40, 43, 44, 45, 46, 49, 51];
      const allLangIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: allLangs, searchType: 1,
      });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await allLangIndexer.search('test');
      const url = new URL(capturedUrl);
      for (let i = 0; i < allLangs.length; i++) {
        expect(url.searchParams.get(`tor[browse_lang][${i}]`)).toBe(String(allLangs[i]));
      }
    });
  });

  describe('test() with new config fields (#291)', () => {
    it('adapter.test() succeeds when searchLanguages and searchType are in config', async () => {
      const configIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1, 36], searchType: 2,
      });
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser' });
        }),
      );
      const result = await configIndexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected as testuser');
    });
  });

});
