import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Keep MSW/fetch spies on this test path while production retains dispatcher routing.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

import { TorznabIndexer } from './torznab.js';
import { NewznabIndexer } from './newznab.js';
import { ProxyError } from './errors.js';
import { useSolverBound } from '../__tests__/solver-bound.js';
import {
  abortRejection,
  codedRejection,
  routeFetch,
  solverEnvelope,
  type RoutedFetch,
} from '../__tests__/solver-routes.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchXml = readFileSync(resolve(fixturesDir, 'torznab-search.xml'), 'utf-8');
const capsXml = readFileSync(resolve(fixturesDir, 'torznab-caps.xml'), 'utf-8');

const API_BASE = 'https://tracker.test';

describe('TorznabIndexer', () => {
  const server = useMswServer();
  let indexer: TorznabIndexer;

  beforeEach(() => {
    indexer = new TorznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('torznab');
      expect(indexer.name).toBe('tracker.test');
    });

    it('uses custom name when provided', () => {
      const named = new TorznabIndexer(
        { apiUrl: API_BASE, apiKey: 'key' },
        'My Tracker',
      );
      expect(named.name).toBe('My Tracker');
    });
  });

  describe('search', () => {
    it('sends a User-Agent: Narratorr/<version> header on the API request (#1315)', async () => {
      // Pin the version independently of the runner's environment.
      vi.stubEnv('GIT_TAG', 'v9.9.9');
      let userAgent: string | null = null;
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          userAgent = request.headers.get('user-agent');
          return new HttpResponse(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } });
        }),
      );

      await indexer.search('Brandon Sanderson');

      expect(userAgent).toBe('Narratorr/v9.9.9');
    });

    it('parses search results from XML', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results).toHaveLength(3);
      expect(results[0]!.title).toBe(
        'The Way of Kings - Brandon Sanderson (Unabridged)',
      );
      expect(results[0]!.protocol).toBe('torrent');
      expect(results[0]!.indexer).toBe('tracker.test');
    });

    it('extracts download URL from enclosure', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.downloadUrl).toBe(
        'https://tracker.test/download/abc123.torrent',
      );
    });

    it('extracts seeders and leechers from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.seeders).toBe(15);
      expect(results[0]!.leechers).toBe(3);
      expect(results[1]!.seeders).toBe(8);
      expect(results[1]!.leechers).toBe(1);
    });

    it('extracts infoHash from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.infoHash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
      expect(results[1]!.infoHash).toBe('b1d5781111d84f7b3fe45a0852e59758cd7a87e5');
    });

    it('extracts size from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.size).toBe(1073741824);
      expect(results[1]!.size).toBe(2147483648);
    });

    it('extracts grabs from torznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.grabs).toBe(42);
      expect(results[1]!.grabs).toBe(18);
    });

    it('builds magnet URI when no download URL but infoHash present', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      // Fixture item 3 has only an infoHash.
      expect(results[2]!.downloadUrl).toContain('magnet:?');
      expect(results[2]!.downloadUrl).toContain('da4b9237bacccdf19c0760cab7aec4a8359010b0');
      expect(results[2]!.infoHash).toBe('da4b9237bacccdf19c0760cab7aec4a8359010b0');
    });

    it('extracts details URL from guid', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.detailsUrl).toBe('https://tracker.test/details/abc123');
    });

    it('extracts guid from <guid> element', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.guid).toBe('https://tracker.test/details/abc123');
      expect(results[1]!.guid).toBe('https://tracker.test/details/def456');
      expect(results[2]!.guid).toBe('https://tracker.test/details/ghi789');
    });

    it('returns undefined guid when <guid> element is missing', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>No Guid Torrent</title>
            <enclosure url="https://tracker.test/dl/1.torrent" length="1000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.guid).toBeUndefined();
    });

    it('respects limit option', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('Brandon Sanderson', { limit: 1 });

      expect(results).toHaveLength(1);
    });

    it('sends author param when provided', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      await indexer.search('Stormlight', { author: 'Brandon Sanderson' });

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('author')).toBe('Brandon Sanderson');
      expect(url.searchParams.get('q')).toBe('Stormlight');
    });

    it('sends correct API params', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      await indexer.search('test query');

      const url = new URL(capturedUrl);
      expect(url.searchParams.get('t')).toBe('search');
      expect(url.searchParams.get('apikey')).toBe('testapikey');
      expect(url.searchParams.get('cat')).toBe('3030');
      expect(url.searchParams.get('q')).toBe('test query');
    });

    it('throws on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow();
    });

    it('throws on non-200 response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow();
    });

    it('returns empty array on empty response', async () => {
      const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0"><channel><title>Empty</title></channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(emptyXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('nonexistent');
      expect(results).toEqual([]);
    });

    it('throws on invalid non-RSS XML payload', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse('<html><body>Not RSS</body></html>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow('Invalid RSS response');
    });

    it('throws with API error description for torznab error responses', async () => {
      const errorXml = `<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Incorrect user credentials"/>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(errorXml, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow('Torznab API error: Incorrect user credentials');
    });
  });

  describe('parse trace shape (#932 AC1)', () => {
    it('populates parseStats and transport metadata for Torznab adapters', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed" version="2.0">
  <channel>
    <item>
      <title>Sample Audiobook FLAC 2024</title>
      <guid>https://tracker.test/details/abc</guid>
      <enclosure url="magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d" length="100000" />
      <torznab:attr name="seeders" value="5" />
    </item>
  </channel>
</rss>`;
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, { headers: { 'Content-Type': 'application/xml' } });
        }),
      );

      const response = await indexer.search('test');
      expect(response.parseStats.itemsObserved).toBeGreaterThanOrEqual(1);
      expect(response.requestUrl).toContain(`${API_BASE}/api`);
      expect(response.httpStatus).toBe(200);
      expect(response.debugTrace.some((t) => t.reason === 'kept' && t.rawTitleBytes)).toBe(true);
    });

    it('records dropped:no-url for items without enclosure/link/infoHash (#932 F4)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed" version="2.0">
  <channel>
    <item>
      <title>Sample Without Any URL</title>
      <guid>no-url-tor</guid>
    </item>
  </channel>
</rss>`;
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, { headers: { 'Content-Type': 'application/xml' } });
        }),
      );

      const response = await indexer.search('test');
      expect(response.results).toEqual([]);
      expect(response.parseStats.dropped.noUrl).toBe(1);
      expect(response.debugTrace.some((t) => t.reason === 'dropped:no-url')).toBe(true);
    });
  });

  describe('test', () => {
    it('returns success on valid caps response', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(capsXml, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Test Torznab Indexer');
    });

    it('returns success with fallback name when no server title', async () => {
      const minimalCaps = `<?xml version="1.0"?><caps><searching/></caps>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(minimalCaps, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('tracker.test');
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(null, { status: 401 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
    });
  });

  describe('FlareSolverr proxy', () => {
    const PROXY_URL = 'http://flaresolverr.test:8191';
    let proxiedIndexer: TorznabIndexer;

    beforeEach(() => {
      proxiedIndexer = new TorznabIndexer({
        apiUrl: API_BASE,
        apiKey: 'testapikey',
        flareSolverrUrl: PROXY_URL,
      });
    });

    it('routes search through proxy when flareSolverrUrl configured', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: searchXml, status: 200 },
          });
        }),
      );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(capturedBody.cmd).toBe('request.get');
      expect(capturedBody.url).toContain(`${API_BASE}/api`);
      expect(results).toHaveLength(3);
    });

    it('routes test through proxy when flareSolverrUrl configured', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({
            status: 'ok',
            solution: { response: capsXml, status: 200 },
          });
        }),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('Test Torznab Indexer');
    });

    it('throws proxy errors from search (not swallowed)', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(proxiedIndexer.search('test')).rejects.toThrow('FlareSolverr');
    });

    it('does not resolve proxy IP when FlareSolverr takes precedence', async () => {
      const combinedIndexer = new TorznabIndexer({
        apiUrl: API_BASE,
        apiKey: 'testapikey',
        flareSolverrUrl: PROXY_URL,
        proxyUrl: 'http://proxy.test:8080',
      });

      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({
            status: 'ok',
            solution: { response: capsXml, status: 200 },
          });
        }),
      );

      const result = await combinedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.ip).toBeUndefined();
    });

    it('returns failure on proxy error during test', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.json({ status: 'error', message: 'Challenge failed' });
        }),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('FlareSolverr');
    });
  });

  describe('edge cases — NaN parsing', () => {
    it('handles NaN size from invalid attr value', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>NaN Size Book</title>
            <enclosure url="https://tracker.test/dl/1.torrent" length="notanumber"/>
            <torznab:attr name="size" value="notanumber"/>
            <torznab:attr name="seeders" value="5"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.size).toBeUndefined();
    });

    it('handles NaN seeders/leechers/grabs from invalid attr values', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>NaN Stats Book</title>
            <enclosure url="https://tracker.test/dl/1.torrent" length="1000"/>
            <torznab:attr name="seeders" value="abc"/>
            <torznab:attr name="leechers" value="xyz"/>
            <torznab:attr name="grabs" value="!!!"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.seeders).toBeUndefined();
      expect(results[0]!.leechers).toBeUndefined();
      expect(results[0]!.grabs).toBeUndefined();
    });

    it('handles empty string infohash → undefined', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Empty Hash Book</title>
            <enclosure url="https://tracker.test/dl/1.torrent" length="1000"/>
            <torznab:attr name="infohash" value=""/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.infoHash).toBeUndefined();
    });

    it('skips items with empty title', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>   </title>
            <enclosure url="https://tracker.test/dl/1.torrent"/>
          </item>
          <item>
            <title>Valid Title</title>
            <enclosure url="https://tracker.test/dl/2.torrent"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Valid Title');
    });

    it('falls back to enclosure length when no size attr', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Enclosure Size</title>
            <enclosure url="https://tracker.test/dl/1.torrent" length="5000000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const { results } = await indexer.search('test');
      expect(results[0]!.size).toBe(5000000);
    });

    it('strips trailing slashes from apiUrl', () => {
      const idx = new TorznabIndexer({
        apiUrl: 'https://tracker.test///',
        apiKey: 'key',
      });
      expect(idx.name).toBe('tracker.test');
    });
  });

  describe('proxy support', () => {
    const PROXY_URL = 'http://proxy.test:8080';
    let proxiedIndexer: TorznabIndexer;

    beforeEach(() => {
      proxiedIndexer = new TorznabIndexer({
        apiUrl: API_BASE,
        apiKey: 'testapikey',
        proxyUrl: PROXY_URL,
      });
    });

    it('routes search through proxy when proxyUrl is set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(searchXml, {
          status: 200,
          headers: { 'Content-Type': 'application/rss+xml' },
        }),
      );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(results).toHaveLength(3);
      expect(results[0]!.title).toBe('The Way of Kings - Brandon Sanderson (Unabridged)');
      expect(fetchSpy).toHaveBeenCalledOnce();
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs![1] as Record<string, unknown>).dispatcher).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('search rethrows ProxyError', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );

      await expect(proxiedIndexer.search('test')).rejects.toThrow(ProxyError);

      fetchSpy.mockRestore();
    });

    it('search throws non-proxy errors (not swallowed)', async () => {
      const directIndexer = new TorznabIndexer({
        apiUrl: API_BASE,
        apiKey: 'testapikey',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('some random error'),
      );

      await expect(directIndexer.search('test')).rejects.toThrow('some random error');

      fetchSpy.mockRestore();
    });

    it('test with proxy returns success with exit IP', async () => {
      const ipifyResponse = JSON.stringify({ ip: '1.2.3.4' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(capsXml, {
            status: 200,
            headers: { 'Content-Type': 'application/xml' },
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
      expect(result.message).toContain('Test Torznab Indexer');

      fetchSpy.mockRestore();
    });
  });

  describe('AbortSignal threading', () => {
    it('forwards signal to fetch helper when provided via options', async () => {
      let capturedSignal: AbortSignal | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } });
      });

      const controller = new AbortController();
      await indexer.search('test', { signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);

      fetchSpy.mockRestore();
    });
  });

  describe('search — extended attrs (#272)', () => {
    it('includes attrs=grabs,language in search URL', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      await indexer.search('test');
      const params = new URL(capturedUrl).searchParams;
      expect(params.get('attrs')).toBe('grabs,language');
    });

    it('extracts language from torznab:attr into SearchResult.language', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.torrent" length="1000" type="application/x-bittorrent"/>
          <torznab:attr name="language" value="fre"/>
          <torznab:attr name="seeders" value="5"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBe('french');
    });

    it('normalizes language code to lowercase full name', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.torrent" length="1000" type="application/x-bittorrent"/>
          <torznab:attr name="language" value="GER"/>
          <torznab:attr name="seeders" value="5"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBe('german');
    });

    it('returns undefined language when language attr is missing', async () => {
      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const { results } = await indexer.search('test');
      expect(results[0]!.language).toBeUndefined();
    });
  });

  /**
   * #2373: every solver-bound `fetchXml` takes a slot from the bound keyed on its solver, so two
   * adapters of different types pointed at one solver contend for the same three browsers.
   */
  describe('solver concurrency bound (#2373)', () => {
    const PROXY_URL = 'http://flaresolverr.test:8191';
    const bound = useSolverBound(server);
    let proxiedIndexer: TorznabIndexer;

    beforeEach(() => {
      proxiedIndexer = new TorznabIndexer({
        apiUrl: API_BASE,
        apiKey: 'testapikey',
        flareSolverrUrl: PROXY_URL,
      });
    });

    it('takes a slot for a solver-bound search and surfaces the slot wait as a ProxyError', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

      const timer = bound.captureTimers();
      const searching = bound.track(proxiedIndexer.search('test'));
      // Wait until the search has declared itself queued or admitted; over-admission then fails the
      // pending() assertion rather than hanging on a deadline that was never armed.
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      expect(timer.pending()).toBe(1);
      timer.fire();

      await expect(searching).rejects.toThrow(/waiting for a request slot/);
      await expect(searching).rejects.toBeInstanceOf(ProxyError);
      expect(stub.observed).toBe(bound.max);
    });

    it('takes no slot when the same indexer has no flareSolverrUrl', async () => {
      const solver = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(solver, PROXY_URL);

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const { results } = await indexer.search('test');
      expect(results).toHaveLength(3);
    });

    it('shares one solver bound across a Torznab and a Newznab indexer', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      const newznab = new NewznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey', flareSolverrUrl: PROXY_URL });

      bound.track(newznab.search('test'));
      for (let i = 1; i < bound.max; i++) bound.track(proxiedIndexer.search(`test-${i}`));
      await stub.reaches(bound.max);

      // Installed only now: an adapter hard-codes PROXY_TIMEOUT_MS for its request timer, which
      // equals the slot-wait delay, so capturing earlier would count admitted requests as queued.
      const timers = bound.captureTimers();

      bound.track(proxiedIndexer.search('one-too-many'));
      // The extra search declares itself queued by arming a slot-wait deadline against the shared
      // pool — the same bound the Newznab search is occupying.
      await bound.accountedFor(stub, timers, { arrived: bound.max, queued: 1 });

      expect(timers.pending()).toBe(1);
      expect(stub.observed).toBe(bound.max);
      expect(stub.targets.some((target) => target.includes('one-too-many'))).toBe(false);
    });
  });
});

