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

import { AudioBookBayIndexer } from './abb.js';
import { ProxyError } from './errors.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchHtml = readFileSync(resolve(fixturesDir, 'abb-search.html'), 'utf-8');
const detailHtml = readFileSync(resolve(fixturesDir, 'abb-detail.html'), 'utf-8');
const noResultsHtml = readFileSync(resolve(fixturesDir, 'abb-no-results.html'), 'utf-8');

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;

describe('AudioBookBayIndexer', () => {
  const server = useMswServer();
  let indexer: AudioBookBayIndexer;

  beforeEach(() => {
    indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
    // Speed up tests by removing delays
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(indexer as any, 'delay').mockResolvedValue(undefined);
  });

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('abb');
      expect(indexer.name).toBe('AudioBookBay');
    });
  });

  describe('search', () => {
    it('parses search results from HTML', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].indexer).toBe('AudioBookBay');
    });

    it('extracts info hash from detail page', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].infoHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
      expect(results[0].downloadUrl).toContain('magnet:?');
    });

    it('extracts size, seeders, leechers from detail page', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      // 1.23 GB
      expect(results[0].size).toBeGreaterThan(1_000_000_000);
      expect(results[0].seeders).toBe(42);
      expect(results[0].leechers).toBe(5);
    });

    it('returns empty array when no results found', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(noResultsHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('nonexistent book');
      expect(results).toEqual([]);
    });

    it('only includes results with download URLs', async () => {
      // Detail page without info hash
      const noHashHtml = `
        <html><body>
          <h1>Some Book</h1>
          <p>No hash here</p>
        </body></html>
      `;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(noHashHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('respects limit option', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson', { limit: 1 });
      expect(results).toHaveLength(1);
    });

    it('handles search page fetch error gracefully', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });

    it('handles detail page fetch error gracefully', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      // Should not throw, just skip results without magnet URIs
      const results = await indexer.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('test', () => {
    it('returns success on HTTP 200', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 200 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain(ABB_HOST);
    });

    it('returns success on HTTP 405 (Method Not Allowed)', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 405 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
    });

    it('returns failure on HTTP error', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('503');
    });

    it('returns failure on network error', async () => {
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return HttpResponse.error();
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(false);
    });
  });

  describe('FlareSolverr proxy', () => {
    const PROXY_URL = 'http://flaresolverr.test:8191';
    let proxiedIndexer: AudioBookBayIndexer;

    beforeEach(() => {
      proxiedIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
        flareSolverrUrl: PROXY_URL,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxiedIndexer as any, 'delay').mockResolvedValue(undefined);
    });

    it('routes search through proxy when flareSolverrUrl configured', async () => {
      let searchCaptured = false;
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          const body = await request.json() as Record<string, unknown>;
          if ((body.url as string).includes('?s=')) {
            searchCaptured = true;
            return HttpResponse.json({
              status: 'ok',
              solution: { response: searchHtml, status: 200 },
            });
          }
          // Detail page
          return HttpResponse.json({
            status: 'ok',
            solution: { response: detailHtml, status: 200 },
          });
        }),
      );

      const results = await proxiedIndexer.search('Brandon Sanderson');

      expect(searchCaptured).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    it('uses GET (request.get) for proxied test, not HEAD', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return HttpResponse.json({
            status: 'ok',
            solution: { response: '<html>ok</html>', status: 200 },
          });
        }),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('via FlareSolverr');
      expect(capturedBody.cmd).toBe('request.get');
    });

    it('direct test still uses HEAD/405', async () => {
      // Non-proxied indexer should still use HEAD
      server.use(
        http.head(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 405 });
        }),
      );

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).not.toContain('FlareSolverr');
    });

    it('throws proxy errors from search page fetch (not swallowed)', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          return HttpResponse.error();
        }),
      );

      await expect(proxiedIndexer.search('test')).rejects.toThrow('FlareSolverr');
    });

    it('throws proxy errors from detail page fetch (not swallowed)', async () => {
      let callCount = 0;
      server.use(
        http.post(`${PROXY_URL}/v1`, () => {
          callCount++;
          if (callCount === 1) {
            // Search page succeeds
            return HttpResponse.json({
              status: 'ok',
              solution: { response: searchHtml, status: 200 },
            });
          }
          // Detail page proxy fails
          return HttpResponse.error();
        }),
      );

      await expect(proxiedIndexer.search('Brandon Sanderson')).rejects.toThrow('FlareSolverr');
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

  describe('edge cases — NaN parsing and malformed HTML', () => {
    it('handles NaN seeders from non-numeric text', async () => {
      const detailWithBadSeeders = `
        <html><body>
          <h1>Test Book</h1>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Seeders: N/A</p>
          <p>Size: 1.5 GB</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailWithBadSeeders, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      // "N/A" won't match the /Seeders?[:\s]*(\d+)/ regex, so seeders stays undefined
      expect(results[0].seeders).toBeUndefined();
    });

    it('handles NaN size from malformed size text', async () => {
      const detailWithBadSize = `
        <html><body>
          <h1>Test Book</h1>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Size: unknown</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailWithBadSize, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      // "unknown" won't match Size regex, so size stays undefined
      expect(results[0].size).toBeUndefined();
    });

    it('handles detail page with hash only in body text (fallback regex)', async () => {
      const detailHashInBody = `
        <html><body>
          <h1>Rare Book</h1>
          <p>Some random text a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 more text</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHashInBody, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].infoHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    });

    it('handles MB size parsing', async () => {
      const detailWithMBSize = `
        <html><body>
          <h1>Small Book</h1>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Size: 500 MB</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailWithMBSize, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      // 500 MB = 500 * 1024 * 1024 = 524288000
      expect(results[0].size).toBe(524288000);
    });

    it('extracts author and narrator from detail page text', async () => {
      const detailWithMetadata = `
        <html><body>
          <h1>Test Book</h1>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Author: Brandon Sanderson</p>
          <p>Narrator: Michael Kramer</p>
          <p>Size: 1.0 GB</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailWithMetadata, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].author).toBe('Brandon Sanderson');
      expect(results[0].narrator).toBe('Michael Kramer');
    });
  });

  describe('AbortSignal threading', () => {
    it('forwards signal to search page fetch and detail page fetch', async () => {
      const capturedSignals: AbortSignal[] = [];
      server.use(
        http.get(`${ABB_BASE}/`, ({ request }) => {
          capturedSignals.push(request.signal);
          return new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, ({ request }) => {
          capturedSignals.push(request.signal);
          return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );

      const controller = new AbortController();
      await indexer.search('test', { signal: controller.signal });

      // At least one fetch call should have a signal linked to the caller
      expect(capturedSignals.length).toBeGreaterThan(0);
      // Verify caller abort propagates through AbortSignal.any composition
      controller.abort();
      expect(capturedSignals[0].aborted).toBe(true);
    });
  });

  describe('proxy support', () => {
    const PROXY_URL = 'http://proxy.test:8080';
    let proxiedIndexer: AudioBookBayIndexer;

    beforeEach(() => {
      proxiedIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
        proxyUrl: PROXY_URL,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxiedIndexer as any, 'delay').mockResolvedValue(undefined);
    });

    it('search rethrows ProxyError when fetch connection fails', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => HttpResponse.error()),
      );

      await expect(proxiedIndexer.search('test')).rejects.toThrow(ProxyError);
    });

    it('search returns empty results for non-proxy errors', async () => {
      // Direct (non-proxied) indexer: fetch failures map to plain Error, not ProxyError,
      // so abb.search() catches and returns [] instead of rethrowing.
      const directIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(directIndexer as any, 'delay').mockResolvedValue(undefined);

      server.use(
        http.get(`${ABB_BASE}/`, () => HttpResponse.error()),
      );

      const results = await directIndexer.search('test');
      expect(results).toEqual([]);
    });

    it('test with proxy returns success with exit IP', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () =>
          new HttpResponse('<html>ok</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
        http.get('https://api.ipify.org', () => HttpResponse.json({ ip: '1.2.3.4' })),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.ip).toBe('1.2.3.4');
      expect(result.message).toContain('via proxy');
    });
  });

  describe('proxy dispatcher option (fetch-spy exception)', () => {
    // MSW intercepts at the request layer and cannot observe undici-specific
    // fetch options like `dispatcher` (`src/core/indexers/proxy.ts:67-73`
    // sets `dispatcher` directly on the RequestInit object). The only way to
    // assert that the indexer wires its proxy agent into fetch options is to
    // spy on `globalThis.fetch` and inspect the captured init argument.
    // Every other proxy scenario in this file routes through MSW; this is the
    // sole remaining fetch-spy.
    const PROXY_URL = 'http://proxy.test:8080';
    let proxiedIndexer: AudioBookBayIndexer;

    beforeEach(() => {
      proxiedIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
        proxyUrl: PROXY_URL,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(proxiedIndexer as any, 'delay').mockResolvedValue(undefined);
    });

    it('passes a dispatcher fetch option when constructed with proxyUrl', async () => {
      let callCount = 0;
      // MSW cannot observe the undici-specific `dispatcher` fetch option — see
      // describe-block comment. This spy is the documented exception.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(searchHtml, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response(detailHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      });

      const results = await proxiedIndexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].indexer).toBe('AudioBookBay');
      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs[1] as Record<string, unknown>).dispatcher).toBeDefined();

      fetchSpy.mockRestore();
    });
  });

  describe('guid population (#410)', () => {
    it('search results include guid matching infoHash from detail page', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].guid).toBe(results[0].infoHash);
      expect(results[0].guid).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
    });

    it('guid is a lowercase 40-char hex string on returned results', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('Brandon Sanderson');

      expect(results[0].guid).toMatch(/^[a-f0-9]{40}$/);
    });

    it('detail page with hash in body text (fallback regex) populates guid', async () => {
      const detailHashInBody = `
        <html><body>
          <h1>Rare Book</h1>
          <p>Some random text a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 more text</p>
        </body></html>`;

      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHashInBody, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const results = await indexer.search('test');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].guid).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
      expect(results[0].guid).toBe(results[0].infoHash);
    });
  });
});
