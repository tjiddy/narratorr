import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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

import { AudioBookBayIndexer } from './abb.js';
import { ProxyError } from './errors.js';
import { solverOk, useSolverBound } from '../__tests__/solver-bound.js';
import {
  abortRejection,
  codedRejection,
  hangUntilAborted,
  routeFetch,
  solverEnvelope,
  uncodedRejection,
  type RouteOutcome,
  type RoutedFetch,
} from '../__tests__/solver-routes.js';
import { REACHABILITY_PROBE_TIMEOUT_MS } from '../utils/constants.js';
import type { SearchResult } from './types.js';

const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');
const searchHtml = readFileSync(resolve(fixturesDir, 'abb-search.html'), 'utf-8');
const detailHtml = readFileSync(resolve(fixturesDir, 'abb-detail.html'), 'utf-8');
const samePersonHtml = readFileSync(resolve(fixturesDir, 'abb-detail-same-person.html'), 'utf-8');
const perRequestHtml = readFileSync(resolve(fixturesDir, 'abb-detail-per-request.html'), 'utf-8');
const noResultsHtml = readFileSync(resolve(fixturesDir, 'abb-no-results.html'), 'utf-8');

/** Every string a downstream gate, score or badge can read off a result. */
function stringFieldsOf(result: SearchResult): string[] {
  return Object.values(result).filter((value): value is string => typeof value === 'string');
}

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;

