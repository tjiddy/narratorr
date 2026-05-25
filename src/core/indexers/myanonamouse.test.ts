import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Route fetchWithOptionalDispatcher through globalThis.fetch in tests so
// MSW handlers and `vi.spyOn(globalThis, 'fetch')` continue to intercept
// the proxy path. Call-site contract is asserted in
// myanonamouse.dispatcher-routing.test.ts.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { MyAnonamouseIndexer } from './myanonamouse.js';
import { IndexerAuthError, IndexerError, ProxyError } from './errors.js';
import { filterByLanguage } from '../utils/filters.js';

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
    indexer = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('myanonamouse');
      expect(indexer.name).toBe('MyAnonamouse');
    });

    it('uses default base URL when not provided', async () => {
      const defaultIndexer = new MyAnonamouseIndexer({ mamId: 'test', searchLanguages: [1], searchType: 'active' });
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
      const named = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' }, 'Custom MAM');
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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('The Way of Kings');
      expect(results[0]!.size).toBe(924634317);
      expect(results[0]!.seeders).toBe(42);
      expect(results[0]!.leechers).toBe(3);
      expect(results[0]!.indexer).toBe('MyAnonamouse');
    });

    it('extracts author from double-encoded author_info field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.author).toBe('Brandon Sanderson');
    });

    it('extracts narrator from double-encoded narrator_info field', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.narrator).toBe('Michael Kramer');
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

      const { results } = await indexer.search('test');
      expect(results[0]!.author).toBe('Author A, Author B');
    });

    it('sets protocol to torrent on all results', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.protocol).toBe('torrent');
    });

    it('returns the mam-torrent://<id> sentinel as downloadUrl — real bytes are fetched at grab time via resolveDownloadUrl', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results[0]!.downloadUrl).toBe('mam-torrent://12345');
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

      const { results } = await indexer.search('test');
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

  describe('search — sentinel emission (#1156)', () => {
    it('does NOT hit /tor/download.php during search — torrent fetch is deferred to resolveDownloadUrl', async () => {
      let downloadHit = false;
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
        http.get(`${MAM_BASE}/tor/download.php`, () => {
          downloadHit = true;
          return new HttpResponse(Buffer.from('torrent'), {
            headers: { 'Content-Type': 'application/x-bittorrent' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results[0]!.downloadUrl).toBe('mam-torrent://12345');
      expect(downloadHit).toBe(false);
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

      const { results } = await indexer.search('test');
      expect(results[0]!.author).toBeUndefined();
    });

    it('sets author undefined when author_info is empty object', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ author_info: '"{}"' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.author).toBeUndefined();
    });

    it('handles malformed author_info gracefully', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ author_info: 'not-json' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.author).toBeUndefined();
    });

    it('sets narrator undefined when narrator_info is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ narrator_info: undefined })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.narrator).toBeUndefined();
    });

    it('skips result with missing title', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ title: undefined })] });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results.length).toBe(0);
    });

    it('sets size undefined when size field is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: undefined })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBeUndefined();
    });

    it('drops rows with no torrent ID (no-url drop, #932 AC1)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: undefined })] });
        }),
      );

      const response = await indexer.search('test');
      expect(response.results).toEqual([]);
      expect(response.parseStats.dropped.noUrl).toBe(1);
    });

    it('populates guid from torrent id', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: 720129 })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.guid).toBe('720129');
    });

    it('populates guid as "0" when torrent id is 0', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: 0 })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.guid).toBe('0');
    });

    it('drops row when torrent id is null — no torrent download URL is producible (#932 F4)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: null })] });
        }),
      );

      const response = await indexer.search('test');
      expect(response.results).toEqual([]);
      expect(response.parseStats.dropped.noUrl).toBe(1);
    });

    it('drops row when torrent id is undefined — no torrent download URL is producible (#932 F4)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: undefined })] });
        }),
      );

      const response = await indexer.search('test');
      expect(response.results).toEqual([]);
      expect(response.parseStats.dropped.noUrl).toBe(1);
    });

    it('populates guid for large torrent id without truncation', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: 9999999 })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.guid).toBe('9999999');
    });

    it('populates distinct guids for multiple results', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({
            data: [
              makeResult({ id: 111, title: 'Book A' }),
              makeResult({ id: 222, title: 'Book B' }),
            ],
          });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(2);
      expect(results[0]!.guid).toBe('111');
      expect(results[1]!.guid).toBe('222');
    });

    it('drops row entirely when id is missing — no torrent download URL can be produced (#932 F4)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ id: undefined })] });
        }),
      );

      const response = await indexer.search('test');
      expect(response.results).toEqual([]);
      expect(response.parseStats.dropped.noUrl).toBe(1);
    });
  });

  describe('parse trace shape (#932 AC1)', () => {
    it('populates parseStats and per-row debugTrace including transport metadata', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const response = await indexer.search('Brandon Sanderson');

      expect(response.parseStats.itemsObserved).toBe(1);
      expect(response.parseStats.kept).toBe(1);
      expect(response.requestUrl).toContain('loadSearchJSONbasic.php');
      expect(response.httpStatus).toBe(200);
      const trace = response.debugTrace.find((t) => t.reason === 'kept');
      expect(trace?.rawTitleBytes).toMatch(/^[0-9a-f]+$/);
      expect(trace?.source).toBe('row');
    });

    it('records dropped:empty-title for rows missing titles', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [{ id: 1, title: '' }, makeResult({ id: 2 })] });
        }),
      );
      stubTorrentDownload(server);

      const response = await indexer.search('test');
      expect(response.parseStats.dropped.emptyTitle).toBe(1);
      expect(response.debugTrace.some((t) => t.reason === 'dropped:empty-title')).toBe(true);
    });
  });

  describe('search — empty results', () => {
    it('returns empty array when MAM returns "Nothing returned" error', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ error: 'Nothing returned, out of 50000 torrents' });
        }),
      );

      const { results } = await indexer.search('nonexistent book');
      expect(results).toEqual([]);
    });

    it('returns empty array when MAM returns empty data array', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [] });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('throws IndexerError when MAM returns neither data nor error field', async () => {
      // Behavior change from #743: a response with no `data` and no `error`
      // is malformed (HTML interstitial, rate-limit page, shape change) and
      // must fail at the boundary instead of silently returning [].
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({});
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerError);
    });
  });

  describe('search — error handling and auth failures', () => {
    it('throws IndexerAuthError with "Invalid/missing cookie" detail on 403 with bad cookie body', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Invalid/missing cookie', { status: 403 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerAuthError);
      await expect(indexer.search('test')).rejects.toThrow('Authentication failed — Invalid/missing cookie');
    });

    it('throws IndexerAuthError with "Session IP address mismatch" detail on 403 with IP mismatch body', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Session IP address mismatch', { status: 403 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerAuthError);
      await expect(indexer.search('test')).rejects.toThrow('Authentication failed — Session IP address mismatch');
    });

    it('throws IndexerAuthError with generic message on 403 with empty body', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow(IndexerAuthError);
      await expect(indexer.search('test')).rejects.toThrow('Authentication failed — check your MAM ID');
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
      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected as testuser');
      expect(result.metadata).toEqual({ username: 'testuser', classname: undefined, isVip: false });
    });

    it('returns failure with "Invalid/missing cookie" detail on 403 with bad cookie body', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Invalid/missing cookie', { status: 403 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Authentication failed — Invalid/missing cookie');
    });

    it('returns failure with "Session IP address mismatch" detail on 403 with IP block body', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Session IP address mismatch', { status: 403 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Authentication failed — Session IP address mismatch');
    });

    it('returns generic failure on 403 with empty body', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse(null, { status: 403 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Authentication failed — check your MAM ID');
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

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(924634317);
    });

    it('parses "1.1 GiB" string size into 1181116006 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.1 GiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(1181116006);
    });

    it('parses "512 KiB" string size into 524288 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '512 KiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(524288);
    });

    it('parses "1.5 TiB" string size into 1649267441664 bytes', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.5 TiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(1649267441664);
    });

    it('sets size undefined when size is "0 MiB" (zero is not a useful size)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '0 MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBeUndefined();
    });

    it('sets size undefined when size string has non-numeric value ("invalid MiB")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: 'invalid MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBeUndefined();
    });

    it('sets size undefined when size string has unknown unit ("1.5 ZZB")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '1.5 ZZB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBeUndefined();
    });

    it('sets size undefined when size string has no unit ("881.8")', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '881.8' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBeUndefined();
    });

    it('passes numeric size through unchanged', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: 1073741824 })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(1073741824);
    });

    it('MAM result with string size and nonzero bookDuration produces valid numeric quality value', async () => {
      // Verifies the full chain: string size → bytes → calculateQuality produces a number, not NaN
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ size: '881.8 MiB' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      const sizeBytes = results[0]!.size;
      expect(typeof sizeBytes).toBe('number');
      expect(Number.isNaN(sizeBytes)).toBe(false);
      // Simulate quality calculation as SearchReleasesModal does with bookDuration
      const bookDurationSeconds = 3600; // 1 hour
      const mbPerHour = sizeBytes !== undefined ? (sizeBytes / 1024 / 1024) / (bookDurationSeconds / 3600) : NaN;
      expect(Number.isNaN(mbPerHour)).toBe(false);
      expect(mbPerHour).toBeGreaterThan(0);
    });
  });

  describe('AbortSignal threading', () => {
    it('forwards signal to the search fetch helper (torrent fetch is deferred to resolveDownloadUrl)', async () => {
      const capturedSignals: (AbortSignal | undefined)[] = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignals.push(init?.signal ?? undefined);
        return new Response(JSON.stringify({
          data: [{ id: 1, title: 'Test Book', seeders: 5, leechers: 1, size: '500 MB' }],
        }));
      });

      const controller = new AbortController();
      await indexer.search('test', { signal: controller.signal });

      expect(capturedSignals.length).toBe(1);
      expect(capturedSignals[0]).toBeDefined();
      controller.abort();
      expect(capturedSignals[0]!.aborted).toBe(true);

      fetchSpy.mockRestore();
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
        searchType: 'active',
      });
    });

    it('routes fetchWithCookie through proxy when proxyUrl is set', async () => {
      const searchResponse = JSON.stringify({ data: [makeResult()] });

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(searchResponse, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe('The Way of Kings');
      // Verify the search fetch was called with a dispatcher (proxy agent)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs![1] as Record<string, unknown>).dispatcher).toBeDefined();

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
      const headers = (callArgs![1] as Record<string, unknown>).headers as Record<string, string>;
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

    it('resolveDownloadUrl wraps ProxyError into IndexerError with cause chain preserved (#1156 F10)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );

      const err = await proxiedIndexer
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: true })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).cause).toBeInstanceOf(ProxyError);

      fetchSpy.mockRestore();
    });

    it('resolveDownloadUrl wraps non-OK torrent fetch into IndexerError (no cause)', async () => {
      const directIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id',
        baseUrl: MAM_BASE,
        searchLanguages: [1],
        searchType: 'active',
      });

      server.use(
        http.get(`${MAM_BASE}/tor/download.php`, () => new HttpResponse(null, { status: 500 })),
      );

      await expect(
        directIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: true }),
      ).rejects.toBeInstanceOf(IndexerError);
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

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBe('english');
    });

    it('returns undefined language when lang_code is missing from response', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBeUndefined();
    });

    it('handles unknown lang_code by storing as-is lowercase', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ lang_code: 'XYZ' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBe('xyz');
    });

    it("resolves MAM numeric lang_code '1' to 'english' (#668)", async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ lang_code: '1' })] });
        }),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBe('english');
    });

    it("MAM result with lang_code '1' survives default languages: ['english'] filter (#668)", async () => {
      // Interaction guard: the user-visible regression in #668 was that a MAM result
      // originating as `lang_code: '1'` was dropped by the default `metadataSettings.languages:
      // ['english']` filter. Chain the adapter's parse path into `filterByLanguage` — the same
      // predicate the search pipeline uses — so a regression at either layer fails this test.
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({
            data: [
              makeResult({ id: 1, title: 'English Book', lang_code: '1' }),
              makeResult({ id: 2, title: 'German Book', lang_code: '37' }),
            ],
          });
        }),
      );
      stubTorrentDownload(server);

      const parsed = await indexer.search('test');
      const surviving = filterByLanguage(parsed.results, ['english']).kept;

      expect(surviving).toHaveLength(1);
      expect(surviving[0]!.title).toBe('English Book');
      expect(surviving[0]!.language).toBe('english');
    });
  });

  describe('search — language and search type params (#291)', () => {
    it('sends tor[browse_lang][0]=1 when searchLanguages is [1]', async () => {
      const langIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 'active',
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
        searchLanguages: [1, 36], searchType: 'active',
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

    it('sends tor[searchType]=active when searchType is "active"', async () => {
      const stIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 'active',
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
      expect(url.searchParams.get('tor[searchType]')).toBe('active');
    });

    it('sends tor[searchType]=all when searchType is "all"', async () => {
      const stIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [1], searchType: 'all',
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
      expect(url.searchParams.get('tor[searchType]')).toBe('all');
    });

    it('sends no browse_lang params when searchLanguages is empty array', async () => {
      const noLangIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id', baseUrl: MAM_BASE,
        searchLanguages: [], searchType: 'active',
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
        searchLanguages: allLangs, searchType: 'active',
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
        searchLanguages: [1, 36], searchType: 'fl',
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

  describe('#317 — VIP detection in test()', () => {
    it('returns isVip: true in metadata when classname is "VIP"', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'VipUser', classname: 'VIP' });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ username: 'VipUser', classname: 'VIP', isVip: true });
    });

    it('returns isVip: true in metadata when classname is "Elite VIP"', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'EliteUser', classname: 'Elite VIP' });
        }),
      );
      const result = await indexer.test();
      expect(result.metadata).toEqual({ username: 'EliteUser', classname: 'Elite VIP', isVip: true });
    });

    it('returns isVip: false in metadata when classname is "User"', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'RegularUser', classname: 'User' });
        }),
      );
      const result = await indexer.test();
      expect(result.metadata).toEqual({ username: 'RegularUser', classname: 'User', isVip: false });
    });

    it('returns isVip: false for other classes (Mouse, Power User, Supporter)', async () => {
      for (const classname of ['Mouse', 'Power User', 'Supporter', 'Mouseketeer', 'Star', 'Elite', 'Uploader']) {
        server.use(
          http.get(`${MAM_BASE}/jsonLoad.php`, () => {
            return HttpResponse.json({ username: 'TestUser', classname });
          }),
        );
        const result = await indexer.test();
        expect(result.metadata?.isVip).toBe(false);
      }
    });

    it('returns isVip: false when classname field is missing from response', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'NoClassUser' });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.metadata).toEqual({ username: 'NoClassUser', classname: undefined, isVip: false });
    });

    it('returns isVip: false when classname is empty string', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'EmptyClass', classname: '' });
        }),
      );
      const result = await indexer.test();
      expect(result.metadata?.isVip).toBe(false);
    });

    it('returns no metadata on auth failure (403)', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Invalid/missing cookie', { status: 403 });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.metadata).toBeUndefined();
    });

    it('returns no metadata on "not signed in" body', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in', { status: 200 });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.metadata).toBeUndefined();
    });

    it('returns no metadata on invalid JSON response', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('not json at all', { status: 200 });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.metadata).toBeUndefined();
    });
  });

  describe('#317 — automatic search type selection', () => {
    it('sends tor[searchType]=all when isVip is true', async () => {
      const vipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await vipIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('sends tor[searchType]=nVIP when isVip is false', async () => {
      const nonVipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'fl-VIP', isVip: false });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await nonVipIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('nVIP');
    });

    it('sends saved searchType when isVip is undefined (legacy)', async () => {
      const legacyIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'fl-VIP' });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await legacyIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('fl-VIP');
    });
  });

  describe('#317 — freeleech/VIP result flags', () => {
    it('sets isFreeleech: true when result has free: true', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBe(true);
    });

    it('sets isFreeleech: true when result has personal_freeleech: true', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ personal_freeleech: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBe(true);
    });

    it('sets isFreeleech: true when result has fl_vip: true and adapter isVip is true', async () => {
      const vipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'all', isVip: true });
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ fl_vip: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await vipIndexer.search('test');
      expect(results[0]!.isFreeleech).toBe(true);
    });

    it('does not set isFreeleech when fl_vip: true but adapter isVip is false', async () => {
      const nonVipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: false });
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ fl_vip: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await nonVipIndexer.search('test');
      expect(results[0]!.isFreeleech).toBeUndefined();
    });

    it('sets isVipOnly: true when result has vip: true', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ vip: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isVipOnly).toBe(true);
    });

    it('does not set badge flags when all flags are absent', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult()] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBeUndefined();
      expect(results[0]!.isVipOnly).toBeUndefined();
    });

    it('sets both isFreeleech and isVipOnly when free: true and vip: true', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: true, vip: true })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBe(true);
      expect(results[0]!.isVipOnly).toBe(true);
    });

    it('handles missing flag fields gracefully (no crash)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: undefined, vip: undefined, fl_vip: undefined, personal_freeleech: undefined })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.isFreeleech).toBeUndefined();
      expect(results[0]!.isVipOnly).toBeUndefined();
    });

    it('#954 — sets isFreeleech: true when result has free: 1 (numeric)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: 1 })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBe(true);
    });

    it('#954 — does not set isFreeleech when result has free: 0 (numeric)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: 0, personal_freeleech: 0, fl_vip: 0 })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isFreeleech).toBeUndefined();
    });

    it('#954 — sets isVipOnly: true when result has vip: 1 (numeric)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ vip: 1 })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results[0]!.isVipOnly).toBe(true);
    });

    it('#954 — full numeric-flag row (canonical wire shape) parses without error', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () => {
          return HttpResponse.json({ data: [makeResult({ free: 0, fl_vip: 1, vip: 0, personal_freeleech: 0 })] });
        }),
      );
      stubTorrentDownload(server);
      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.isFreeleech).toBeUndefined();
      expect(results[0]!.isVipOnly).toBeUndefined();
    });
  });

  describe('#363 — searchType string values and auto-select', () => {
    it('sends tor[searchType]=nVIP when isVip is false', async () => {
      const nonVipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'fl', isVip: false });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await nonVipIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('nVIP');
    });

    it('sends tor[searchType]=all when isVip is true', async () => {
      const vipIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await vipIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('sends saved string searchType when isVip is undefined (legacy)', async () => {
      const legacyIndexer = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'fl-VIP' });
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await legacyIndexer.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('fl-VIP');
    });

    it('sends each of the 6 string values as correct URL parameter', async () => {
      for (const value of ['all', 'active', 'fl', 'fl-VIP', 'VIP', 'nVIP']) {
        const idx = new MyAnonamouseIndexer({ mamId: 'test', baseUrl: MAM_BASE, searchLanguages: [1], searchType: value });
        let capturedUrl = '';
        server.use(
          http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
            capturedUrl = request.url;
            return HttpResponse.json({ data: [] });
          }),
        );
        await idx.search('test');
        expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe(value);
      }
    });
  });

  describe('#372 — refreshStatus()', () => {
    it('returns { isVip: true, classname: "VIP" } for VIP class', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'VIP' });
        }),
      );
      const result = await indexer.refreshStatus!();
      expect(result).toEqual({ isVip: true, classname: 'VIP' });
    });

    it('returns { isVip: true, classname: "Elite VIP" } for Elite VIP class', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'Elite VIP' });
        }),
      );
      const result = await indexer.refreshStatus!();
      expect(result).toEqual({ isVip: true, classname: 'Elite VIP' });
    });

    it('returns { isVip: false, classname: "Power User" } for non-VIP non-Mouse class', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'Power User' });
        }),
      );
      const result = await indexer.refreshStatus!();
      expect(result).toEqual({ isVip: false, classname: 'Power User' });
    });

    it('returns { isVip: false, classname: "Mouse" } for Mouse class', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'Mouse' });
        }),
      );
      const result = await indexer.refreshStatus!();
      expect(result).toEqual({ isVip: false, classname: 'Mouse' });
    });

    it('returns null when user info endpoint returns empty/malformed response', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.text('not json at all');
        }),
      );
      const result = await indexer.refreshStatus!();
      expect(result).toBeNull();
    });

    it('throws on network error', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.error();
        }),
      );
      await expect(indexer.refreshStatus!()).rejects.toThrow();
    });

    it('throws on auth failure (403 response)', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return new HttpResponse('Error, you are not signed in <br />Invalid/missing cookie', { status: 403 });
        }),
      );
      await expect(indexer.refreshStatus!()).rejects.toThrow(IndexerAuthError);
    });

    it('mutates adapter isVip — subsequent search() uses effectiveSearchType "all" after VIP refresh', async () => {
      // Start with isVip undefined (legacy), so effectiveSearchType would be the saved searchType
      const legacyIdx = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active' });
      // refreshStatus returns VIP
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'VIP' });
        }),
      );
      await legacyIdx.refreshStatus!();
      // Now search should use 'all' (VIP) not 'active' (legacy)
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await legacyIdx.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('mutates adapter isVip (downgrade) — subsequent search() uses "nVIP" after downgrade from VIP', async () => {
      const vipIdx = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true });
      // refreshStatus returns Power User (downgrade from VIP)
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser', classname: 'Power User' });
        }),
      );
      await vipIdx.refreshStatus!();
      // Now search should use 'nVIP' not 'all'
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await vipIdx.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('nVIP');
    });

    it('does NOT mutate adapter state when response classname is undefined', async () => {
      const vipIdx = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true });
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'testuser' }); // no classname
        }),
      );
      const result = await vipIdx.refreshStatus!();
      expect(result).toBeNull();
      // isVip should still be true (not mutated)
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await vipIdx.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('does NOT mutate adapter state when response body is empty', async () => {
      const vipIdx = new MyAnonamouseIndexer({ mamId: 'test-mam-id', baseUrl: MAM_BASE, searchLanguages: [1], searchType: 'active', isVip: true });
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.text('');
        }),
      );
      const result = await vipIdx.refreshStatus!();
      expect(result).toBeNull();
      // isVip should still be true
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      await vipIdx.search('test');
      expect(new URL(capturedUrl).searchParams.get('tor[searchType]')).toBe('all');
    });
  });

  describe('#372 — test() Mouse warning', () => {
    it('returns success with warning when classname is Mouse', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'mouseuser', classname: 'Mouse' });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.warning).toBe('Account is ratio-locked (Mouse class) — cannot download');
      expect(result.metadata).toMatchObject({ classname: 'Mouse', isVip: false });
    });

    it('returns normal success without warning for non-Mouse non-VIP classes', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'poweruser', classname: 'Power User' });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(result.metadata).toMatchObject({ classname: 'Power User', isVip: false });
    });

    it('returns normal success without warning for VIP classes', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => {
          return HttpResponse.json({ username: 'vipuser', classname: 'VIP' });
        }),
      );
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.warning).toBeUndefined();
      expect(result.metadata).toMatchObject({ classname: 'VIP', isVip: true });
    });
  });

  describe('search — per-search language options', () => {
    it('maps language names to MAM IDs via browse_lang params', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      stubTorrentDownload(server);

      await indexer.search('test', { languages: ['english', 'french'] });
      const params = new URL(capturedUrl).searchParams;
      expect(params.get('tor[browse_lang][0]')).toBe('1'); // English = 1
      expect(params.get('tor[browse_lang][1]')).toBe('36'); // French = 36
    });

    it('skips languages not in MAM_LANGUAGES mapping', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      stubTorrentDownload(server);

      await indexer.search('test', { languages: ['english', 'hindi'] });
      const params = new URL(capturedUrl).searchParams;
      expect(params.get('tor[browse_lang][0]')).toBe('1'); // English mapped
      expect(params.get('tor[browse_lang][1]')).toBeNull(); // Hindi not in MAM_LANGUAGES
    });

    it('sends no browse_lang params when languages array is empty', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      stubTorrentDownload(server);

      await indexer.search('test', { languages: [] });
      const params = new URL(capturedUrl).searchParams;
      // No browse_lang params at all
      const langKeys = [...params.keys()].filter(k => k.includes('browse_lang'));
      expect(langKeys).toHaveLength(0);
    });

    it('sends single browse_lang when one language provided', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
      stubTorrentDownload(server);

      await indexer.search('test', { languages: ['spanish'] });
      const params = new URL(capturedUrl).searchParams;
      expect(params.get('tor[browse_lang][0]')).toBe('4'); // Spanish = 4
      const langKeys = [...params.keys()].filter(k => k.includes('browse_lang'));
      expect(langKeys).toHaveLength(1);
    });
  });

  describe('schema validation', () => {
    it('search() throws IndexerError with ZodError cause when data is an object (not array)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
          HttpResponse.json({ data: { foo: 'bar' } })),
      );

      const err = await indexer.search('test').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      const zod = await import('zod');
      expect((err as IndexerError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('search() throws IndexerError with ZodError cause when both data and error are missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
          HttpResponse.json({})),
      );

      const err = await indexer.search('test').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      const zod = await import('zod');
      expect((err as IndexerError).cause).toBeInstanceOf(zod.ZodError);
    });

    it('search() still treats {error: "Nothing returned, ..."} as legitimate empty result (not a validation failure)', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
          HttpResponse.json({ error: 'Nothing returned, out of 0 hits' })),
      );

      const { results } = await indexer.search('no-results-query');
      expect(results).toEqual([]);
    });

    it('search() throws IndexerError on invalid JSON body', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
          new HttpResponse('not-json', { status: 200, headers: { 'Content-Type': 'text/plain' } })),
      );

      const err = await indexer.search('test').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
    });

    it('test() returns success: false when classname is a number', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 42 })),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/unexpected user-status response/);
    });

    it('refreshStatus() returns null when body is not JSON', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => new HttpResponse('not-json', {
          status: 200, headers: { 'Content-Type': 'text/plain' },
        })),
      );

      const result = await indexer.refreshStatus();
      expect(result).toBeNull();
    });

    it('refreshStatus() returns null when classname is missing', async () => {
      server.use(
        http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u' })),
      );

      const result = await indexer.refreshStatus();
      expect(result).toBeNull();
    });

    it('passes through unknown extra fields in search results', async () => {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
          HttpResponse.json({ data: [makeResult({ futureField: 'unknown' })] })),
      );
      stubTorrentDownload(server);

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('The Way of Kings');
    });

    // #954 — MAM emits boolean flag fields as 0/1 integers on the wire.
    // Schema must accept numeric 0/1, boolean true/false, null, and missing.
    describe.each(['free', 'fl_vip', 'vip', 'personal_freeleech'] as const)(
      '#954 — numeric/boolean coercion for %s',
      (field) => {
        it.each([
          ['numeric 0', 0],
          ['numeric 1', 1],
          ['boolean true', true],
          ['boolean false', false],
          ['null', null],
        ])('accepts %s', async (_label, value) => {
          server.use(
            http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
              HttpResponse.json({ data: [makeResult({ [field]: value })] })),
          );
          stubTorrentDownload(server);

          const { results } = await indexer.search('test');
          expect(results).toHaveLength(1);
        });

        it('accepts missing (field omitted entirely)', async () => {
          server.use(
            http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, () =>
              HttpResponse.json({ data: [makeResult()] })),
          );
          stubTorrentDownload(server);

          const { results } = await indexer.search('test');
          expect(results).toHaveLength(1);
        });
      },
    );
  });

  describe('resolveDownloadUrl — wedge logic (#1156)', () => {
    function makeWedgeIndexer(overrides: Partial<{ useFreeleechWedge: 'never' | 'preferred' | 'required'; minWedgeReserve: number; baseUrl: string }> = {}) {
      return new MyAnonamouseIndexer({
        mamId: 'test-mam-id',
        baseUrl: overrides.baseUrl ?? MAM_BASE,
        searchLanguages: [1],
        searchType: 'active',
        useFreeleechWedge: overrides.useFreeleechWedge ?? 'preferred',
        minWedgeReserve: overrides.minWedgeReserve ?? 0,
      });
    }

    function stubJsonLoadWedges(s: ReturnType<typeof useMswServer>, wedges: number) {
      s.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User', wedges })));
    }

    function stubBonusBuy(s: ReturnType<typeof useMswServer>, body: Record<string, unknown>, status = 200) {
      s.use(http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, () => HttpResponse.json(body, { status })));
    }

    it('useFreeleechWedge=never short-circuits to skipped-mode-never, no /jsonLoad fetch', async () => {
      let jsonLoadHit = false;
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => { jsonLoadHit = true; return HttpResponse.json({}); }));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'never' });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });

      expect(result.wedgeOutcome).toBe('skipped-mode-never');
      expect(jsonLoadHit).toBe(false);
      expect(result.downloadUrl).toMatch(/^data:application\/x-bittorrent;base64,/);
    });

    it('ctx.isFreeleech=true short-circuits to skipped-already-free, no /jsonLoad fetch', async () => {
      let jsonLoadHit = false;
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => { jsonLoadHit = true; return HttpResponse.json({}); }));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred' });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: true });

      expect(result.wedgeOutcome).toBe('skipped-already-free');
      expect(jsonLoadHit).toBe(false);
    });

    it('Preferred + reserve denies spend → skipped-no-inventory (downloadUrl still returned)', async () => {
      stubJsonLoadWedges(server, 3);
      let bonusBuyHit = false;
      server.use(http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, () => { bonusBuyHit = true; return HttpResponse.json({ success: true }); }));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred', minWedgeReserve: 3 });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });

      expect(result.wedgeOutcome).toBe('skipped-no-inventory');
      expect(bonusBuyHit).toBe(false);
    });

    it('Required + reserve denies spend → throws IndexerError carrying wedgeOutcome', async () => {
      stubJsonLoadWedges(server, 0);
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'required', minWedgeReserve: 0 });
      const err = await wedgeIndexer
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).toBe('skipped-no-inventory');
    });

    it('minWedgeReserve=0 honors a 0 reserve (spends when wedges > 0)', async () => {
      stubJsonLoadWedges(server, 1);
      stubBonusBuy(server, { success: true });
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred', minWedgeReserve: 0 });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('spent');
    });

    it('reserve check uses currentWedges - minWedgeReserve < 1 (denies when equal to reserve)', async () => {
      stubJsonLoadWedges(server, 2);
      stubBonusBuy(server, { success: true });
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred', minWedgeReserve: 2 });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('skipped-no-inventory');
    });

    it('spend URL uses this.baseUrl (resolves F6)', async () => {
      const customBase = 'http://mam.local';
      let postedUrl = '';
      server.use(
        http.get(`${customBase}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User', wedges: 5 })),
        http.get(`${customBase}/json/bonusBuy.php/:ts`, ({ request }) => { postedUrl = request.url; return HttpResponse.json({ success: true }); }),
        http.get(`${customBase}/tor/download.php`, () => new HttpResponse(Buffer.from('t'), { headers: { 'Content-Type': 'application/x-bittorrent' } })),
      );

      const wedgeIndexer = makeWedgeIndexer({ baseUrl: customBase });
      await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(postedUrl).toContain(`${customBase}/json/bonusBuy.php/`);
    });

    it('recognizes "This Torrent is VIP" as skipped-already-vip', async () => {
      stubJsonLoadWedges(server, 5);
      stubBonusBuy(server, { success: false, error: 'This Torrent is VIP only' });
      stubTorrentDownload(server);

      const result = await makeWedgeIndexer().resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('skipped-already-vip');
    });

    it('recognizes "This is already a personal freeleech" as skipped-idempotent', async () => {
      stubJsonLoadWedges(server, 5);
      stubBonusBuy(server, { success: false, error: 'This is already a personal freeleech, no spend' });
      stubTorrentDownload(server);

      const result = await makeWedgeIndexer().resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('skipped-idempotent');
    });

    it('generic bonusBuy failure → failed-spend (Preferred proceeds)', async () => {
      stubJsonLoadWedges(server, 5);
      stubBonusBuy(server, { success: false, error: 'Some MAM-side error' });
      stubTorrentDownload(server);

      const result = await makeWedgeIndexer({ useFreeleechWedge: 'preferred' }).resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('failed-spend');
      expect(result.downloadUrl).toMatch(/^data:application\/x-bittorrent;base64,/);
    });

    it('generic bonusBuy failure under Required → throws IndexerError(wedgeOutcome=failed-spend)', async () => {
      stubJsonLoadWedges(server, 5);
      stubBonusBuy(server, { success: false, error: 'Some MAM-side error' });

      const err = await makeWedgeIndexer({ useFreeleechWedge: 'required' })
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).toBe('failed-spend');
    });

    it('/jsonLoad.php non-200 → skipped-fetch-failed (Preferred proceeds)', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => new HttpResponse(null, { status: 500 })));
      stubTorrentDownload(server);

      const result = await makeWedgeIndexer({ useFreeleechWedge: 'preferred' }).resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('skipped-fetch-failed');
    });

    it('/jsonLoad.php non-200 → IndexerError under Required', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => new HttpResponse(null, { status: 500 })));

      const err = await makeWedgeIndexer({ useFreeleechWedge: 'required' })
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).toBe('skipped-fetch-failed');
    });

    it('ctx.guid undefined + sentinel downloadUrl → extracts tid from sentinel', async () => {
      stubJsonLoadWedges(server, 5);
      let postedQuery = '';
      server.use(
        http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, ({ request }) => {
          postedQuery = new URL(request.url).search;
          return HttpResponse.json({ success: true });
        }),
      );
      stubTorrentDownload(server);

      await makeWedgeIndexer().resolveDownloadUrl({ downloadUrl: 'mam-torrent://77777', protocol: 'torrent', isFreeleech: false });
      expect(postedQuery).toContain('torrentid=77777');
    });

    it('ctx.guid set takes precedence over the downloadUrl sentinel parse', async () => {
      stubJsonLoadWedges(server, 5);
      let postedQuery = '';
      server.use(
        http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, ({ request }) => {
          postedQuery = new URL(request.url).search;
          return HttpResponse.json({ success: true });
        }),
      );
      stubTorrentDownload(server);

      await makeWedgeIndexer().resolveDownloadUrl({ guid: '999', downloadUrl: 'mam-torrent://77777', protocol: 'torrent', isFreeleech: false });
      expect(postedQuery).toContain('torrentid=999');
    });

    it('malformed downloadUrl + missing guid → throws IndexerError', async () => {
      await expect(
        makeWedgeIndexer().resolveDownloadUrl({ downloadUrl: 'http://elsewhere/file.torrent', protocol: 'torrent', isFreeleech: false }),
      ).rejects.toBeInstanceOf(IndexerError);
    });

    it('torrent fetch failure after a successful spend → IndexerError carries wedgeOutcome="spent"', async () => {
      stubJsonLoadWedges(server, 5);
      stubBonusBuy(server, { success: true });
      server.use(http.get(`${MAM_BASE}/tor/download.php`, () => new HttpResponse(null, { status: 500 })));

      const err = await makeWedgeIndexer()
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).toBe('spent');
    });

    it('torrent fetch failure under Never (no spend) → IndexerError without spent outcome', async () => {
      server.use(http.get(`${MAM_BASE}/tor/download.php`, () => new HttpResponse(null, { status: 500 })));

      const err = await makeWedgeIndexer({ useFreeleechWedge: 'never' })
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).not.toBe('spent');
    });

    it('fetchCurrentWedges with null wedges → skipped-fetch-failed via decideWedgeSpend', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User', wedges: null })));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred' });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('skipped-fetch-failed');
    });

    it('fetchCurrentWedges with valid numeric wedges via consolidated mamUserStatusSchema', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User', wedges: 10 })));
      stubBonusBuy(server, { success: true });
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred', minWedgeReserve: 0 });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('spent');
    });

    it('spendWedge transport failure includes cause in failed-spend (Preferred proceeds with wedgeCause)', async () => {
      stubJsonLoadWedges(server, 5);
      server.use(http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, () => HttpResponse.error()));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred' });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('failed-spend');
      expect(result.wedgeCause).toEqual(expect.stringMatching(/failed|abort|error|refused|reset/i));
    });

    it('spendWedge JSON parse failure includes cause (Preferred proceeds with wedgeCause)', async () => {
      stubJsonLoadWedges(server, 5);
      server.use(http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, () => new HttpResponse('not-json', { headers: { 'Content-Type': 'text/plain' } })));
      stubTorrentDownload(server);

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'preferred' });
      const result = await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeOutcome).toBe('failed-spend');
      expect(result.wedgeCause).toEqual(expect.stringContaining('not-json'));
    });

    it('Required mode failed-spend threads cause into IndexerError.cause', async () => {
      stubJsonLoadWedges(server, 5);
      server.use(http.get(`${MAM_BASE}/json/bonusBuy.php/:ts`, () => HttpResponse.error()));

      const wedgeIndexer = makeWedgeIndexer({ useFreeleechWedge: 'required' });
      const err = await wedgeIndexer
        .resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexerError);
      expect((err as IndexerError).wedgeOutcome).toBe('failed-spend');
      const cause = (err as IndexerError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toEqual(expect.stringMatching(/failed|abort|error|refused|reset/i));
    });

    it('wedgeCfg() invariant throws IndexerError when baseUrl is empty', async () => {
      const wedgeIndexer = makeWedgeIndexer();
      // Force baseUrl empty after construction to exercise the wedgeCfg invariant directly
      (wedgeIndexer as unknown as { baseUrl: string }).baseUrl = '';

      await expect(
        wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false }),
      ).rejects.toThrow('baseUrl is empty');
    });

    it('empty-string baseUrl in constructor falls back to DEFAULT_BASE_URL for wedge requests', async () => {
      const defaultBase = 'https://www.myanonamouse.net';
      let jsonLoadUrl = '';
      server.use(
        http.get(`${defaultBase}/jsonLoad.php`, ({ request }) => { jsonLoadUrl = request.url; return HttpResponse.json({ username: 'u', classname: 'User', wedges: 5 }); }),
        http.get(`${defaultBase}/json/bonusBuy.php/:ts`, () => HttpResponse.json({ success: true })),
        http.get(`${defaultBase}/tor/download.php`, () => new HttpResponse(Buffer.from('t'), { headers: { 'Content-Type': 'application/x-bittorrent' } })),
      );

      const wedgeIndexer = new MyAnonamouseIndexer({
        mamId: 'test-mam-id',
        baseUrl: '',
        searchLanguages: [1],
        searchType: 'active',
        useFreeleechWedge: 'preferred',
      });

      await wedgeIndexer.resolveDownloadUrl({ guid: '12345', downloadUrl: 'mam-torrent://12345', protocol: 'torrent', isFreeleech: false });
      expect(jsonLoadUrl).toContain(defaultBase);
    });
  });

  describe('test() — wedges metadata (#1156)', () => {
    it('exposes wedges in metadata when /jsonLoad.php returns numeric wedges', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User', wedges: 7 })));
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.metadata?.wedges).toBe(7);
    });

    it('omits wedges from metadata when /jsonLoad.php response lacks wedges', async () => {
      server.use(http.get(`${MAM_BASE}/jsonLoad.php`, () => HttpResponse.json({ username: 'u', classname: 'User' })));
      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.metadata).not.toHaveProperty('wedges');
    });
  });
});
