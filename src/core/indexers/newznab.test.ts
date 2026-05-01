import { describe, it, expect, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import type * as NetworkServiceModule from '../utils/network-service.js';

// Route undiciFetch through globalThis.fetch so MSW handlers and
// `vi.spyOn(globalThis, 'fetch')` continue to intercept the proxy path.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    undiciFetch: ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args)) as unknown as typeof actual.undiciFetch,
  };
});

import { NewznabIndexer } from './newznab.js';
import { ProxyError } from './errors.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchXml = readFileSync(resolve(fixturesDir, 'newznab-search.xml'), 'utf-8');
const capsXml = readFileSync(resolve(fixturesDir, 'newznab-caps.xml'), 'utf-8');

const API_BASE = 'https://indexer.test';

describe('NewznabIndexer', () => {
  const server = useMswServer();
  let indexer: NewznabIndexer;

  beforeEach(() => {
    indexer = new NewznabIndexer({ apiUrl: API_BASE, apiKey: 'testapikey' });
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('newznab');
      expect(indexer.name).toBe('indexer.test');
    });

    it('uses custom name when provided', () => {
      const named = new NewznabIndexer(
        { apiUrl: API_BASE, apiKey: 'key' },
        'My Indexer',
      );
      expect(named.name).toBe('My Indexer');
    });
  });

  describe('search', () => {
    it('parses search results from XML', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe(
        'The Way of Kings - Brandon Sanderson (Unabridged)',
      );
      expect(results[0].protocol).toBe('usenet');
      expect(results[0].indexer).toBe('indexer.test');
    });

    it('extracts download URL from enclosure', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].downloadUrl).toBe(
        'https://indexer.test/getnzb/abc123.nzb?i=1&r=testapikey',
      );
    });

    it('extracts size from newznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].size).toBe(1073741824); // 1 GB
      expect(results[1].size).toBe(2147483648); // 2 GB
    });

    it('extracts grabs from newznab:attr', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].grabs).toBe(42);
      expect(results[1].grabs).toBe(18);
    });

    it('extracts details URL from guid', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].detailsUrl).toBe('https://indexer.test/details/abc123');
    });

    it('extracts guid from <guid> element', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].guid).toBe('https://indexer.test/details/abc123');
      expect(results[1].guid).toBe('https://indexer.test/details/def456');
      expect(results[2].guid).toBe('https://indexer.test/details/ghi789');
    });

    it('returns undefined guid when <guid> element is missing', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>No Guid Book</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="1000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0].guid).toBeUndefined();
    });

    it('respects limit option', async () => {
      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(searchXml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson', { limit: 1 });

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

      const results = await indexer.search('nonexistent');
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

    it('throws with API error description for newznab error responses', async () => {
      const errorXml = `<?xml version="1.0" encoding="UTF-8"?><error code="100" description="Incorrect user credentials"/>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(errorXml, {
            headers: { 'Content-Type': 'application/xml' },
          });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow('Newznab API error: Incorrect user credentials');
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
      expect(result.message).toContain('Test Newznab Indexer');
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
      expect(result.message).toContain('indexer.test');
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
    let proxiedIndexer: NewznabIndexer;

    beforeEach(() => {
      proxiedIndexer = new NewznabIndexer({
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

      const results = await proxiedIndexer.search('test');

      expect(capturedBody.cmd).toBe('request.get');
      expect(capturedBody.url).toContain(`${API_BASE}/api`);
      expect(results.length).toBeGreaterThan(0);
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
      const combinedIndexer = new NewznabIndexer({
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
            <enclosure url="https://indexer.test/dl/1.nzb" length="abc"/>
            <newznab:attr name="size" value="notanumber"/>
            <newznab:attr name="grabs" value="10"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      // Number('notanumber') = NaN, size || undefined = undefined
      expect(results[0].size).toBeUndefined();
    });

    it('handles NaN grabs from invalid attr value', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>NaN Grabs</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="1000"/>
            <newznab:attr name="grabs" value="xyz"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0].grabs).toBeUndefined();
    });

    it('skips items with empty title', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title></title>
            <enclosure url="https://indexer.test/dl/empty.nzb"/>
          </item>
          <item>
            <title>Valid Title</title>
            <enclosure url="https://indexer.test/dl/valid.nzb"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Valid Title');
    });

    it('falls back to enclosure length when no size attr', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Enclosure Size</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="5000000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].size).toBe(5000000);
    });

    it('uses usenet protocol for all results', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Usenet Book</title>
            <enclosure url="https://indexer.test/dl/1.nzb" length="1000"/>
          </item>
        </channel></rss>`;

      server.use(
        http.get(`${API_BASE}/api`, () => {
          return new HttpResponse(xml, {
            headers: { 'Content-Type': 'application/rss+xml' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results[0].protocol).toBe('usenet');
    });

    it('strips trailing slashes from apiUrl', () => {
      const idx = new NewznabIndexer({
        apiUrl: 'https://indexer.test///',
        apiKey: 'key',
      });
      expect(idx.name).toBe('indexer.test');
    });
  });

  describe('proxy support', () => {
    const PROXY_URL = 'http://proxy.test:8080';
    let proxiedIndexer: NewznabIndexer;

    beforeEach(() => {
      proxiedIndexer = new NewznabIndexer({
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

      const results = await proxiedIndexer.search('Brandon Sanderson');

      expect(results).toHaveLength(3);
      expect(results[0].title).toBe('The Way of Kings - Brandon Sanderson (Unabridged)');
      // Verify fetch was called with a dispatcher (proxy agent)
      expect(fetchSpy).toHaveBeenCalledOnce();
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBeDefined();

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
      // Create a non-proxied indexer so errors are NOT wrapped as ProxyError
      const directIndexer = new NewznabIndexer({
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
      expect(result.message).toContain('Test Newznab Indexer');

      fetchSpy.mockRestore();
    });
  });

  describe('AbortSignal threading', () => {
    it('forwards signal to fetch helper when provided via options', async () => {
      let capturedSignal: AbortSignal | undefined;

      // Spy on fetch to capture the signal
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } });
      });

      const controller = new AbortController();
      await indexer.search('test', { signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      // Aborting the caller signal should propagate through the composed signal
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);

      fetchSpy.mockRestore();
    });
  });

  describe('search — extended attrs (#272)', () => {
    it('includes attrs=grabs,language,group,files in search URL', async () => {
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
      expect(params.get('attrs')).toBe('grabs,language,group,files');
    });

    it('extracts language from newznab:attr into SearchResult.language', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.nzb" length="1000" type="application/x-nzb"/>
          <newznab:attr name="language" value="eng"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].language).toBe('english');
    });

    it('extracts newsgroup from newznab:attr into SearchResult.newsgroup', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.nzb" length="1000" type="application/x-nzb"/>
          <newznab:attr name="group" value="alt.binaries.audiobooks"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].newsgroup).toBe('alt.binaries.audiobooks');
    });

    it('normalizes language code to lowercase full name (e.g. ENG → english)', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.nzb" length="1000" type="application/x-nzb"/>
          <newznab:attr name="language" value="GER"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].language).toBe('german');
    });

    it('returns undefined language when language attr is missing', async () => {
      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].language).toBeUndefined();
    });

    it('returns undefined newsgroup when group attr is missing', async () => {
      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(searchXml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].newsgroup).toBeUndefined();
    });

    it('handles non-numeric grabs value gracefully', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.nzb" length="1000" type="application/x-nzb"/>
          <newznab:attr name="grabs" value="invalid"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].grabs).toBeUndefined();
    });

    it('handles grabs value of "0" as 0 not undefined', async () => {
      const xml = `<?xml version="1.0"?>
        <rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
        <channel><item>
          <title>Test Book</title>
          <enclosure url="https://indexer.test/dl/1.nzb" length="1000" type="application/x-nzb"/>
          <newznab:attr name="grabs" value="0"/>
        </item></channel></rss>`;

      server.use(http.get(`${API_BASE}/api`, () =>
        new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ));

      const results = await indexer.search('test');
      expect(results[0].grabs).toBe(0);
    });
  });
});