describe('AudioBookBayIndexer', () => {
  const server = useMswServer();
  let indexer: AudioBookBayIndexer;

  beforeEach(() => {
    indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
    // Eliminate scraper throttling in tests.
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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.indexer).toBe('AudioBookBay');
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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.infoHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
      expect(results[0]!.downloadUrl).toContain('magnet:?');
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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.size).toBeGreaterThan(1_000_000_000);
      expect(results[0]!.seeders).toBe(42);
      expect(results[0]!.leechers).toBe(5);
    });

    it('returns empty array when no results found', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(noResultsHtml, {
            headers: { 'Content-Type': 'text/html' },
          });
        }),
      );

      const { results } = await indexer.search('nonexistent book');
      expect(results).toEqual([]);
    });

    it('only includes results with download URLs', async () => {
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

      const { results } = await indexer.search('test');
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

      const { results } = await indexer.search('Brandon Sanderson', { limit: 1 });
      expect(results).toHaveLength(1);
    });

    // #2375: an empty success here would read to the query ladder as an answered zero, so the
    // ladder would advance and re-ask a dead indexer once per relaxed rung.
    it('propagates a first-page fetch error instead of reporting an answered zero', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      await expect(indexer.search('test')).rejects.toThrow('HTTP 503');
    });

    it('keeps the structural status on the propagated first-page error', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(null, { status: 503 });
        }),
      );

      const error = await indexer.search('test').catch((e: unknown) => e);

      expect((error as { httpStatus?: unknown }).httpStatus).toBe(503);
    });

    it('still returns the pages it did get when a LATER page fails', async () => {
      const twoPageIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(twoPageIndexer as any, 'delay').mockResolvedValue(undefined);
      server.use(
        http.get(`${ABB_BASE}/`, () => new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } })),
        http.get(`${ABB_BASE}/page/2/`, () => new HttpResponse(null, { status: 503 })),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } })),
      );

      // The indexer demonstrably answered page one, so this is partial success, not a failure.
      const { results } = await twoPageIndexer.search('test');

      expect(results.length).toBeGreaterThan(0);
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

      const { results } = await indexer.search('test');
      expect(results).toEqual([]);
    });
  });

  describe('parse trace shape (#932 AC1)', () => {
    it('populates parseStats and per-row debugTrace including search-page transport metadata', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () => {
          return new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
          return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );

      const response = await indexer.search('Brandon Sanderson');

      expect(response.requestUrl).toBeDefined();
      expect(response.requestUrl).toContain(ABB_BASE);
      expect(response.httpStatus).toBe(200);
      expect(response.parseStats.kept).toBe(response.results.length);
      expect(response.debugTrace.some((t) => t.reason === 'kept' && t.rawTitleBytes)).toBe(true);
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
          return HttpResponse.json({
            status: 'ok',
            solution: { response: detailHtml, status: 200 },
          });
        }),
      );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

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
            return HttpResponse.json({
              status: 'ok',
              solution: { response: searchHtml, status: 200 },
            });
          }
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

      const { results } = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.seeders).toBeUndefined();
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

      const { results } = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.size).toBeUndefined();
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

      const { results } = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.infoHash).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
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

      const { results } = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      // 500 MB * 1024 * 1024
      expect(results[0]!.size).toBe(524288000);
    });

    it('extracts author and narrator from the detail page structured block', async () => {
      const detailWithMetadata = `
        <html><body>
          <h1>Test Book</h1>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Written by <a href="/a/"><span class="author" itemprop="author">Brandon Sanderson</span></a>
          <br>Read by <a href="/n/"><span class="narrator" itemprop="author">Michael Kramer</span></a></p>
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

      const { results } = await indexer.search('test');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.author).toBe('Brandon Sanderson');
      expect(results[0]!.narrator).toBe('Michael Kramer');
    });
  });

  describe('structured metadata block (#2365)', () => {
    /** Both fixture rows resolve through the same detail handler, so one body serves the whole page. */
    function serveDetail(html: string) {
      server.use(
        http.get(`${ABB_BASE}/`, () => new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } })),
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(html, { headers: { 'Content-Type': 'text/html' } })),
      );
    }

    it('reads author, narrator and format from the page\'s own elements', async () => {
      serveDetail(detailHtml);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.author).toBe('Carol Cole');
      expect(results[0]!.narrator).toBe('James MacNaughton');
      expect(results[0]!.format).toBe('m4b');
    });

    it('never reports the uploader as the author', async () => {
      serveDetail(detailHtml);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.author).toBe('Carol Cole');
      for (const result of results) {
        expect(stringFieldsOf(result).join(' | ')).not.toContain('greads123');
        expect(stringFieldsOf(result).join(' | ')).not.toContain('uploader123');
      }
    });

    it('keeps both roles on a page where the author narrates their own book', async () => {
      serveDetail(samePersonHtml);

      const { results } = await indexer.search('Wish You Were Here Yet?');

      expect(results[0]!.author).toBe('James Crookes');
      expect(results[0]!.narrator).toBe('James Crookes');
      expect(results[0]!.format).toBe('m4b');
    });

    it('parses the post body\'s three shapes identically — colons, no colons, and no boilerplate', async () => {
      for (const [html, expected] of [
        [detailHtml, { author: 'Carol Cole', narrator: 'James MacNaughton' }],
        [samePersonHtml, { author: 'James Crookes', narrator: 'James Crookes' }],
        [perRequestHtml, { author: 'Marilyn Ross', narrator: 'Kathleen Gati' }],
      ] as const) {
        serveDetail(html);
        const { results } = await indexer.search('test');

        expect(results[0]!.author).toBe(expected.author);
        expect(results[0]!.narrator).toBe(expected.narrator);
        expect(results[0]!.format).toBe('m4b');
      }
    });

    it('is unmoved by what the uploader wrote in the post body', async () => {
      serveDetail(detailHtml.replace('By: Carol Cole', 'By: Someone Else Entirely'));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.author).toBe('Carol Cole');
    });

    it('reads exact values from a block whose <br> separators flatten with no whitespace', async () => {
      // The shipped fixture writes the whole block on one source line — the shape that made
      // /Format:\s*([^\n]+)/i capture "M4BBitrate: 128 KbpsUnabridged".
      expect(detailHtml).toContain('</span></a><br>Read by');
      serveDetail(detailHtml);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.format).toBe('m4b');
      expect(results[0]!.author).toBe('Carol Cole');
    });

    it('lowercases a format the page already wrote in lowercase', async () => {
      serveDetail(detailHtml.replace('>M4B<', '>m4b<'));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.format).toBe('m4b');
    });

    it('takes the container format, not the abridgement wording', async () => {
      serveDetail(detailHtml.replace('<span class="is_abridged">Unabridged</span>', 'Format<br> Unabridged Audiobook'));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.format).toBe('m4b');
    });

    it('leaves narrator absent when the page carries no narrator span', async () => {
      serveDetail(detailHtml.replace(/<a href="\/audio-books\/narrator\/[^"]+\/"><span class="narrator"[^>]*>[^<]*<\/span><\/a>/, ''));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]).not.toHaveProperty('narrator');
      expect(results[0]!.author).toBe('Carol Cole');
    });

    it('leaves author absent when the page carries no author span', async () => {
      serveDetail(detailHtml.replace(/<a href="\/audio-books\/author\/[^"]+\/"><span class="author"[^>]*>[^<]*<\/span><\/a>/, ''));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]).not.toHaveProperty('author');
      expect(results[0]!.narrator).toBe('James MacNaughton');
    });

    it('leaves format absent when the page carries no format span', async () => {
      serveDetail(detailHtml.replace(/<span class="format"[^>]*>[^<]*<\/span>/, ''));

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]).not.toHaveProperty('format');
      expect(results[0]!.author).toBe('Carol Cole');
    });

    it('folds whitespace-only spans to absence, never to an empty string', async () => {
      serveDetail(
        detailHtml
          .replace('>Carol Cole<', '>   <')
          .replace('>James MacNaughton<', '> <')
          .replace('>M4B<', '>  <'),
      );

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]).not.toHaveProperty('author');
      expect(results[0]).not.toHaveProperty('narrator');
      expect(results[0]).not.toHaveProperty('format');
    });

    it('reads an author-only detail block past the page\'s annotated uploader byline', async () => {
      // The narrator and format spans are what usually anchor the block; strip them and the byline's
      // own annotated `.author` becomes the only other candidate on the page.
      const authorOnly = detailHtml
        .replace('Shared by: <span class="author">', 'Shared by: <span class="author" itemprop="author">')
        .replace(/<br>Read by <a[^>]*><span class="narrator"[^>]*>[^<]*<\/span><\/a>/, '')
        .replace(/<br>Format: <span class="format"[^>]*>[^<]*<\/span>/, '');
      serveDetail(authorOnly);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.author).toBe('Carol Cole');
      expect(results[0]).not.toHaveProperty('narrator');
      expect(stringFieldsOf(results[0]!).join(' | ')).not.toContain('greads123');
    });

    it('reports no author at all for an author-only block the page never scopes to its content region', async () => {
      const noRegion = `
        <html><body>
          <h1>Murder in the New Forest</h1>
          <div class="postInfo">Shared by: <span class="author" itemprop="author">greads123</span> On: 12 Dec 2022</div>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Written by <a href="/a/"><span class="author" itemprop="author">Carol Cole</span></a></p>
        </body></html>`;
      serveDetail(noRegion);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.downloadUrl).toContain('magnet:?');
      expect(results[0]).not.toHaveProperty('author');
      expect(stringFieldsOf(results[0]!).join(' | ')).not.toContain('greads123');
    });

    it('emits no author from a search row when the detail page carries no structured block', async () => {
      const detailNoBlock = `
        <html><body>
          <h1>Murder in the New Forest</h1>
          <div class="postInfo">Shared by: <span class="author"><a href="/member/uploader123/">uploader123</a></span> On: 12 Dec 2022</div>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Whatever the uploader felt like typing.</p>
        </body></html>`;
      serveDetail(detailNoBlock);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.downloadUrl).toContain('magnet:?');
      expect(results[0]).not.toHaveProperty('author');
      expect(results[0]).not.toHaveProperty('narrator');
      expect(stringFieldsOf(results[0]!).join(' | ')).not.toContain('uploader123');
    });

    it('emits no author from a search row when the detail block carries only a narrator', async () => {
      const detailNarratorOnly = `
        <html><body>
          <h1>Murder in the New Forest</h1>
          <div class="postInfo">Shared by: <span class="author"><a href="/member/uploader123/">uploader123</a></span> On: 12 Dec 2022</div>
          <pre>Info Hash: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0</pre>
          <p>Read by <a href="/n/"><span class="narrator" itemprop="author">James MacNaughton</span></a></p>
        </body></html>`;
      serveDetail(detailNarratorOnly);

      const { results } = await indexer.search('Murder in the New Forest');

      expect(results[0]!.narrator).toBe('James MacNaughton');
      expect(results[0]).not.toHaveProperty('author');
      expect(stringFieldsOf(results[0]!).join(' | ')).not.toContain('uploader123');
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

      expect(capturedSignals.length).toBeGreaterThan(0);
      controller.abort();
      expect(capturedSignals[0]!.aborted).toBe(true);
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

    // Direct mode has no ProxyError to raise, which is exactly why this used to degrade silently.
    it('search propagates a direct network error rather than returning empty results', async () => {
      const directIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(directIndexer as any, 'delay').mockResolvedValue(undefined);

      server.use(
        http.get(`${ABB_BASE}/`, () => HttpResponse.error()),
      );

      await expect(directIndexer.search('test')).rejects.toThrow();
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
    // MSW cannot inspect undici's dispatcher option, so this block spies on fetch directly.
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

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.indexer).toBe('AudioBookBay');
      expect(fetchSpy).toHaveBeenCalled();
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs![1] as Record<string, unknown>).dispatcher).toBeDefined();

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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.guid).toBe(results[0]!.infoHash);
      expect(results[0]!.guid).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
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

      const { results } = await indexer.search('Brandon Sanderson');

      expect(results[0]!.guid).toMatch(/^[a-f0-9]{40}$/);
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

      const { results } = await indexer.search('test');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.guid).toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0');
      expect(results[0]!.guid).toBe(results[0]!.infoHash);
    });
  });

  /**
   * The amplification guard (#2373 AC5). Both catches in this adapter rethrow only what
   * `isProxyRelatedError` accepts and swallow everything else, so a slot-wait failure typed as a
   * plain `Error` would be dropped, ABB would report an empty result set, the search service would
   * count it as `succeeded`, and the query ladder would read an answered zero and advance — issuing
   * more solver requests, which is exactly the amplification the bound exists to prevent.
   */
  describe('solver concurrency bound (#2373)', () => {
    const PROXY_URL = 'http://flaresolverr.test:8191';
    const bound = useSolverBound(server);
    let proxiedIndexer: AudioBookBayIndexer;

    beforeEach(() => {
      proxiedIndexer = new AudioBookBayIndexer({
        hostname: ABB_HOST,
        pageLimit: 1,
        flareSolverrUrl: PROXY_URL,
      });
    });

    /** Replaces the inter-request pause with a gate, so enrichment can be held mid-loop. */
    function gateEnrichmentDelay(indexerUnderTest: AudioBookBayIndexer): { open: () => void } {
      let resume: (() => void) | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(indexerUnderTest as any, 'delay').mockImplementation(
        () => new Promise<void>((resolve) => { resume = resolve; }),
      );
      return { open: () => resume?.() };
    }

    it('propagates a slot-wait timeout from the search page out of search()', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

      const timer = bound.captureTimers();
      const searching = bound.track(proxiedIndexer.search('Brandon Sanderson'));
      // The adapter reaches the transport after its own async work, so wait until it has declared
      // itself either way. Over-admission then fails the pending() assertion instead of hanging.
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      expect(timer.pending()).toBe(1);
      timer.fire();

      await expect(searching).rejects.toThrow(/waiting for a request slot/);
      await expect(searching).rejects.toBeInstanceOf(ProxyError);
      expect(stub.targets.some((target) => target.includes('?s='))).toBe(false);
    });

    it('propagates a slot-wait timeout from detail-page enrichment out of search()', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`, {
        immediate: (targetUrl) => (targetUrl.includes('?s=') ? solverOk(searchHtml) : undefined),
      });
      const enrichment = gateEnrichmentDelay(proxiedIndexer);

      const searching = bound.track(proxiedIndexer.search('Brandon Sanderson'));
      await stub.reaches(1);
      expect(stub.targets.some((target) => target.includes('?s='))).toBe(true);

      // The search page has released its slot; fill the pool before enrichment resumes.
      await bound.saturate(stub, PROXY_URL);
      const timer = bound.captureTimers();
      enrichment.open();
      await bound.accountedFor(stub, timer, { arrived: bound.max + 1, queued: 1 });
      expect(timer.pending()).toBe(1);
      timer.fire();

      await expect(searching).rejects.toThrow(/waiting for a request slot/);
      await expect(searching).rejects.toBeInstanceOf(ProxyError);
    });

    it('makes the connection test queue behind search traffic and reports the slot wait', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);

      const searchers = Array.from({ length: bound.max }, () => {
        const searcher = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.spyOn(searcher as any, 'delay').mockResolvedValue(undefined);
        return bound.track(searcher.search('Brandon Sanderson'));
      });
      await stub.reaches(bound.max);

      const timer = bound.captureTimers();
      const testing = proxiedIndexer.test();
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      expect(timer.pending()).toBe(1);
      timer.fire();

      const result = await testing;
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/waiting for a request slot/);
      expect(result.message).toContain(PROXY_URL);
      expect(stub.observed).toBe(bound.max);
      expect(searchers).toHaveLength(bound.max);
    });

    // #2374 AC10 — the slot wait already names the right component, so spending a probe on it (or
    // re-attributing it to the target) is a regression.
    it('spends no reachability probe on a slot wait', async () => {
      const probed: string[] = [];
      server.use(
        http.head(`${ABB_BASE}/`, () => { probed.push('target'); return new HttpResponse(null, { status: 200 }); }),
        http.head(`${PROXY_URL}/v1`, () => { probed.push('solver'); return new HttpResponse(null, { status: 405 }); }),
      );
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

      const timer = bound.captureTimers();
      const testing = proxiedIndexer.test();
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      timer.fire();

      const result = await testing;
      expect(result.message).toMatch(/waiting for a request slot/);
      expect(probed).toEqual([]);
    });
  });

  /**
   * #2374 — the Test button must answer *which* component is broken. The incident it exists for:
   * ABB refused connections outright while a healthy solver reported `FlareSolverr proxy timed out
   * after 60s`, and six hours went into the wrong component.
   */
  describe('#2374 solver failure diagnosis', () => {
    const SOLVER_URL = 'http://flaresolverr.test:8191';
    const SOLVER_ENDPOINT = `${SOLVER_URL}/v1`;
    const STANDARD_PROXY = 'http://proxy.test:8080';
    const TIMED_OUT = 'FlareSolverr proxy timed out after 60s';

    let solverIndexer: AudioBookBayIndexer;
    let routed: RoutedFetch | undefined;

    beforeEach(() => {
      solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: SOLVER_URL });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.spyOn(solverIndexer as any, 'delay').mockResolvedValue(undefined);
    });

    afterEach(() => {
      routed?.restore();
      routed = undefined;
    });

    const isTarget = (url: string) => url.includes(ABB_HOST);
    const isSolver = (url: string) => url.startsWith(SOLVER_ENDPOINT);

    /** Round-trip aborts on its own deadline; probes answer as the test asks. */
    function timeoutArm(target: RouteOutcome, solver: RouteOutcome = new Response(null, { status: 405 })) {
      routed = routeFetch((url, method) => {
        if (method === 'POST' && isSolver(url)) return abortRejection();
        if (method === 'HEAD' && isTarget(url)) return target;
        if (method === 'HEAD' && isSolver(url)) return solver;
        return undefined;
      });
      return routed;
    }

    /** The solver delivered a `Response`, so only the target probe can decide. */
    function answeredArm(envelope: Response, target: RouteOutcome) {
      routed = routeFetch((url, method) => {
        if (method === 'POST' && isSolver(url)) return envelope;
        if (method === 'HEAD' && isTarget(url)) return target;
        return undefined;
      });
      return routed;
    }

    it('names the target, not the solver, when the site refuses connections (the regression)', async () => {
      timeoutArm(codedRejection('ECONNREFUSED', `connect ECONNREFUSED 10.0.0.7:443`));

      const result = await solverIndexer.test();

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        `Target unreachable: ${ABB_HOST} refused the connection (ECONNREFUSED). Probed directly, not through the solver.`,
      );
      expect(result.message).not.toContain(SOLVER_URL);
      expect(result.message).not.toMatch(/timed out/i);
    });

    it('names the solver URL and issues no probe when the solver itself refuses', async () => {
      const calls = routeFetch((url, method) => (method === 'POST' && isSolver(url)
        ? codedRejection('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.9:8191')
        : undefined));
      routed = calls;

      const result = await solverIndexer.test();

      expect(result.message).toBe(`Solver unreachable: ${SOLVER_ENDPOINT} refused the connection (ECONNREFUSED).`);
      expect(result.message).not.toContain(ABB_HOST);
      expect(calls.probes()).toEqual([]);
    });

    it.each([
      ['ECONNREFUSED', 'solver'],
      ['ENOTFOUND', 'solver'],
      ['ECONNRESET', 'inconclusive'],
      ['ETIMEDOUT', 'inconclusive'],
      ['UND_ERR_CONNECT_TIMEOUT', 'inconclusive'],
      ['EAI_AGAIN', 'inconclusive'],
    ] as const)('reads a %s rejection of the solver fetch as the %s arm, with no probe', async (code, arm) => {
      const calls = routeFetch((url, method) => (method === 'POST' && isSolver(url) ? codedRejection(code) : undefined));
      routed = calls;

      const result = await solverIndexer.test();

      expect(result.message).toMatch(arm === 'solver' ? /^Solver unreachable: / : /^Could not determine /);
      expect(calls.probes()).toEqual([]);
    });

    it('reads an uncoded solver rejection as inconclusive, naming nobody', async () => {
      const calls = routeFetch((url, method) => (method === 'POST' && isSolver(url) ? uncodedRejection() : undefined));
      routed = calls;

      const result = await solverIndexer.test();

      expect(result.message).toContain('Could not determine which component failed');
      expect(result.message).toContain('the failure carried no transport code');
      expect(calls.probes()).toEqual([]);
    });

    describe('the solver answered — the target probe decides', () => {
      const ENVELOPES: Array<[string, Response]> = [
        ['a status:error envelope', solverEnvelope({ status: 'error', message: 'Challenge failed' })],
        ['an empty solution.response', solverEnvelope({ status: 'ok', solution: { response: '', status: 200 } })],
        ['a non-JSON body', new Response('<html>gateway</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
        ['a JSON body of the wrong shape', solverEnvelope({ unexpected: true })],
        ['a proxy HTTP error', new Response('nope', { status: 500 })],
      ];

      it.each(ENVELOPES)('%s with an unreachable target yields Target', async (_label, envelope) => {
        answeredArm(envelope.clone(), codedRejection('ECONNREFUSED'));
        const result = await solverIndexer.test();
        expect(result.message).toMatch(/^Target unreachable: /);
      });

      it.each(ENVELOPES)('%s with a reachable target yields No page', async (_label, envelope) => {
        answeredArm(envelope.clone(), new Response(null, { status: 200 }));
        const result = await solverIndexer.test();
        expect(result.message).toMatch(/^No page came back\./);
      });

      it.each(ENVELOPES)('%s with an inconclusive target yields Inconclusive', async (_label, envelope) => {
        answeredArm(envelope.clone(), codedRejection('EAI_AGAIN'));
        const result = await solverIndexer.test();
        expect(result.message).toMatch(/^Could not determine which component failed: /);
      });

      it.each(ENVELOPES)('%s never yields the Solver verdict', async (_label, envelope) => {
        for (const target of [codedRejection('ECONNREFUSED'), new Response(null, { status: 200 }), codedRejection('ETIMEDOUT')]) {
          answeredArm(envelope.clone(), target);
          const result = await solverIndexer.test();
          expect(result.message).not.toMatch(/^Solver unreachable: /);
          routed?.restore();
        }
      });

      it("quotes the solver's own words in the No-page message", async () => {
        answeredArm(solverEnvelope({ status: 'error', message: 'Challenge failed' }), new Response(null, { status: 200 }));
        const result = await solverIndexer.test();
        expect(result.message).toContain('"FlareSolverr error: Challenge failed"');
      });

      /**
       * The F6 counterfactual: supported solvers return valid protocol envelopes on non-2xx
       * (FlareSolverr 500, Byparr 408 for a downstream page timeout, TRAWL 429/500/503), so a
       * status alone must never carry a solver-health claim.
       */
      it.each([408, 429, 500, 503])('resolves a %i-delivered error envelope on the target probe, not against the solver', async (status) => {
        answeredArm(
          solverEnvelope({ status: 'error', message: 'downstream page timeout' }, status),
          new Response(null, { status: 200 }),
        );
        const result = await solverIndexer.test();
        expect(result.message).toMatch(/^No page came back\./);
        expect(result.message).not.toMatch(/^Solver unreachable: /);
      });
    });

    describe('the round-trip timed out — both probes decide', () => {
      it.each([
        ['target refused', codedRejection('ECONNREFUSED'), new Response(null, { status: 405 }), /^Target unreachable: /],
        ['solver refused', new Response(null, { status: 200 }), codedRejection('ECONNREFUSED'), /^Solver unreachable: /],
        ['both answered', new Response(null, { status: 200 }), new Response(null, { status: 405 }), /^No page came back\./],
        ['solver blackholes', new Response(null, { status: 200 }), codedRejection('ETIMEDOUT'), /^Could not determine which component failed: /],
        ['target blackholes', codedRejection('ETIMEDOUT'), new Response(null, { status: 405 }), /^Could not determine which component failed: /],
      ] as const)('%s', async (_label, target, solver, expected) => {
        timeoutArm(target, solver);
        const result = await solverIndexer.test();
        expect(result.message).toMatch(expected);
      });

      /**
       * AC17 — a solver whose router answers while its browser worker is wedged. The honest answer
       * narrows the search without asserting a cause the probe cannot establish, so the Test button
       * must not point the operator away from the broken component.
       */
      it('does not exonerate the solver when its front door answers but no page comes back', async () => {
        timeoutArm(new Response(null, { status: 200 }), new Response(null, { status: 200 }));

        const result = await solverIndexer.test();

        expect(result.message).toMatch(/^No page came back\./);
        expect(result.message).not.toMatch(/\b(up|healthy|working|fine|operational|alive|ok|exonerated)\b/i);
        expect(result.message).toContain(SOLVER_ENDPOINT);
        expect(result.message).toContain(ABB_HOST);
        expect(result.message).toContain('remain possible causes — neither has been ruled out');
      });

      it('degrades to the verbatim solver error plus a could-not-determine statement (AC6)', async () => {
        timeoutArm(codedRejection('EAI_AGAIN'), codedRejection('EAI_AGAIN'));

        const result = await solverIndexer.test();

        expect(result.success).toBe(false);
        expect(result.message).toContain(TIMED_OUT);
        expect(result.message).toContain('Could not determine which component failed');
      });

      it('is bounded by the probe budget, not by PROXY_TIMEOUT_MS', async () => {
        const probeTimers: Array<() => void> = [];
        const nativeSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
          if (delay !== REACHABILITY_PROBE_TIMEOUT_MS) return nativeSetTimeout(handler as () => void, delay, ...rest);
          probeTimers.push(handler as () => void);
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof globalThis.setTimeout);

        // Both probes hang, so only their own deadline can settle them — if the diagnosis were
        // bounded by the round-trip budget instead, this would sit for PROXY_TIMEOUT_MS.
        routed = routeFetch((url, method, init) => {
          if (method === 'POST' && isSolver(url)) return abortRejection();
          if (method === 'HEAD') return hangUntilAborted(init?.signal);
          return undefined;
        });

        const testing = solverIndexer.test();
        await vi.waitFor(() => expect(probeTimers).toHaveLength(2));
        for (const fire of probeTimers) fire();

        const result = await testing;
        expect(result.message).toMatch(/^Could not determine which component failed: /);
        expect(result.message).toContain(TIMED_OUT);
      });
    });

    describe('through a configured standard proxy (AC13)', () => {
      let proxiedSolverIndexer: AudioBookBayIndexer;

      beforeEach(() => {
        proxiedSolverIndexer = new AudioBookBayIndexer({
          hostname: ABB_HOST,
          pageLimit: 1,
          flareSolverrUrl: SOLVER_URL,
          proxyUrl: STANDARD_PROXY,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        vi.spyOn(proxiedSolverIndexer as any, 'delay').mockResolvedValue(undefined);
      });

      it.each(['ECONNREFUSED', 'ENOTFOUND'])('never blames the target for a %s through the dispatcher', async (code) => {
        timeoutArm(codedRejection(code), new Response(null, { status: 405 }));

        const result = await proxiedSolverIndexer.test();

        expect(result.message).toMatch(/^Could not determine which component failed: /);
        expect(result.message).not.toMatch(/^Target unreachable: /);
        expect(result.message).not.toMatch(/^Solver unreachable: /);
      });

      it('sends the target probe through the dispatcher and the solver probe without one', async () => {
        const calls = timeoutArm(new Response(null, { status: 200 }), new Response(null, { status: 405 }));

        await proxiedSolverIndexer.test();

        const probes = calls.probes();
        expect(probes.find((call) => call.url.includes(ABB_HOST))?.init.dispatcher).toBeDefined();
        expect(probes.find((call) => call.url.startsWith(SOLVER_ENDPOINT))?.init.dispatcher).toBeUndefined();
      });

      it('still reads a 403 through the dispatcher as reachable', async () => {
        answeredArm(solverEnvelope({ status: 'error', message: 'Challenge failed' }), new Response(null, { status: 403 }));

        const result = await proxiedSolverIndexer.test();

        expect(result.message).toMatch(/^No page came back\./);
      });

      it('gives a target-generated and a proxy-generated 503 the same verdict (F7)', async () => {
        answeredArm(
          solverEnvelope({ status: 'error', message: 'Challenge failed' }),
          new Response(null, { status: 503, headers: { 'X-Fixture-Origin': 'target' } }),
        );
        const fromTarget = await proxiedSolverIndexer.test();
        routed?.restore();

        answeredArm(
          solverEnvelope({ status: 'error', message: 'Challenge failed' }),
          new Response(null, { status: 503, headers: { 'X-Fixture-Origin': 'proxy' } }),
        );
        const fromProxy = await proxiedSolverIndexer.test();

        expect(fromTarget.message).toBe(fromProxy.message);
        expect(fromTarget.message).toMatch(/^Could not determine which component failed: /);
      });

      it('control: the same target refusal with no standard proxy is a Target verdict', async () => {
        timeoutArm(codedRejection('ECONNREFUSED'));
        const result = await solverIndexer.test();
        expect(result.message).toMatch(/^Target unreachable: /);
      });
    });

    describe('the diagnosis costs nothing on the healthy path (AC9)', () => {
      it('issues no probe when the solver round-trip succeeds, and keeps today\'s success text', async () => {
        const calls = routeFetch((url, method) => (method === 'POST' && isSolver(url)
          ? solverEnvelope({ status: 'ok', solution: { response: '<html>ok</html>', status: 200 } })
          : codedRejection('ECONNREFUSED')));
        routed = calls;

        const result = await solverIndexer.test();

        expect(result).toEqual({ success: true, message: `Connected to ${ABB_HOST} via FlareSolverr` });
        expect(calls.probes()).toEqual([]);
      });

      it('issues no probe from the search path, even when the solver fails there', async () => {
        const calls = routeFetch((url, method) => (method === 'POST' && isSolver(url)
          ? codedRejection('ECONNREFUSED')
          : undefined));
        routed = calls;

        await expect(solverIndexer.search('Brandon Sanderson')).rejects.toThrow('FlareSolverr');
        expect(calls.probes()).toEqual([]);
      });
    });
  });
});
