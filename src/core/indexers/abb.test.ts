import { describe, it, expect, afterEach, beforeEach, vi, type MockInstance } from 'vitest';
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
import { IndexerError, ProxyError, httpStatusOf, isProxyRelatedError } from './errors.js';
import { getErrorMessage } from '@shared/error-message.js';
import { ABB_DETAILS_SENTINEL_PREFIX, abbDetailsSentinel } from './abb-sentinel.js';
import { abbGuid } from './abb-url.js';
import { abbThrottle, _resetAbbThrottleForTesting } from './abb-throttle.js';
import { parseInfoHash } from '../utils/magnet.js';
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
const noResultsHtml = readFileSync(resolve(fixturesDir, 'abb-no-results.html'), 'utf-8');

/** Every string a downstream gate, score or badge can read off a result. */
function stringFieldsOf(result: SearchResult): string[] {
  return Object.values(result).filter((value): value is string => typeof value === 'string');
}

const ABB_HOST = 'audiobookbay.test';
const ABB_BASE = `https://${ABB_HOST}`;
const MURDER_URL = `${ABB_BASE}/audio-books/murder-in-the-new-forest/`;
const WISH_URL = `${ABB_BASE}/audio-books/wish-you-were-here-yet/`;
const MURDER_GUID = 'abb:/audio-books/murder-in-the-new-forest/';
const WISH_GUID = 'abb:/audio-books/wish-you-were-here-yet/';
const FIXTURE_HASH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const PINNED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('AudioBookBayIndexer', () => {
  const server = useMswServer();
  let indexer: AudioBookBayIndexer;
  let acquire: MockInstance<typeof abbThrottle.acquire>;

  beforeEach(() => {
    _resetAbbThrottleForTesting();
    // The 6.1s floor would make every multi-request case here a six-second test. Its timing lives
    // in `abb-throttle.test.ts` under fake timers; this suite proves the wiring, and the spy is
    // what makes "which requests acquire, with what URL" directly observable.
    acquire = vi.spyOn(abbThrottle, 'acquire').mockResolvedValue(undefined);
    indexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
  });

  afterEach(() => {
    _resetAbbThrottleForTesting();
    vi.restoreAllMocks();
  });

  /** Counts every request to a detail page, which `search()` must never make. */
  function countDetailRequests(): { count: number } {
    const seen = { count: 0 };
    server.use(
      http.get(`${ABB_BASE}/audio-books/:slug/`, () => {
        seen.count++;
        return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
      }),
    );
    return seen;
  }

  function serveSearchPages(body = searchHtml): { urls: string[] } {
    const urls: string[] = [];
    server.use(
      http.get(`${ABB_BASE}/`, ({ request }) => {
        urls.push(request.url);
        return new HttpResponse(body, { headers: { 'Content-Type': 'text/html' } });
      }),
      http.get(`${ABB_BASE}/page/:page/`, ({ request }) => {
        urls.push(request.url);
        return new HttpResponse(body, { headers: { 'Content-Type': 'text/html' } });
      }),
    );
    return { urls };
  }

  describe('properties', () => {
    it('has correct type and name', () => {
      expect(indexer.type).toBe('abb');
      expect(indexer.name).toBe('AudioBookBay');
    });
  });

  /**
   * AC1 — a detail fetch per row, up to 50 of them per search, is what earned the 2026-08 ban. Both
   * mature community integrations resolve the magnet at download time instead.
   */
  describe('search issues search-page requests only (AC1, AC11)', () => {
    it('makes no request to any detail URL while still returning both rows', async () => {
      serveSearchPages();
      const details = countDetailRequests();

      const { results } = await indexer.search('Brandon Sanderson');

      expect(details.count).toBe(0);
      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest', 'Wish You Were Here Yet?']);
    });

    it('costs exactly one HTTP request for a one-page search', async () => {
      const { urls } = serveSearchPages();
      countDetailRequests();

      await indexer.search('Brandon Sanderson');

      expect(urls).toEqual([`${ABB_BASE}/?s=brandon+sanderson&tt=1`]);
    });

    it('costs exactly two for a two-page search whose limit is not reached on page one', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages();
      countDetailRequests();

      const { results } = await twoPage.search('Brandon Sanderson');

      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain('/page/2/');
      expect(results).toHaveLength(4);
    });

    it('returns zero results and stops paginating on an empty page, with no detail request', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages(noResultsHtml);
      const details = countDetailRequests();

      const { results, parseStats } = await twoPage.search('nonexistent book');

      expect(results).toEqual([]);
      expect(urls).toHaveLength(1);
      expect(details.count).toBe(0);
      expect(parseStats.kept).toBe(0);
    });

    // Every titled row now yields a sentinel, so `dropped:no-url` is unreachable for ABB. The field
    // stays because the interface is shared with the other adapters.
    it('drops a row with no href as empty-title and never as no-url', async () => {
      serveSearchPages(`
        <html><body>
          <div class="post"><div class="postTitle"><h2><a rel="bookmark">Titled But Unlinked</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="/audio-books/real/" rel="bookmark">Real Row</a></h2></div></div>
        </body></html>`);

      const { results, parseStats, debugTrace } = await indexer.search('test');

      expect(results).toHaveLength(1);
      expect(parseStats.dropped.emptyTitle).toBe(1);
      expect(parseStats.dropped.noUrl).toBe(0);
      expect(parseStats.dropped.other).toBe(0);
      expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:empty-title', 'kept']);
    });
  });

  describe('search-row identity (AC2)', () => {
    it('sets guid to the path-derived identity and downloadUrl to the details sentinel', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      expect(results[0]).toMatchObject({
        guid: MURDER_GUID,
        downloadUrl: `${ABB_DETAILS_SENTINEL_PREFIX}${MURDER_URL}`,
        detailsUrl: MURDER_URL,
      });
      expect(results[1]).toMatchObject({
        guid: WISH_GUID,
        downloadUrl: abbDetailsSentinel(WISH_URL),
        detailsUrl: WISH_URL,
      });
    });

    // `toBeUndefined()` passes against a present-and-undefined key and cannot discriminate under
    // exactOptionalPropertyTypes, which is what every downstream `in`/spread check keys on.
    it('leaves infoHash, seeders, leechers and size absent rather than present-and-undefined', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      for (const result of results) {
        expect(result).not.toHaveProperty('infoHash');
        expect(result).not.toHaveProperty('seeders');
        expect(result).not.toHaveProperty('leechers');
        expect(result).not.toHaveProperty('size');
      }
    });

    /**
     * #2434 — replaces the case that asserted an off-host href survived verbatim, which is exactly
     * the behavior being removed. A mirror's markup routinely disagrees with the configured origin
     * on host, scheme and www; all three must land on `ABB_BASE` or the detail fetch keys its own
     * throttle queue and the guid dies at the next hop.
     */
    it('rewrites every scraped href onto the configured origin, whatever the markup carried', async () => {
      serveSearchPages(`
        <html><body>
          <div class="post"><div class="postTitle"><h2><a href="/audio-books/relative/" rel="bookmark">Relative</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="audio-books/no-slash/" rel="bookmark">No Slash</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="https://other.test/audio-books/absolute/" rel="bookmark">Absolute</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="http://www.${ABB_HOST}/audio-books/aliased/" rel="bookmark">Aliased</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="//other.test/audio-books/protocol-relative/" rel="bookmark">Protocol Relative</a></h2></div></div>
        </body></html>`);

      const { results } = await indexer.search('test');

      expect(results.map((r) => r.detailsUrl)).toEqual([
        `${ABB_BASE}/audio-books/relative/`,
        `${ABB_BASE}/audio-books/no-slash/`,
        `${ABB_BASE}/audio-books/absolute/`,
        `${ABB_BASE}/audio-books/aliased/`,
        `${ABB_BASE}/audio-books/protocol-relative/`,
      ]);
    });

    // Deriving any two of the three independently is how they drift; one rewritten string feeds all.
    it('keeps guid, detailsUrl and the sentinel mutually consistent on every kept row', async () => {
      serveSearchPages(`
        <html><body>
          <div class="post"><div class="postTitle"><h2><a href="https://other.test/audio-books/absolute/?p=1#frag" rel="bookmark">Absolute</a></h2></div></div>
          <div class="post"><div class="postTitle"><h2><a href="audio-books/no-slash/" rel="bookmark">No Slash</a></h2></div></div>
        </body></html>`);

      const { results } = await indexer.search('test');

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.downloadUrl).toBe(abbDetailsSentinel(result.detailsUrl!));
        expect(result.guid).toBe(abbGuid(result.detailsUrl!));
      }
      expect(results[0]!.guid).toBe('abb:/audio-books/absolute/?p=1');
    });

    // A mirror hop is a config edit, so the same release under two hostnames must be one identity.
    it('gives the same release one guid under two different configured mirrors', async () => {
      const MIRROR_HOST = 'audiobookbay.mirror';
      const row = '<html><body><div class="post"><div class="postTitle"><h2><a href="/audio-books/murder-in-the-new-forest/" rel="bookmark">Murder</a></h2></div></div></body></html>';
      server.use(
        http.get(`${ABB_BASE}/`, () => new HttpResponse(row, { headers: { 'Content-Type': 'text/html' } })),
        http.get(`https://${MIRROR_HOST}/`, () => new HttpResponse(row, { headers: { 'Content-Type': 'text/html' } })),
      );
      const mirror = new AudioBookBayIndexer({ hostname: MIRROR_HOST, pageLimit: 1 });

      const here = await indexer.search('test');
      const there = await mirror.search('test');

      expect(here.results[0]!.guid).toBe(MURDER_GUID);
      expect(there.results[0]!.guid).toBe(MURDER_GUID);
      // ...while the link the operator actually follows still points at their own configured host.
      expect(there.results[0]!.detailsUrl).toBe(`https://${MIRROR_HOST}/audio-books/murder-in-the-new-forest/`);
    });

    /**
     * The positive observation point for `readAbbMetadata($, $el)`. Without it an implementation
     * that drops the row-scoped metadata read satisfies every other row assertion here — the values
     * come off the row's own annotated elements, and the fixture writes the block on one source
     * line so a regression to a `.text()`-run regex reds on exact values.
     */
    it('reads author, narrator and format off the row\'s own elements, with no detail request', async () => {
      serveSearchPages();
      const details = countDetailRequests();

      const { results } = await indexer.search('test');

      expect(results[0]).toMatchObject({
        author: 'Carol Cole',
        narrator: 'James MacNaughton',
        format: 'm4b',
      });
      expect(details.count).toBe(0);
    });

    it('leaves author and narrator absent on a row carrying no annotated block', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      expect(results[1]).not.toHaveProperty('author');
      expect(results[1]).not.toHaveProperty('narrator');
    });

    it('never reports the uploader byline as the author', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      for (const result of results) {
        expect(stringFieldsOf(result).join(' | ')).not.toContain('uploader123');
      }
    });

    it('still carries the row cover and indexer name', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      expect(results[0]!.coverUrl).toBe('https://example.com/covers/murder-in-the-new-forest.jpg');
      expect(results[0]!.indexer).toBe('AudioBookBay');
      expect(results[0]!.protocol).toBe('torrent');
    });
  });

  /**
   * #2434 AC3 — the row loop's two gates and their precedence. Gate A is the existing
   * `!title || !detailsUrl`; Gate B rejects an href that cannot address a release once resolved.
   * They share the `dropped.other` counter but carry different trace reasons, because "the link was
   * not a usable URL" and "the link pointed at the homepage" are different diagnoses when a
   * mirror's markup changes.
   */
  describe('drop-disposition precedence (AC3)', () => {
    const titledRow = (href: string, title = 'Titled Row'): string =>
      `<div class="post"><div class="postTitle"><h2><a href="${href}" rel="bookmark">${title}</a></h2></div></div>`;
    const page = (...posts: string[]): string => `<html><body>${posts.join('')}</body></html>`;

    /**
     * Arm C. A row-count assertion alone would pass against a fake root release whenever some other
     * row also dropped, so the absence of the collapsed identity is asserted directly.
     */
    describe('Arm C — an href that resolves to the bare site root', () => {
      for (const href of ['#', '#fragment', '/', '   ', '/.', '?']) {
        it(`drops ${JSON.stringify(href)} as no-release-path rather than keeping a homepage row`, async () => {
          serveSearchPages(page(titledRow(href)));

          const { results, parseStats, debugTrace } = await indexer.search('test');

          expect(results).toEqual([]);
          expect(parseStats.dropped.other).toBe(1);
          expect(parseStats.dropped.emptyTitle).toBe(0);
          expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:no-release-path']);
        });
      }

      it('produces no row carrying the collapsed root identity, even beside a healthy row', async () => {
        serveSearchPages(page(titledRow('#', 'Root Row'), titledRow('/audio-books/real/', 'Real Row')));

        const { results, parseStats } = await indexer.search('test');

        expect(results.map((r) => r.title)).toEqual(['Real Row']);
        expect(results.some((r) => r.guid === 'abb:/')).toBe(false);
        expect(results.some((r) => r.detailsUrl === `${ABB_BASE}/`)).toBe(false);
        expect(parseStats.dropped.other).toBe(1);
      });
    });

    /**
     * The keep-side control that bounds the rule. ABB's markup is WordPress-shaped, so a mirror on
     * default permalinks serves real posts at `/?p=N`; without this case an implementation that
     * rejects on `pathname === '/'` alone passes every rejection above and silently makes such a
     * mirror unusable.
     */
    it('keeps a query-addressed default-permalink row', async () => {
      serveSearchPages(page(titledRow('/?p=12345', 'Default Permalink')));

      const { results, parseStats } = await indexer.search('test');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        guid: 'abb:/?p=12345',
        detailsUrl: `${ABB_BASE}/?p=12345`,
        downloadUrl: abbDetailsSentinel(`${ABB_BASE}/?p=12345`),
      });
      expect(parseStats.dropped.other).toBe(0);
    });

    describe('Gate B arms A and B — an href that is not a usable http(s) URL', () => {
      for (const href of ['javascript:void(0)', 'mailto:a@b.test', 'data:text/html,x', 'http://[::1']) {
        it(`drops ${JSON.stringify(href)} as non-http-href`, async () => {
          serveSearchPages(page(titledRow(href)));

          const { results, parseStats, debugTrace } = await indexer.search('test');

          expect(results).toEqual([]);
          expect(parseStats.dropped.other).toBe(1);
          expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:non-http-href']);
        });
      }

      it('isolates the bad row and still returns the two around it', async () => {
        serveSearchPages(page(
          titledRow('/audio-books/first/', 'First'),
          titledRow('javascript:void(0)', 'Middle'),
          titledRow('/audio-books/third/', 'Third'),
        ));

        const { results, parseStats, debugTrace } = await indexer.search('test');

        expect(results.map((r) => r.title)).toEqual(['First', 'Third']);
        expect(parseStats.itemsObserved).toBe(3);
        expect(parseStats.dropped.other).toBe(1);
        expect(parseStats.dropped.emptyTitle).toBe(0);
        expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:non-http-href', 'kept', 'kept']);
      });
    });

    /**
     * The case that discriminates a title-first implementation from a rewrite-first one — every
     * other case in this block passes against both. Gate A wins unconditionally, so an empty-title
     * row keeps today's classification no matter what its href would have resolved to.
     */
    it('classifies an empty-title row with a javascript: href under Gate A, not Gate B', async () => {
      serveSearchPages(page(titledRow('javascript:alert(1)', '')));

      const { parseStats, debugTrace } = await indexer.search('test');

      expect(parseStats.dropped.emptyTitle).toBe(1);
      expect(parseStats.dropped.other).toBe(0);
      expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:empty-title']);
    });

    it('conserves the counters across a page carrying one row of every class', async () => {
      const undecodable = Buffer.from('just some prose, not markup', 'utf-8').toString('base64');
      serveSearchPages(page(
        titledRow('/audio-books/kept/', 'Kept Row'),
        titledRow('/audio-books/ignored/', ''),
        titledRow('javascript:void(0)', 'Non HTTP'),
        titledRow('#', 'Root Collapse'),
        `<div class="post re-ab">${undecodable}</div>`,
      ));

      const { results, parseStats, debugTrace } = await indexer.search('test');

      const { dropped } = parseStats;
      expect(parseStats.itemsObserved).toBe(5);
      expect(parseStats.kept + dropped.emptyTitle + dropped.noUrl + dropped.other).toBe(5);
      expect(parseStats).toMatchObject({ kept: 1, dropped: { emptyTitle: 1, noUrl: 0, other: 3 } });
      expect(results.map((r) => r.title)).toEqual(['Kept Row']);
      expect(debugTrace.map((t) => t.reason)).toEqual([
        'dropped:empty-title',
        'dropped:non-http-href',
        'dropped:no-release-path',
        'dropped:re-ab-undecodable',
        'kept',
      ]);
    });
  });

  describe('the limit option keeps an owner (AC12)', () => {
    it('caps results and records no kept trace for the row past the budget', async () => {
      serveSearchPages();

      const { results, debugTrace, parseStats } = await indexer.search('Brandon Sanderson', { limit: 1 });

      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Murder in the New Forest');
      expect(debugTrace.filter((t) => t.reason === 'kept')).toHaveLength(1);
      expect(parseStats.kept).toBe(1);
      expect(parseStats.itemsObserved).toBe(2);
    });

    // The ban-safe half: a spent request is exactly what this rework exists to avoid.
    it('breaks before requesting page two once page one has filled the budget', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages();

      const { results } = await twoPage.search('test', { limit: 1 });

      expect(results).toHaveLength(1);
      expect(urls).toHaveLength(1);
      expect(urls[0]).not.toContain('/page/2/');
    });

    it('defaults to 50 when no limit is given', async () => {
      serveSearchPages();

      const { results } = await indexer.search('test');

      expect(results).toHaveLength(2);
    });
  });

  describe('page failures and cancellation', () => {
    it('propagates a first-page fetch error instead of reporting an answered zero', async () => {
      server.use(http.get(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 503 })));

      await expect(indexer.search('test')).rejects.toThrow('HTTP 503');
    });

    it('keeps the structural status on the propagated first-page error', async () => {
      server.use(http.get(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 503 })));

      const error = await indexer.search('test').catch((e: unknown) => e);

      expect((error as { httpStatus?: unknown }).httpStatus).toBe(503);
    });

    it('still returns the pages it did get when a LATER page fails', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      server.use(
        http.get(`${ABB_BASE}/`, () => new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } })),
        http.get(`${ABB_BASE}/page/2/`, () => new HttpResponse(null, { status: 503 })),
      );

      // The indexer demonstrably answered page one, so this is partial success, not a failure.
      const { results } = await twoPage.search('test');

      expect(results).toHaveLength(2);
    });

    /**
     * The later-page catch degrades ordinary errors by design, so without an explicit
     * `signal?.aborted` re-check an abort is swallowed into a partial success — and every pacer
     * unit test still passes. The reason is deliberately not an `Error`: an `instanceof` assertion
     * would pass against a wrapped rejection, which is the shape the abort contract forbids.
     */
    it('rejects with the caller\'s own reason when page two is cancelled while queued on the pacer', async () => {
      const reason = { cancelled: 'search deadline' };
      const controller = new AbortController();
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      serveSearchPages();

      acquire.mockResolvedValueOnce(undefined);
      acquire.mockImplementationOnce((_url, signal) => new Promise<void>((_res, rej) => {
        signal?.addEventListener('abort', () => { rej(signal.reason); }, { once: true });
      }));

      const searching = twoPage.search('test', { signal: controller.signal });
      await vi.waitFor(() => { expect(acquire).toHaveBeenCalledTimes(2); });
      controller.abort(reason);

      await expect(searching).rejects.toBe(reason);
    });

    it('control: an ordinary later-page failure under a LIVE signal still degrades to page one', async () => {
      const controller = new AbortController();
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      server.use(
        http.get(`${ABB_BASE}/`, () => new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } })),
        http.get(`${ABB_BASE}/page/2/`, () => new HttpResponse(null, { status: 503 })),
      );

      const { results } = await twoPage.search('test', { signal: controller.signal });

      expect(results).toHaveLength(2);
    });
  });

  /** AC3 — the other half of lazy resolution: one detail fetch, at grab time. */
  describe('resolveDownloadUrl (AC3)', () => {
    const grabCtx = (downloadUrl: string) => ({ downloadUrl, protocol: 'torrent' as const, isFreeleech: false });

    it('fetches the details URL once and returns the detail page\'s magnet', async () => {
      const details = countDetailRequests();

      const result = await indexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL)));

      expect(details.count).toBe(1);
      expect(parseInfoHash(result.downloadUrl)).toBe(FIXTURE_HASH);
      expect(result.downloadUrl).toContain('dn=Murder+in+the+New+Forest');
      expect(result).not.toHaveProperty('wedgeRequested');
    });

    // A stored download re-grabbed after this change, or a v1 API payload, already holds a magnet.
    it('returns a non-sentinel downloadUrl unchanged and issues no request', async () => {
      const details = countDetailRequests();
      const magnet = `magnet:?xt=urn:btih:${FIXTURE_HASH}&dn=Stored`;

      const result = await indexer.resolveDownloadUrl(grabCtx(magnet));

      expect(result.downloadUrl).toBe(magnet);
      expect(details.count).toBe(0);
    });

    it('throws an IndexerError naming the details URL when the fetch fails, keeping the cause', async () => {
      server.use(http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(null, { status: 500 })));

      const error = await indexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL))).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IndexerError);
      expect((error as IndexerError).message).toContain(MURDER_URL);
      expect((error as IndexerError).message).toContain('HTTP 500');
      expect((error as IndexerError).cause).toBeInstanceOf(Error);
    });

    /**
     * The case that must NOT degrade into a successful return: a swallowed no-hash would hand the
     * download client the sentinel string itself.
     */
    it('throws a distinguishable IndexerError when the page loads but carries no hash', async () => {
      server.use(
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(
          '<html><body><h1>Some Book</h1><p>No hash here</p></body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        )),
      );

      const error = await indexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL))).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IndexerError);
      expect((error as IndexerError).message).toContain('no info hash');
      expect((error as IndexerError).message).not.toContain('detail fetch failed');
      expect((error as IndexerError).cause).toBeUndefined();
    });

    it('reads a hash that appears only in the page body text', async () => {
      server.use(
        http.get(`${ABB_BASE}/audio-books/:slug/`, () => new HttpResponse(
          `<html><body><h1>Rare Book</h1><p>Some random text ${FIXTURE_HASH} more text</p></body></html>`,
          { headers: { 'Content-Type': 'text/html' } },
        )),
      );

      const result = await indexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL)));

      expect(parseInfoHash(result.downloadUrl)).toBe(FIXTURE_HASH);
      expect(result.downloadUrl).toContain('dn=Rare+Book');
    });

    /**
     * #2434 AC4 — the sentinel is persisted state, so its payload can name a mirror the operator
     * has since replaced, or a shape written by a build that predates Gate B. Both are decided
     * before any request: spending a paced fetch on the wrong host, or on the homepage, is the cost
     * this issue exists to avoid.
     */
    describe('grab-time rewrite onto the configured origin (AC4)', () => {
      const OLD_MIRROR = 'https://old-mirror.test';

      /** One wildcard handler per host, so a request to either is observable by count and by URL. */
      function watchBothHosts(): { configured: string[]; oldMirror: string[] } {
        const configured: string[] = [];
        const oldMirror: string[] = [];
        server.use(
          http.get(`${ABB_BASE}/*`, ({ request }) => {
            configured.push(request.url);
            return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
          }),
          http.get(`${OLD_MIRROR}/*`, ({ request }) => {
            oldMirror.push(request.url);
            return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
          }),
        );
        return { configured, oldMirror };
      }

      it('fetches a sentinel persisted against a previous mirror from the currently configured host', async () => {
        const seen = watchBothHosts();

        const result = await indexer.resolveDownloadUrl(
          grabCtx(abbDetailsSentinel(`${OLD_MIRROR}/audio-books/murder-in-the-new-forest/`)),
        );

        expect(seen.configured).toEqual([MURDER_URL]);
        expect(seen.oldMirror).toEqual([]);
        expect(parseInfoHash(result.downloadUrl)).toBe(FIXTURE_HASH);
      });

      // Zero requests, not merely a throw: a guard placed after the fetch would still spend it.
      const rejected: Array<[arm: string, payload: string]> = [
        ['Arm B — a non-http(s) scheme', 'javascript:alert(1)'],
        ['Arm A — an unresolvable URL', 'http://[::1'],
        ['Arm C — a root URL persisted against an old mirror', `${OLD_MIRROR}/`],
      ];

      for (const [arm, payload] of rejected) {
        it(`throws an IndexerError naming the payload and issues no request for ${arm}`, async () => {
          const seen = watchBothHosts();

          const error = await indexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(payload)))
            .catch((e: unknown) => e);

          expect(error).toBeInstanceOf(IndexerError);
          expect((error as IndexerError).message).toContain(payload);
          expect(seen.configured).toEqual([]);
          expect(seen.oldMirror).toEqual([]);
        });
      }
    });

    /**
     * The deliberate asymmetry with `search()`: resolve has no degrade arm underneath, so every
     * failure already fails the grab and wrapping buys the `warn` line only the `IndexerError` arm
     * emits. A single-sided assertion would pass against "wrap everywhere" or "wrap nowhere", so
     * the search-side control below is what pins the pair.
     */
    describe('proxy failures — wrapped here, bare on the search path', () => {
      const PROXY_URL = 'http://flaresolverr.test:8191';
      let solverIndexer: AudioBookBayIndexer;

      beforeEach(() => {
        solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
        server.use(http.post(`${PROXY_URL}/v1`, () => HttpResponse.error()));
      });

      it('wraps a proxy failure in IndexerError while keeping the classification on the cause', async () => {
        const error = await solverIndexer
          .resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL)))
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(IndexerError);
        expect(isProxyRelatedError(error)).toBe(false);
        expect(isProxyRelatedError((error as IndexerError).cause)).toBe(true);
      });

      it('control: search() still rejects with the bare proxy error, unwrapped', async () => {
        const error = await solverIndexer.search('test').catch((e: unknown) => e);

        expect(error).not.toBeInstanceOf(IndexerError);
        expect(isProxyRelatedError(error)).toBe(true);
      });
    });

    it('routes the resolve fetch through FlareSolverr when one is configured', async () => {
      const PROXY_URL = 'http://flaresolverr.test:8191';
      const solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
      const solverTargets: string[] = [];
      const direct = countDetailRequests();
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          const body = await request.json() as { url: string };
          solverTargets.push(body.url);
          return solverOk(detailHtml);
        }),
      );

      const result = await solverIndexer.resolveDownloadUrl(grabCtx(abbDetailsSentinel(MURDER_URL)));

      expect(solverTargets).toEqual([MURDER_URL]);
      expect(direct.count).toBe(0);
      expect(parseInfoHash(result.downloadUrl)).toBe(FIXTURE_HASH);
    });
  });

  /**
   * AC4 wiring. The interval's own behaviour lives in `abb-throttle.test.ts`; what has to be pinned
   * here is that EVERY outbound ABB request passes through the gate — a request that skips it is
   * invisible to any timing assertion made on the requests that do not.
   */
  describe('every ABB request is paced (AC4)', () => {
    it('acquires once per search page, keyed on the page URL', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      serveSearchPages();

      await twoPage.search('test');

      expect(acquire.mock.calls.map((call) => call[0])).toEqual([
        `${ABB_BASE}/?s=test&tt=1`,
        `${ABB_BASE}/page/2/?s=test&tt=1`,
      ]);
    });

    it('acquires exactly once for a grab, keyed on the details URL', async () => {
      countDetailRequests();

      await indexer.resolveDownloadUrl({ downloadUrl: abbDetailsSentinel(MURDER_URL), protocol: 'torrent', isFreeleech: false });

      expect(acquire.mock.calls.map((call) => call[0])).toEqual([MURDER_URL]);
    });

    it('does not acquire for a non-sentinel resolve, which issues no request at all', async () => {
      await indexer.resolveDownloadUrl({
        downloadUrl: `magnet:?xt=urn:btih:${FIXTURE_HASH}`,
        protocol: 'torrent',
        isFreeleech: false,
      });

      expect(acquire).not.toHaveBeenCalled();
    });

    it('forwards the caller\'s signal to the gate alongside the transport', async () => {
      const controller = new AbortController();
      serveSearchPages();

      await indexer.search('test', { signal: controller.signal });

      expect(acquire).toHaveBeenCalledWith(`${ABB_BASE}/?s=test&tt=1`, controller.signal);
    });

    // The throwaway `test()` adapter used to bypass the queue entirely; a module-level gate keyed by
    // destination closes that leak on all three transports.
    describe('the connection test is paced on every transport', () => {
      it('direct', async () => {
        server.use(http.head(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 200 })));

        await indexer.test();

        expect(acquire.mock.calls.map((call) => call[0])).toEqual([ABB_BASE]);
      });

      it('standard proxy', async () => {
        const proxied = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, proxyUrl: 'http://proxy.test:8080' });
        server.use(
          http.get(`${ABB_BASE}/`, () => new HttpResponse('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } })),
          http.get('https://api.ipify.org', () => HttpResponse.json({ ip: '1.2.3.4' })),
        );

        await proxied.test();

        expect(acquire.mock.calls.map((call) => call[0])).toEqual([ABB_BASE]);
      });

      it('FlareSolverr', async () => {
        const PROXY_URL = 'http://flaresolverr.test:8191';
        const solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
        server.use(http.post(`${PROXY_URL}/v1`, () => solverOk('<html>ok</html>')));

        const result = await solverIndexer.test();

        expect(result.success).toBe(true);
        expect(acquire.mock.calls.map((call) => call[0])).toEqual([ABB_BASE]);
      });
    });

    // One acquire per request, never two: the solver path pays inside the slot via the shared
    // transport's hook, so acquiring in `fetchPage` as well would double-charge every request.
    it('charges the solver path exactly one acquire per request', async () => {
      const PROXY_URL = 'http://flaresolverr.test:8191';
      const solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
      server.use(http.post(`${PROXY_URL}/v1`, () => solverOk(searchHtml)));

      await solverIndexer.search('test');

      expect(acquire).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * AC8 — rotating four User-Agents from one IP is a bot fingerprint, not camouflage. The specific
   * value is asserted too, so a silent swap reds rather than passing on self-consistency.
   */
  describe('one pinned User-Agent (AC8)', () => {
    it('sends the identical UA on every request of a search and a grab', async () => {
      const seen: string[] = [];
      server.use(
        http.get(`${ABB_BASE}/`, ({ request }) => {
          seen.push(request.headers.get('User-Agent') ?? '');
          return new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
        http.get(`${ABB_BASE}/page/:page/`, ({ request }) => {
          seen.push(request.headers.get('User-Agent') ?? '');
          return new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
        http.get(`${ABB_BASE}/audio-books/:slug/`, ({ request }) => {
          seen.push(request.headers.get('User-Agent') ?? '');
          return new HttpResponse(detailHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });

      await twoPage.search('test');
      await twoPage.resolveDownloadUrl({ downloadUrl: abbDetailsSentinel(MURDER_URL), protocol: 'torrent', isFreeleech: false });

      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(1);
      expect(seen[0]).toBe(PINNED_USER_AGENT);
    });

    it('sends the same UA from the direct connection test', async () => {
      let seen: string | null = null;
      server.use(
        http.head(`${ABB_BASE}/`, ({ request }) => {
          seen = request.headers.get('User-Agent');
          return new HttpResponse(null, { status: 200 });
        }),
      );

      await indexer.test();

      expect(seen).toBe(PINNED_USER_AGENT);
    });

    it('sends the same UA from the standard-proxy connection test', async () => {
      let seen: string | null = null;
      const proxied = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, proxyUrl: 'http://proxy.test:8080' });
      server.use(
        http.get(`${ABB_BASE}/`, ({ request }) => {
          seen = request.headers.get('User-Agent');
          return new HttpResponse('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } });
        }),
        http.get('https://api.ipify.org', () => HttpResponse.json({ ip: '1.2.3.4' })),
      );

      await proxied.test();

      expect(seen).toBe(PINNED_USER_AGENT);
    });

    it('sends the same UA in the headers handed to FlareSolverr for the connection test', async () => {
      const PROXY_URL = 'http://flaresolverr.test:8191';
      const solverIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
      let forwarded: Record<string, string> | undefined;
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          const body = await request.json() as { headers?: Record<string, string> };
          forwarded = body.headers;
          return solverOk('<html>ok</html>');
        }),
      );

      await solverIndexer.test();

      expect(forwarded?.['User-Agent']).toBe(PINNED_USER_AGENT);
    });
  });

  describe('parse trace shape (#932 AC1)', () => {
    it('populates parseStats and per-row debugTrace including search-page transport metadata', async () => {
      serveSearchPages();

      const response = await indexer.search('Brandon Sanderson');

      expect(response.requestUrl).toContain(ABB_BASE);
      expect(response.httpStatus).toBe(200);
      expect(response.parseStats.kept).toBe(response.results.length);
      expect(response.debugTrace.some((t) => t.reason === 'kept' && t.rawTitleBytes)).toBe(true);
    });

    it('carries the path-derived guid on every kept trace entry', async () => {
      serveSearchPages();

      const { debugTrace } = await indexer.search('test');

      expect(debugTrace.filter((t) => t.reason === 'kept').map((t) => t.guid)).toEqual([MURDER_GUID, WISH_GUID]);
    });

    it('conserves the counters across kept and dropped rows', async () => {
      serveSearchPages();

      const { parseStats, results } = await indexer.search('test');
      const { dropped } = parseStats;

      expect(parseStats.kept + dropped.emptyTitle + dropped.noUrl + dropped.other).toBe(parseStats.itemsObserved);
      expect(parseStats.kept).toBe(results.length);
      expect(parseStats.itemsObserved).toBe(2);
    });
  });

  describe('test', () => {
    it('returns success on HTTP 200', async () => {
      server.use(http.head(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 200 })));

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain(ABB_HOST);
    });

    it('returns success on HTTP 405 (Method Not Allowed)', async () => {
      server.use(http.head(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 405 })));

      const result = await indexer.test();
      expect(result.success).toBe(true);
    });

    it('returns failure on HTTP error', async () => {
      server.use(http.head(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 503 })));

      const result = await indexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('503');
    });

    it('returns failure on network error', async () => {
      server.use(http.head(`${ABB_BASE}/`, () => HttpResponse.error()));

      const result = await indexer.test();
      expect(result.success).toBe(false);
    });

    it('reports a pacer rejection as a failed test rather than throwing', async () => {
      acquire.mockRejectedValueOnce(new Error('ABB throttle reset'));

      const result = await indexer.test();

      expect(result.success).toBe(false);
      expect(result.message).toContain('ABB throttle reset');
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
    });

    it('routes search through proxy when flareSolverrUrl configured', async () => {
      const solverTargets: string[] = [];
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          const body = await request.json() as { url: string };
          solverTargets.push(body.url);
          return solverOk(searchHtml);
        }),
      );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(solverTargets).toEqual([`${ABB_BASE}/?s=brandon+sanderson&tt=1`]);
      expect(results).toHaveLength(2);
    });

    it('uses GET (request.get) for proxied test, not HEAD', async () => {
      let capturedBody: Record<string, unknown> = {};
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          capturedBody = await request.json() as Record<string, unknown>;
          return solverOk('<html>ok</html>');
        }),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(true);
      expect(result.message).toContain('via FlareSolverr');
      expect(capturedBody.cmd).toBe('request.get');
    });

    it('direct test still uses HEAD/405', async () => {
      server.use(http.head(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 405 })));

      const result = await indexer.test();
      expect(result.success).toBe(true);
      expect(result.message).not.toContain('FlareSolverr');
    });

    it('throws proxy errors from search page fetch (not swallowed)', async () => {
      server.use(http.post(`${PROXY_URL}/v1`, () => HttpResponse.error()));

      await expect(proxiedIndexer.search('test')).rejects.toThrow('FlareSolverr');
    });

    it('returns failure on proxy error during test', async () => {
      server.use(
        http.post(`${PROXY_URL}/v1`, () => HttpResponse.json({ status: 'error', message: 'Challenge failed' })),
      );

      const result = await proxiedIndexer.test();
      expect(result.success).toBe(false);
      expect(result.message).toContain('FlareSolverr');
    });
  });

  describe('AbortSignal threading', () => {
    it('forwards the signal to the search page fetch', async () => {
      const capturedSignals: AbortSignal[] = [];
      server.use(
        http.get(`${ABB_BASE}/`, ({ request }) => {
          capturedSignals.push(request.signal);
          return new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );

      const controller = new AbortController();
      await indexer.search('test', { signal: controller.signal });

      expect(capturedSignals).toHaveLength(1);
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
    });

    it('search rethrows ProxyError when fetch connection fails', async () => {
      server.use(http.get(`${ABB_BASE}/`, () => HttpResponse.error()));

      await expect(proxiedIndexer.search('test')).rejects.toThrow(ProxyError);
    });

    // Direct mode has no ProxyError to raise, which is exactly why this used to degrade silently.
    it('search propagates a direct network error rather than returning empty results', async () => {
      const directIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1 });
      server.use(http.get(`${ABB_BASE}/`, () => HttpResponse.error()));

      await expect(directIndexer.search('test')).rejects.toThrow();
    });

    it('test with proxy returns success with exit IP', async () => {
      server.use(
        http.get(`${ABB_BASE}/`, () =>
          new HttpResponse('<html>ok</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
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

    it('passes a dispatcher fetch option when constructed with proxyUrl', async () => {
      const proxiedIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, proxyUrl: PROXY_URL });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(searchHtml, { status: 200, headers: { 'Content-Type': 'text/html' } }),
      );

      const { results } = await proxiedIndexer.search('Brandon Sanderson');

      expect(results).toHaveLength(2);
      expect(results[0]!.indexer).toBe('AudioBookBay');
      const callArgs = fetchSpy.mock.calls[0];
      expect((callArgs![1] as Record<string, unknown>).dispatcher).toBeDefined();

      fetchSpy.mockRestore();
    });
  });

  /**
   * The amplification guard (#2373 AC5). `search()` rethrows only what `isProxyRelatedError` accepts
   * and degrades everything else on a later page, so a slot-wait failure typed as a plain `Error`
   * would be dropped, ABB would report an empty result set, the search service would count it as
   * `succeeded`, and the query ladder would read an answered zero and advance — issuing more solver
   * requests, which is exactly the amplification the bound exists to prevent.
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

    // The resolve seam replaces the deleted search-time enrichment as the second solver-bound path.
    it('surfaces a slot-wait timeout from a grab as an IndexerError over a ProxyError cause', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

      const timer = bound.captureTimers();
      const resolving = bound.track(proxiedIndexer.resolveDownloadUrl({
        downloadUrl: abbDetailsSentinel(MURDER_URL),
        protocol: 'torrent',
        isFreeleech: false,
      }));
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      timer.fire();

      const error = await resolving.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IndexerError);
      expect((error as IndexerError).cause).toBeInstanceOf(ProxyError);
      expect(stub.targets).not.toContain(MURDER_URL);
    });

    it('makes the connection test queue behind other solver traffic and reports the slot wait', async () => {
      const stub = bound.stub(`${PROXY_URL}/v1`);
      await bound.saturate(stub, PROXY_URL);

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
        vi.mocked(globalThis.setTimeout).mockRestore();
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

  /**
   * #2483 — the solver relays the ORIGIN's status inside its own 200 envelope. ABB is the one
   * indexer that bans, so a challenge page parsing as zero rows was recorded as an answered empty
   * search, which reset the breaker and kept the ladder pacing requests at a site telling us to
   * stop. These cases are the adapter half of the gate: which page it kills, and which it spares.
   */
  describe('#2483 a solver-delivered non-2xx status', () => {
    const SOLVER_URL = 'http://flaresolverr.test:8191';
    const SOLVER_ENDPOINT = `${SOLVER_URL}/v1`;
    const CHALLENGE = '<html><body>Checking your browser…</body></html>';

    let routed: RoutedFetch | undefined;

    afterEach(() => {
      routed?.restore();
      routed = undefined;
    });

    function solverIndexer(pageLimit = 1): AudioBookBayIndexer {
      return new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit, flareSolverrUrl: SOLVER_URL });
    }

    /** An `ok` envelope whose delivered status is `status`, keyed on the target page the solver asked for. */
    function serveSolver(statusFor: (targetUrl: string) => { body: string; status: number }): { targets: string[] } {
      const targets: string[] = [];
      server.use(
        http.post(SOLVER_ENDPOINT, async ({ request }) => {
          const { url } = await request.json() as { url: string };
          targets.push(url);
          const { body, status } = statusFor(url);
          return HttpResponse.json({ status: 'ok', solution: { response: body, status } });
        }),
      );
      return { targets };
    }

    const isPageTwo = (url: string) => url.includes('/page/2/');

    it('rejects rather than reporting an answered zero when page one is answered 503', async () => {
      serveSolver(() => ({ body: CHALLENGE, status: 503 }));

      const error = await solverIndexer().search('test').catch((e: unknown) => e);

      expect(httpStatusOf(error)).toBe(503);
      expect(getErrorMessage(error)).toContain('503');
    });

    /**
     * The pairing is the point: a delivered status means the origin ANSWERED, so it must classify
     * as an upstream answer and leave the page-one rows standing — which is exactly what
     * `mustPropagate`'s `isProxyRelatedError` arm would undo if the message led with `FlareSolverr`.
     */
    it('degrades to the page-one rows when a LATER page is answered 503', async () => {
      serveSolver((url) => (isPageTwo(url)
        ? { body: CHALLENGE, status: 503 }
        : { body: searchHtml, status: 200 }));

      const { results } = await solverIndexer(2).search('test');

      expect(results).toHaveLength(2);
    });

    it('does not classify the delivered status as a proxy-related error', async () => {
      serveSolver(() => ({ body: CHALLENGE, status: 503 }));

      const error = await solverIndexer().search('test').catch((e: unknown) => e);

      expect(isProxyRelatedError(error)).toBe(false);
    });

    /** Without this, "page two degrades" reads as a solver quirk rather than transport parity. */
    describe('direct-path parity control', () => {
      it('rejects on a direct 503 on page one', async () => {
        server.use(http.get(`${ABB_BASE}/`, () => new HttpResponse(null, { status: 503 })));

        const error = await indexer.search('test').catch((e: unknown) => e);

        expect(httpStatusOf(error)).toBe(503);
      });

      it('degrades to the page-one rows on a direct 503 on page two', async () => {
        server.use(
          http.get(`${ABB_BASE}/`, () => new HttpResponse(searchHtml, { headers: { 'Content-Type': 'text/html' } })),
          http.get(`${ABB_BASE}/page/2/`, () => new HttpResponse(null, { status: 503 })),
        );

        const { results } = await new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 }).search('test');

        expect(results).toHaveLength(2);
      });
    });

    describe('the connection test (AC11)', () => {
      it('fails with a message naming the delivered status', async () => {
        routed = routeFetch((url, method) => (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)
          ? solverEnvelope({ status: 'ok', solution: { response: CHALLENGE, status: 503 } })
          : new Response(null, { status: 200 })));

        const result = await solverIndexer().test();

        expect(result.success).toBe(false);
        expect(result.message).toContain('503');
      });

      /**
       * The branch the finding exists for. With the target's own probe refused, the old path
       * rendered `Target unreachable: … (ECONNREFUSED)` — no status, and a flat misdescription of
       * an origin that demonstrably answered. Asserting no HEAD was issued is what makes the probe
       * outcome irrelevant rather than merely lucky.
       */
      it('names the status even when a direct probe of the target would be refused', async () => {
        const calls = routeFetch((url, method) => {
          if (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)) {
            return solverEnvelope({ status: 'ok', solution: { response: CHALLENGE, status: 503 } });
          }
          return codedRejection('ECONNREFUSED');
        });
        routed = calls;

        const result = await solverIndexer().test();

        expect(result.message).toContain('503');
        expect(result.message).not.toContain('ECONNREFUSED');
        expect(calls.probes()).toEqual([]);
      });
    });

    /** AC8 — the detail wrapper has no degrade arm, so the status travels through the retained cause. */
    it('surfaces the delivered status through resolveDownloadUrl\'s IndexerError wrapper', async () => {
      serveSolver(() => ({ body: CHALLENGE, status: 503 }));

      const error = await solverIndexer()
        .resolveDownloadUrl({ downloadUrl: abbDetailsSentinel(MURDER_URL), protocol: 'torrent', isFreeleech: false })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(IndexerError);
      expect(getErrorMessage(error)).toContain('503');
      expect(getErrorMessage(error)).not.toContain('carried no info hash');
      expect(isProxyRelatedError((error as IndexerError).cause)).toBe(false);
      expect(httpStatusOf(error)).toBe(503);
    });

    /**
     * AC16 — the delivered non-2xx is a new exit path through `fetchViaSolver`'s `finally`. A leaked
     * mutex would hang the second search rather than fail it, which is why the assertion is that the
     * second request reaches the solver at all.
     */
    it('releases the ABB solver mutex, so the next search still reaches the solver', async () => {
      const { targets } = serveSolver((url) => (url.includes('s=second')
        ? { body: searchHtml, status: 200 }
        : { body: CHALLENGE, status: 503 }));
      const abb = solverIndexer();

      await expect(abb.search('first')).rejects.toThrow('503');
      const { results } = await abb.search('second');

      expect(results).toHaveLength(2);
      expect(targets).toHaveLength(2);
    });
  });

  /**
   * #2422 — ABB's tokenizer treats the apostrophe as a word character, so the de-apostrophized
   * query the service builds carries a token nothing can match. Assertions here read the request
   * URL that actually left, never a mock argument: the fold has to survive URL construction.
   */
  describe('apostrophe-bearing queries (#2422)', () => {
    const STRIPPED = 'A Dragon Riders Guide to Retirement Julia Huni';
    const WITH_APOSTROPHE = "A Dragon Rider's Guide to Retirement Julia Huni";

    function searchParamOf(url: string): string | null {
      return new URL(url).searchParams.get('s');
    }

    it('folds the apostrophe word out of the request URL when the option carries it', async () => {
      const { urls } = serveSearchPages();

      await indexer.search(STRIPPED, { queryWithApostrophes: WITH_APOSTROPHE });

      expect(urls[0]).toContain('?s=a+dragon+guide+to+retirement+julia+huni&tt=1');
      expect(searchParamOf(urls[0]!)).toBe('a dragon guide to retirement julia huni');
    });

    it('folds a lowercase relaxed-rung value to the identical URL as the source-cased rung-1 value', async () => {
      const { urls } = serveSearchPages();

      await indexer.search(STRIPPED, { queryWithApostrophes: WITH_APOSTROPHE });
      await indexer.search(STRIPPED.toLowerCase(), { queryWithApostrophes: WITH_APOSTROPHE.toLowerCase() });

      expect(urls[1]).toBe(urls[0]);
    });

    it('issues today’s URL when no options object is passed at all', async () => {
      const { urls } = serveSearchPages();

      await indexer.search('Brandon Sanderson');

      expect(urls[0]).toBe(`${ABB_BASE}/?s=brandon+sanderson&tt=1`);
    });

    it('issues today’s URL when options are present but queryWithApostrophes is undefined', async () => {
      const { urls } = serveSearchPages();

      await indexer.search(STRIPPED, { limit: 50 });

      expect(searchParamOf(urls[0]!)).toBe('a dragon riders guide to retirement julia huni');
    });

    it('issues today’s empty-query request for the RSS-path shape without throwing', async () => {
      const { urls } = serveSearchPages();

      await expect(indexer.search('')).resolves.toBeDefined();

      expect(urls[0]).toBe(`${ABB_BASE}/?s=&tt=1`);
    });

    it('carries the folded query onto page two as well', async () => {
      const twoPageIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages();

      await twoPageIndexer.search(STRIPPED, { queryWithApostrophes: WITH_APOSTROPHE });

      expect(urls[1]).toContain('/page/2/');
      expect(searchParamOf(urls[1]!)).toBe('a dragon guide to retirement julia huni');
    });

    it('carries the folded query into the URL handed to FlareSolverr', async () => {
      const solverTargets: string[] = [];
      const PROXY_URL = 'http://flaresolverr.test:8191';
      const proxiedIndexer = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 1, flareSolverrUrl: PROXY_URL });
      server.use(
        http.post(`${PROXY_URL}/v1`, async ({ request }) => {
          const body = await request.json() as { url: string };
          solverTargets.push(body.url);
          return solverOk(searchHtml);
        }),
      );

      await proxiedIndexer.search(STRIPPED, { queryWithApostrophes: WITH_APOSTROPHE });

      expect(solverTargets).toEqual([`${ABB_BASE}/?s=a+dragon+guide+to+retirement+julia+huni&tt=1`]);
    });
  });

  /**
   * #2421 — a slice of ABB's results arrives as anti-scraper chaff: the row's markup is base64
   * inside a `div.post.re-ab`, which the row loop dropped as `empty-title`. The DOM contract lives
   * in `abb-re-ab.test.ts`; what is pinned here is the wiring — ordering, identity, counters and
   * the drop reason as a real `search()` produces them.
   */
  describe('base64-obfuscated re-ab posts (#2421)', () => {
    const b64 = (markup: string): string => Buffer.from(markup, 'utf-8').toString('base64');
    const plainPost = (inner: string): string => `<div class="post">${inner}</div>`;
    const reAbPost = (inner: string): string => `<div class="post re-ab">${b64(inner)}</div>`;
    const rawReAbPost = (payload: string): string => `<div class="post re-ab">${payload}</div>`;
    const page = (...posts: string[]): string => `<html><body>${posts.join('')}</body></html>`;

    /**
     * The row's own markup, with the metadata block on one source line exactly as `abb-search.html`
     * writes it: a regression to a flattened `.text()` read then reds on exact author/narrator.
     */
    function rowMarkup(slug: string, title: string, author = 'Ada Lovelace', narrator = 'Grace Hopper'): string {
      return [
        `<div class="postTitle"><h2><a href="/audio-books/${slug}/" rel="bookmark">${title}</a></h2></div>`,
        '<div class="postContent">',
        `<div class="postImg"><img src="https://example.com/covers/${slug}.jpg" alt="cover" /></div>`,
        `<p>Written by <a href="/a/"><span class="author" itemprop="author">${author}</span></a><br>Read by <a href="/n/"><span class="narrator" itemprop="author">${narrator}</span></a><br>Format: <span class="format" itemprop="encodingFormat">M4B</span><br>Bitrate: <span class="bitrate" itemprop="bitrate">128 Kbps</span></p>`,
        '</div>',
        '<div class="postInfo">Shared by: <span class="author"><a href="/member/uploader123/">uploader123</a></span> On: 12 Dec 2022</div>',
      ].join('');
    }

    /** Alphabet-clean, so a guard that only tries `Buffer.from` and shrugs still has to reject it. */
    const UNDECODABLE = b64('just some prose, not markup');

    it('returns the decoded row alongside a plain one, fully populated and in document order', async () => {
      serveSearchPages(page(plainPost(rowMarkup('plain-row', 'Plain Row')), reAbPost(rowMarkup('obfuscated-row', 'Obfuscated Row'))));
      const details = countDetailRequests();

      const { results } = await indexer.search('test');

      expect(results.map((r) => r.title)).toEqual(['Plain Row', 'Obfuscated Row']);
      expect(results[1]).toMatchObject({
        title: 'Obfuscated Row',
        guid: 'abb:/audio-books/obfuscated-row/',
        detailsUrl: `${ABB_BASE}/audio-books/obfuscated-row/`,
        downloadUrl: abbDetailsSentinel(`${ABB_BASE}/audio-books/obfuscated-row/`),
        coverUrl: 'https://example.com/covers/obfuscated-row.jpg',
        author: 'Ada Lovelace',
        narrator: 'Grace Hopper',
        format: 'm4b',
        indexer: 'AudioBookBay',
        protocol: 'torrent',
      });
      expect(details.count).toBe(0);
    });

    /**
     * The observable form of "indistinguishable": same own keys, same values, same keys ABSENT —
     * without which AC2 is satisfiable by a decoded row that quietly gains or loses a field.
     */
    it('produces a result object with the same key set and values as a byte-identical plain row', async () => {
      serveSearchPages(page(
        plainPost(rowMarkup('plain-parity', 'Parity Row')),
        reAbPost(rowMarkup('encoded-parity', 'Parity Row')),
      ));

      const { results } = await indexer.search('test');
      const [plain, decoded] = results as [SearchResult, SearchResult];

      expect(Object.keys(decoded).sort()).toEqual(Object.keys(plain).sort());
      const identityFields = new Set(['guid', 'downloadUrl', 'detailsUrl', 'coverUrl']);
      const shared = (result: SearchResult) =>
        Object.fromEntries(Object.entries(result).filter(([key]) => !identityFields.has(key)));
      expect(shared(decoded)).toEqual(shared(plain));
      for (const result of [plain, decoded]) {
        expect(result).not.toHaveProperty('infoHash');
        expect(result).not.toHaveProperty('seeders');
        expect(result).not.toHaveProperty('leechers');
        expect(result).not.toHaveProperty('size');
      }
    });

    it('counts a decoded row as kept, with no correction term on itemsObserved', async () => {
      serveSearchPages(page(plainPost(rowMarkup('plain-row', 'Plain Row')), reAbPost(rowMarkup('obfuscated-row', 'Obfuscated Row'))));

      const { parseStats, debugTrace } = await indexer.search('test');

      expect(parseStats).toEqual({
        itemsObserved: 2,
        kept: 2,
        dropped: { emptyTitle: 0, noUrl: 0, other: 0 },
      });
      expect(debugTrace.map((t) => t.reason)).toEqual(['kept', 'kept']);
    });

    it('drops an undecodable blob under its own reason without disturbing the healthy rows', async () => {
      serveSearchPages(page(plainPost(rowMarkup('plain-row', 'Plain Row')), rawReAbPost(UNDECODABLE)));

      const { results, parseStats, debugTrace } = await indexer.search('test');

      expect(results.map((r) => r.title)).toEqual(['Plain Row']);
      expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:re-ab-undecodable', 'kept']);
      expect(debugTrace.filter((t) => t.reason === 'dropped:empty-title')).toEqual([]);
      expect(parseStats.dropped.other).toBe(1);
      expect(parseStats.dropped.emptyTitle).toBe(0);
      expect(parseStats.itemsObserved).toBe(2);
    });

    // Paired with the case above: this is what proves the reason is chosen on the SURVIVING class,
    // not on "the element started life as a re-ab row".
    it('drops a blob that decodes to titleless markup as empty-title, not as undecodable', async () => {
      serveSearchPages(page(reAbPost('<div class="postContent"><p>No anchor anywhere here.</p></div>')));

      const { results, parseStats, debugTrace } = await indexer.search('test');

      expect(results).toEqual([]);
      expect(debugTrace.map((t) => t.reason)).toEqual(['dropped:empty-title']);
      expect(parseStats.dropped.emptyTitle).toBe(1);
      expect(parseStats.dropped.other).toBe(0);
    });

    // The regression case for any implementation that REMOVES the undecodable node: the preference
    // chain would then fall through to `.post-content` and parse an element it never parses today.
    it('keeps the selector family and itemsObserved invariant when the only post is undecodable', async () => {
      serveSearchPages(page(
        rawReAbPost(UNDECODABLE),
        '<div class="post-content"><div class="postTitle"><h2><a href="/audio-books/decoy/" rel="bookmark">Decoy</a></h2></div></div>',
      ));

      const { results, parseStats, debugTrace } = await indexer.search('test');

      expect(results).toEqual([]);
      expect(parseStats.itemsObserved).toBe(1);
      expect(parseStats.dropped.other).toBe(1);
      expect(debugTrace).toHaveLength(1);
    });

    // A per-page counter that is computed but never summed is invisible to any single-page test.
    it('accumulates dropped.other across every page it parses', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      // A kept row per page is load-bearing: a page parsing to zero results breaks pagination, and
      // page two would never be fetched.
      const { urls } = serveSearchPages(page(plainPost(rowMarkup('kept-row', 'Kept Row')), rawReAbPost(UNDECODABLE)));

      const { results, parseStats } = await twoPage.search('test');

      expect(urls).toHaveLength(2);
      expect(urls[1]).toContain('/page/2/');
      expect(results).toHaveLength(2);
      expect(parseStats.dropped.other).toBe(2);
    });

    it('returns every row of an all-obfuscated page and keeps paginating', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages(page(
        reAbPost(rowMarkup('obfuscated-one', 'Obfuscated One')),
        reAbPost(rowMarkup('obfuscated-two', 'Obfuscated Two')),
      ));

      const { results, parseStats } = await twoPage.search('test');

      expect(results.map((r) => r.title)).toEqual(['Obfuscated One', 'Obfuscated Two', 'Obfuscated One', 'Obfuscated Two']);
      expect(urls).toHaveLength(2);
      expect(parseStats.kept).toBe(4);
    });

    it('stops paginating on an all-undecodable page exactly as it does on an empty one', async () => {
      const twoPage = new AudioBookBayIndexer({ hostname: ABB_HOST, pageLimit: 2 });
      const { urls } = serveSearchPages(page(rawReAbPost(UNDECODABLE), rawReAbPost(UNDECODABLE)));

      const { results, parseStats } = await twoPage.search('test');

      expect(results).toEqual([]);
      expect(urls).toHaveLength(1);
      expect(parseStats.kept).toBe(0);
      expect(parseStats.dropped.other).toBe(2);
    });

    // The decoded row must not vanish because the preference chain stopped at `div.post`: the row
    // is still read from the original node, and the decoded `article.post` wrapper is made inert.
    it('returns both rows when a blob decodes to an article.post wrapper beside a plain div.post', async () => {
      serveSearchPages(page(
        plainPost(rowMarkup('plain-row', 'Plain Row')),
        reAbPost(`<article class="post">${rowMarkup('wrapped-row', 'Wrapped Row')}</article>`),
      ));

      const { results, parseStats } = await indexer.search('test');

      expect(results.map((r) => r.title)).toEqual(['Plain Row', 'Wrapped Row']);
      expect(results.map((r) => r.guid)).toEqual([
        'abb:/audio-books/plain-row/',
        'abb:/audio-books/wrapped-row/',
      ]);
      expect(parseStats.itemsObserved).toBe(2);
    });

    /**
     * F10 — the precedence this pins is `titleSelectors`, which is private to `parseSearchPage`, so
     * it can only be observed through a real search. A multi-wrapper blob resolves by selector
     * family, NOT by document order: `.postTitle h2 a` is tried before `h3 a`.
     */
    it('resolves a two-wrapper blob by titleSelectors precedence, not document order', async () => {
      serveSearchPages(page(reAbPost(
        '<div class="post"><h3><a href="/audio-books/first/" rel="bookmark">First</a></h3></div>' +
        '<div class="post"><div class="postTitle"><h2><a href="/audio-books/second/" rel="bookmark">Second</a></h2></div></div>',
      )));

      const { results } = await indexer.search('test');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        title: 'Second',
        guid: 'abb:/audio-books/second/',
      });
    });

    // The decode path must not bypass the rewrite: a blob whose markup carries an off-host absolute
    // href would otherwise reintroduce exactly the aliasing the plain path no longer has.
    it('rewrites an off-host absolute href carried inside a decoded blob', async () => {
      serveSearchPages(page(reAbPost(
        '<div class="postTitle"><h2><a href="https://other.test/audio-books/decoded-absolute/" rel="bookmark">Decoded</a></h2></div>',
      )));

      const { results } = await indexer.search('test');

      expect(results[0]).toMatchObject({
        title: 'Decoded',
        guid: 'abb:/audio-books/decoded-absolute/',
        detailsUrl: `${ABB_BASE}/audio-books/decoded-absolute/`,
        downloadUrl: abbDetailsSentinel(`${ABB_BASE}/audio-books/decoded-absolute/`),
      });
    });

    it('leaves a decoded row past the budget unadmitted and untraced', async () => {
      serveSearchPages(page(plainPost(rowMarkup('plain-row', 'Plain Row')), reAbPost(rowMarkup('obfuscated-row', 'Obfuscated Row'))));

      const { results, debugTrace } = await indexer.search('test', { limit: 1 });

      expect(results.map((r) => r.title)).toEqual(['Plain Row']);
      expect(debugTrace).toHaveLength(1);
      expect(debugTrace[0]!.reason).toBe('kept');
    });

    // #2420's request guarantees: the decode is a pure in-document transform, so it buys no fetch.
    it('costs one search request, zero detail requests and one acquire on an obfuscated page', async () => {
      const { urls } = serveSearchPages(page(reAbPost(rowMarkup('obfuscated-row', 'Obfuscated Row'))));
      const details = countDetailRequests();

      const { results } = await indexer.search('test');

      expect(results).toHaveLength(1);
      expect(urls).toEqual([`${ABB_BASE}/?s=test&tt=1`]);
      expect(details.count).toBe(0);
      expect(acquire).toHaveBeenCalledTimes(1);
    });

    // The control for the whole transform: a page with no `re-ab` element must parse identically.
    it('is inert on a document carrying no re-ab element', async () => {
      serveSearchPages();

      const { results, parseStats, debugTrace } = await indexer.search('test');

      expect(results.map((r) => r.title)).toEqual(['Murder in the New Forest', 'Wish You Were Here Yet?']);
      expect(parseStats).toEqual({
        itemsObserved: 2,
        kept: 2,
        dropped: { emptyTitle: 0, noUrl: 0, other: 0 },
      });
      expect(debugTrace.map((t) => t.reason)).toEqual(['kept', 'kept']);
    });
  });

});