/**
 * #2374 — the same four-way vocabulary the ABB adapter renders, on the torznab probe target. The
 * host comes from `apiUrl`, not from the indexer's display name, so this adapter is constructed
 * with a name that differs from its host.
 */
describe('TorznabIndexer — solver failure diagnosis (#2374)', () => {
  useMswServer();

  const SOLVER_URL = 'http://flaresolverr.test:8191';
  const SOLVER_ENDPOINT = `${SOLVER_URL}/v1`;
  const API_HOST = 'tracker.test';
  let indexer: TorznabIndexer;
  let routed: RoutedFetch | undefined;

  beforeEach(() => {
    indexer = new TorznabIndexer(
      { apiUrl: API_BASE, apiKey: 'testapikey', flareSolverrUrl: SOLVER_URL },
      'My Tracker',
    );
  });

  afterEach(() => {
    routed?.restore();
    routed = undefined;
  });

  it('names the target host from apiUrl when the site refuses connections', async () => {
    routed = routeFetch((url, method) => {
      if (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)) return abortRejection();
      if (method === 'HEAD' && url.includes(API_HOST)) return codedRejection('ECONNREFUSED');
      if (method === 'HEAD') return new Response(null, { status: 405 });
      return undefined;
    });

    const result = await indexer.test();

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      `Target unreachable: ${API_HOST} refused the connection (ECONNREFUSED). Probed directly, not through the solver.`,
    );
    expect(result.message).not.toContain('My Tracker');
  });

  it('names the solver address when the solver itself refuses, and issues no probe', async () => {
    const calls = routeFetch((url, method) => (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)
      ? codedRejection('ECONNREFUSED')
      : undefined));
    routed = calls;

    const result = await indexer.test();

    expect(result.message).toBe(`Solver unreachable: ${SOLVER_ENDPOINT} refused the connection (ECONNREFUSED).`);
    expect(calls.probes()).toEqual([]);
  });

  it('probes the API origin rather than the caps URL, so no api key goes onto the probe wire', async () => {
    const calls = routeFetch((url, method) => {
      if (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)) return solverEnvelope({ status: 'error', message: 'Challenge failed' });
      if (method === 'HEAD') return new Response(null, { status: 200 });
      return undefined;
    });
    routed = calls;

    const result = await indexer.test();

    expect(result.message).toMatch(/^No page came back\./);
    expect(calls.probes().map((call) => call.url)).toEqual([API_BASE]);
  });

  it('keeps a non-solver failure verbatim when no solver is configured (AC7)', async () => {
    const plainIndexer = new TorznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey' });
    routed = routeFetch((url) => (url.includes(API_HOST) ? codedRejection('ECONNREFUSED') : undefined));

    const result = await plainIndexer.test();

    expect(result.message).toMatch(/^Connection refused on port /);
  });
});
