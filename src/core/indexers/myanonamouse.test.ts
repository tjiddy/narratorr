import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';
import { IndexerAuthError } from './errors.js';

const MAM_BASE = 'https://mam.test';

function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 12345,
    title: 'The Way of Kings',
    author_info: '"{\\"123\\": \\"Brandon Sanderson\\"}"',
    narrator_info: '"{\\"456\\": \\"Michael Kramer\\"}"',
    size: 1073741824,
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
    indexer = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('myanonamouse');
      expect(indexer.name).toBe('MyAnonamouse');
    });

    it('uses default base URL when not provided', async () => {
      const defaultIndexer = new MyAnonamouseIndexer({ mamId: 'test' });
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
      const named = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE }, 'Custom MAM');
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
      expect(results[0].size).toBe(1073741824);
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
      vi.spyOn(console, 'warn').mockImplementation(() => {});

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

    it('logs warning when torrent fetch fails', async () => {
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
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MAM torrent fetch failed'));
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
});
