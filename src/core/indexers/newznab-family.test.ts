/**
 * The caps-family contract, run against BOTH concrete adapters from one body of cases (#2391 AC8).
 *
 * Every case here asserts behaviour the shared base owns, so a fix applied to one adapter can no
 * longer silently leave the other behind — the drift the finding names. Divergences (torrent-vs-
 * usenet result shape, the magnet fallback, the selector asymmetry) have no counterpart row and
 * stay in the per-adapter suites.
 *
 * Adding a third caps-style adapter is a one-row change to `ROWS`.
 */

import { describe, it, expect, expectTypeOf, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import type * as NetworkServiceModule from '../utils/network-service.js';
import type * as ProxyModule from './proxy.js';

// Keep MSW/fetch spies on this test path while production retains dispatcher routing.
vi.mock('../utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithOptionalDispatcher: ((url, options) => globalThis.fetch(url, options as RequestInit)) as typeof actual.fetchWithOptionalDispatcher,
  };
});

// Case 13 asserts the exit-IP probe is NOT issued under solver precedence, which needs the real
// call site observable rather than merely `ip === undefined`.
vi.mock('./proxy.js', async (importActual) => {
  const actual = await importActual<typeof ProxyModule>();
  return {
    ...actual,
    resolveProxyIp: vi.fn(actual.resolveProxyIp),
    fetchWithProxyAgent: vi.fn(actual.fetchWithProxyAgent),
  };
});

import { TorznabIndexer } from './torznab.js';
import { NewznabIndexer } from './newznab.js';
import { ProxyError } from './errors.js';
import { fetchWithProxyAgent, resolveProxyIp } from './proxy.js';
import { useSolverBound } from '../__tests__/solver-bound.js';
import {
  abortRejection,
  codedRejection,
  routeFetch,
  solverEnvelope,
  type RoutedFetch,
} from '../__tests__/solver-routes.js';
import type { IndexerAdapter } from './types.js';

const API_BASE = 'https://indexer.test';
const API_HOST = 'indexer.test';
const SOLVER_URL = 'http://flaresolverr.test:8191';
const SOLVER_ENDPOINT = `${SOLVER_URL}/v1`;
const PROXY_URL = 'http://proxy.test:8080';
const API_KEY = 'testapikey';

interface FamilyConfig {
  apiUrl: string;
  apiKey: string;
  flareSolverrUrl?: string | undefined;
  proxyUrl?: string | undefined;
}

interface AdapterRow {
  label: string;
  /**
   * The optional second argument is the adapter's display name. It is part of the seam because case
   * 3 has to drive the derived-name and explicit-name arms through the same callback (spec-review F7);
   * a one-parameter callback makes the explicit-name call an arity error.
   */
  make: (config: FamilyConfig, name?: string) => IndexerAdapter;
  protocol: 'torrent' | 'usenet';
  attrsParam: string;
  errorPrefix: string;
}

const ROWS: AdapterRow[] = [
  {
    label: 'torznab',
    make: (config, name) => new TorznabIndexer(config, name),
    protocol: 'torrent',
    attrsParam: 'grabs,language',
    errorPrefix: 'Torznab API error',
  },
  {
    label: 'newznab',
    make: (config, name) => new NewznabIndexer(config, name),
    protocol: 'usenet',
    attrsParam: 'grabs,language,group,files',
    errorPrefix: 'Newznab API error',
  },
];

/**
 * `newznab:attr` is honoured by both adapters' selectors, so shared fixtures use it exclusively —
 * the selector asymmetry is a divergence and is asserted in the per-adapter suites instead.
 */
function rss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Shared Contract Indexer</title>${items}
  </channel>
</rss>`;
}

const ITEM_FULL = `
    <item>
      <title>The Way of Kings</title>
      <guid isPermaLink="true">https://indexer.test/details/abc123</guid>
      <comments>https://indexer.test/comments/abc123</comments>
      <enclosure url="https://indexer.test/download/abc123.bin" length="1073741824"/>
      <newznab:attr name="size" value="2147483648"/>
      <newznab:attr name="grabs" value="42"/>
      <newznab:attr name="language" value="ENG"/>
    </item>`;

/** Title plus enclosure only — every optional key must be ABSENT, not `undefined`. */
const ITEM_MINIMAL = `
    <item>
      <title>Bare Minimum Book</title>
      <enclosure url="https://indexer.test/download/min.bin"/>
    </item>`;

const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="Shared Caps Indexer" url="https://indexer.test"/>
  <searching><search available="yes" supportedParams="q"/></searching>
</caps>`;

const CAPS_NESTED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps><server title="Nested Caps Indexer"/></caps>`;

const CAPS_NO_SERVER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps><searching><search available="yes"/></searching></caps>`;

/** Distinguishes a rejection from a resolved-but-empty response; a bare `rejects` cannot. */
async function settle<T>(promise: Promise<T>): Promise<
  { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown }
> {
  try {
    return { kind: 'resolved', value: await promise };
  } catch (error: unknown) {
    return { kind: 'rejected', error };
  }
}

/**
 * AC3 — the subclass literals are a compile-time property, so this case is deliberately NOT
 * table-driven: `expectTypeOf` operates on static types and cannot be parameterised over a runtime
 * row. A widened `readonly type: string = 'torznab'` leaves every runtime assertion in the repo
 * green and fails only here, under `pnpm typecheck`.
 */
describe('newznab family — adapter type literals (AC3)', () => {
  it('keeps each subclass type narrow to its own literal', () => {
    expectTypeOf<TorznabIndexer['type']>().toEqualTypeOf<'torznab'>();
    expectTypeOf<NewznabIndexer['type']>().toEqualTypeOf<'newznab'>();
  });
});

describe.each(ROWS)('newznab family contract — $label', (row) => {
  const server = useMswServer();
  let routed: RoutedFetch | undefined;

  afterEach(() => {
    routed?.restore();
    routed = undefined;
    vi.unstubAllEnvs();
    vi.mocked(resolveProxyIp).mockClear();
    vi.mocked(fetchWithProxyAgent).mockClear();
  });

  function adapter(overrides: Partial<FamilyConfig> = {}, name?: string): IndexerAdapter {
    return row.make({ apiUrl: API_BASE, apiKey: API_KEY, ...overrides }, name);
  }

  function serveXml(xml: string, capture?: (request: Request) => void) {
    server.use(
      http.get(`${API_BASE}/api`, ({ request }) => {
        capture?.(request);
        return new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } });
      }),
    );
  }

  // 1 — request shape
  describe('search request shape', () => {
    it('issues the search params in the documented order', async () => {
      let capturedUrl = '';
      serveXml(rss(ITEM_FULL), (request) => { capturedUrl = request.url; });

      await adapter().search('the way of kings', { limit: 25 });

      expect(new URL(capturedUrl).search).toBe(
        `?t=search&q=the+way+of+kings&apikey=${API_KEY}&cat=3030&limit=25&attrs=${encodeURIComponent(row.attrsParam)}`,
      );
    });

    it('appends author last, and only when supplied', async () => {
      let withAuthor = '';
      serveXml(rss(ITEM_FULL), (request) => { withAuthor = request.url; });
      await adapter().search('kings', { limit: 5, author: 'Brandon Sanderson' });

      expect(new URL(withAuthor).search).toBe(
        `?t=search&q=kings&apikey=${API_KEY}&cat=3030&limit=5&attrs=${encodeURIComponent(row.attrsParam)}&author=Brandon+Sanderson`,
      );

      let withoutAuthor = '';
      serveXml(rss(ITEM_FULL), (request) => { withoutAuthor = request.url; });
      await adapter().search('kings', { limit: 5 });

      expect(new URL(withoutAuthor).searchParams.has('author')).toBe(false);
    });

    it('sends the XML Accept header and the Narratorr User-Agent', async () => {
      vi.stubEnv('GIT_TAG', 'v9.9.9');
      let accept: string | null = null;
      let userAgent: string | null = null;
      serveXml(rss(ITEM_FULL), (request) => {
        accept = request.headers.get('accept');
        userAgent = request.headers.get('user-agent');
      });

      await adapter().search('kings');

      expect(accept).toBe('application/rss+xml, application/xml, text/xml');
      expect(userAgent).toBe('Narratorr/v9.9.9');
    });

    it('defaults limit to 100 when the option is omitted', async () => {
      let capturedUrl = '';
      serveXml(rss(ITEM_FULL), (request) => { capturedUrl = request.url; });

      await adapter().search('kings');

      expect(new URL(capturedUrl).searchParams.get('limit')).toBe('100');
    });
  });

  // 2 — caps request shape
  describe('caps request shape', () => {
    it('issues only t and apikey on the caps request', async () => {
      let capturedUrl = '';
      server.use(
        http.get(`${API_BASE}/api`, ({ request }) => {
          capturedUrl = request.url;
          return new HttpResponse(CAPS_XML, { headers: { 'Content-Type': 'application/xml' } });
        }),
      );

      await adapter().test();

      expect(new URL(capturedUrl).search).toBe(`?t=caps&apikey=${API_KEY}`);
    });
  });

  // 3 — apiUrl normalization and adapter name
  describe('apiUrl normalization and name', () => {
    it('produces the same request URL with and without trailing slashes', async () => {
      let plain = '';
      serveXml(rss(ITEM_FULL), (request) => { plain = request.url; });
      await adapter().search('kings', { limit: 5 });

      let slashed = '';
      serveXml(rss(ITEM_FULL), (request) => { slashed = request.url; });
      await adapter({ apiUrl: `${API_BASE}///` }).search('kings', { limit: 5 });

      expect(slashed).toBe(plain);
    });

    it('derives name from the apiUrl hostname, and lets an explicit name win', () => {
      expect(adapter().name).toBe(API_HOST);
      expect(adapter({}, 'My Indexer').name).toBe('My Indexer');
      expect(adapter({ apiUrl: `${API_BASE}///` }).name).toBe(API_HOST);
    });
  });

  // 4 — payload validation, both directions
  describe('payload validation', () => {
    it('parses a well-formed rss/channel payload', async () => {
      serveXml(rss(ITEM_FULL));

      const { results } = await adapter().search('kings');

      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('The Way of Kings');
      expect(results[0]!.protocol).toBe(row.protocol);
      expect(results[0]!.indexer).toBe(API_HOST);
    });

    it('throws on a payload with neither <rss> nor <channel>', async () => {
      serveXml('<?xml version="1.0"?><notrss><thing/></notrss>');

      await expect(adapter().search('kings')).rejects.toThrow(
        'Invalid RSS response: missing <rss> or <channel> element',
      );
    });

    it('throws with the adapter-specific prefix and the error description', async () => {
      serveXml('<?xml version="1.0"?><error code="100" description="Incorrect user credentials"/>');

      await expect(adapter().search('kings')).rejects.toThrow(
        `${row.errorPrefix}: Incorrect user credentials`,
      );
    });

    it('falls back to the error code when no description is present', async () => {
      serveXml('<?xml version="1.0"?><error code="100"/>');

      await expect(adapter().search('kings')).rejects.toThrow(`${row.errorPrefix}: 100`);
    });

    it('answers a zero-item channel with an empty result set rather than throwing', async () => {
      serveXml(rss(''));

      const { results, parseStats } = await adapter().search('kings');

      expect(results).toEqual([]);
      expect(parseStats).toEqual({
        itemsObserved: 0,
        kept: 0,
        dropped: { emptyTitle: 0, noUrl: 0, other: 0 },
      });
    });
  });

  // 5 — limit boundary
  describe('limit boundary', () => {
    it('observes the item that trips the limit but does not keep it', async () => {
      serveXml(rss(`
    <item><title>One</title><enclosure url="https://indexer.test/1.bin"/></item>
    <item><title>Two</title><enclosure url="https://indexer.test/2.bin"/></item>
    <item><title>Three</title><enclosure url="https://indexer.test/3.bin"/></item>`));

      const { results, parseStats } = await adapter().search('kings', { limit: 2 });

      expect(results).toHaveLength(2);
      expect(parseStats.kept).toBe(2);
      expect(parseStats.itemsObserved).toBe(3);
    });
  });

  // 6 — falsy numerics
  describe('falsy numeric attrs', () => {
    it('drops a zero size but keeps a zero grabs', async () => {
      serveXml(rss(`
    <item>
      <title>Zero Numerics</title>
      <enclosure url="https://indexer.test/zero.bin" length="0"/>
      <newznab:attr name="size" value="0"/>
      <newznab:attr name="grabs" value="0"/>
    </item>`));

      const { results } = await adapter().search('kings');

      expect(results[0]).not.toHaveProperty('size');
      expect(results[0]!.grabs).toBe(0);
    });

    it('drops a zero enclosure length when no size attr is present', async () => {
      serveXml(rss(`
    <item>
      <title>Zero Enclosure</title>
      <enclosure url="https://indexer.test/zero.bin" length="0"/>
    </item>`));

      const { results } = await adapter().search('kings');

      expect(results[0]).not.toHaveProperty('size');
    });

    it('drops a non-numeric or blank grabs', async () => {
      serveXml(rss(`
    <item>
      <title>Garbage Grabs</title>
      <enclosure url="https://indexer.test/g.bin"/>
      <newznab:attr name="grabs" value="not-a-number"/>
    </item>
    <item>
      <title>Blank Grabs</title>
      <enclosure url="https://indexer.test/b.bin"/>
      <newznab:attr name="grabs" value=""/>
    </item>`));

      const { results } = await adapter().search('kings');

      expect(results).toHaveLength(2);
      expect(results[0]).not.toHaveProperty('grabs');
      expect(results[1]).not.toHaveProperty('grabs');
    });

    it('prefers a numeric size attr over the enclosure length, and falls back when absent', async () => {
      serveXml(rss(`
    <item>
      <title>Attr Wins</title>
      <enclosure url="https://indexer.test/a.bin" length="111"/>
      <newznab:attr name="size" value="999"/>
    </item>
    <item>
      <title>Enclosure Fallback</title>
      <enclosure url="https://indexer.test/b.bin" length="222"/>
    </item>`));

      const { results } = await adapter().search('kings');

      expect(results[0]!.size).toBe(999);
      expect(results[1]!.size).toBe(222);
    });
  });

  // 7 — null/missing fields
  describe('absent optional fields', () => {
    it('omits every optional key for a title-plus-enclosure item', async () => {
      serveXml(rss(ITEM_MINIMAL));

      const { results } = await adapter().search('kings');

      expect(results[0]!.title).toBe('Bare Minimum Book');
      for (const key of ['guid', 'detailsUrl', 'language', 'size', 'grabs']) {
        expect(results[0]).not.toHaveProperty(key);
      }
    });

    it('falls back to <comments> for detailsUrl when <guid> is empty', async () => {
      serveXml(rss(`
    <item>
      <title>Comments Fallback</title>
      <guid></guid>
      <comments>https://indexer.test/comments/xyz</comments>
      <enclosure url="https://indexer.test/c.bin"/>
    </item>`));

      const { results } = await adapter().search('kings');

      expect(results[0]!.detailsUrl).toBe('https://indexer.test/comments/xyz');
      expect(results[0]).not.toHaveProperty('guid');
    });

    it('prefers <guid> over <comments> for detailsUrl', async () => {
      serveXml(rss(ITEM_FULL));

      const { results } = await adapter().search('kings');

      expect(results[0]!.detailsUrl).toBe('https://indexer.test/details/abc123');
      expect(results[0]!.guid).toBe('https://indexer.test/details/abc123');
    });

    it('normalizes a language code and omits the key when the attr is missing', async () => {
      serveXml(rss(ITEM_FULL + ITEM_MINIMAL));

      const { results } = await adapter().search('kings');

      expect(results[0]!.language).toBe('english');
      expect(results[1]).not.toHaveProperty('language');
    });
  });

  // 8 — drop paths and trace entries
  describe('drop paths and debugTrace', () => {
    it('drops an empty title, records the trace entry, and carries its guid', async () => {
      serveXml(rss(`
    <item>
      <title>   </title>
      <guid>https://indexer.test/details/blank</guid>
      <enclosure url="https://indexer.test/blank.bin"/>
    </item>
    <item><title>Valid Title</title><enclosure url="https://indexer.test/ok.bin"/></item>`));

      const { results, parseStats, debugTrace } = await adapter().search('kings');

      expect(results).toHaveLength(1);
      expect(results[0]!.title).toBe('Valid Title');
      expect(parseStats.dropped.emptyTitle).toBe(1);
      expect(debugTrace[0]).toEqual({
        source: 'item',
        reason: 'dropped:empty-title',
        guid: 'https://indexer.test/details/blank',
      });
    });

    it('records dropped:no-url with the raw title and its byte shape', async () => {
      serveXml(rss(`
    <item><title>Über Bücher</title></item>`));

      const { results, parseStats, debugTrace } = await adapter().search('kings');

      expect(results).toEqual([]);
      expect(parseStats.dropped.noUrl).toBe(1);
      expect(debugTrace[0]).toEqual({
        source: 'item',
        reason: 'dropped:no-url',
        rawTitle: 'Über Bücher',
        rawTitleBytes: 'c39c6265722042c3bc63686572',
      });
    });

    it('records a kept item with the raw title and its byte shape', async () => {
      serveXml(rss(`
    <item><title>Über Bücher</title><enclosure url="https://indexer.test/u.bin"/></item>`));

      const { debugTrace } = await adapter().search('kings');

      expect(debugTrace[0]).toEqual({
        source: 'item',
        reason: 'kept',
        rawTitle: 'Über Bücher',
        rawTitleBytes: 'c39c6265722042c3bc63686572',
      });
    });
  });

  // 9 — transport metadata
  describe('transport metadata', () => {
    it('reports requestUrl and httpStatus on the direct path', async () => {
      serveXml(rss(ITEM_FULL));

      const { requestUrl, httpStatus } = await adapter().search('kings', { limit: 5 });

      expect(requestUrl).toContain(`${API_BASE}/api?t=search`);
      expect(httpStatus).toBe(200);
    });

    it('reports requestUrl and httpStatus on the proxied path', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(rss(ITEM_FULL), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } }),
      );

      const { requestUrl, httpStatus, results } = await adapter({ proxyUrl: PROXY_URL }).search('kings');

      expect(results).toHaveLength(1);
      expect(requestUrl).toContain(`${API_BASE}/api?t=search`);
      expect(httpStatus).toBe(200);
      fetchSpy.mockRestore();
    });

    it('reports the target URL and the upstream status on the solver path', async () => {
      server.use(
        http.post(SOLVER_ENDPOINT, () =>
          HttpResponse.json({ status: 'ok', solution: { response: rss(ITEM_FULL), status: 201 } })),
      );

      const { requestUrl, httpStatus } = await adapter({ flareSolverrUrl: SOLVER_URL }).search('kings');

      expect(requestUrl).toContain(`${API_BASE}/api?t=search`);
      expect(httpStatus).toBe(201);
    });
  });

  // 10 — search() never degrades (AC6)
  describe('search never degrades a transport failure into an answered zero (AC6)', () => {
    it('rejects on a network error', async () => {
      server.use(http.get(`${API_BASE}/api`, () => HttpResponse.error()));

      const outcome = await settle(adapter().search('kings'));

      expect(outcome.kind).toBe('rejected');
    });

    it('rejects on a non-200 response', async () => {
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(null, { status: 500 })));

      const outcome = await settle(adapter().search('kings'));

      expect(outcome.kind).toBe('rejected');
    });

    it('rejects with a ProxyError from the proxy path', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('connect ECONNREFUSED'),
      );

      const outcome = await settle(adapter({ proxyUrl: PROXY_URL }).search('kings'));

      expect(outcome.kind).toBe('rejected');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(ProxyError);
      fetchSpy.mockRestore();
    });

    it('rejects when the solver round-trip fails', async () => {
      server.use(http.post(SOLVER_ENDPOINT, () => HttpResponse.error()));

      const outcome = await settle(adapter({ flareSolverrUrl: SOLVER_URL }).search('kings'));

      expect(outcome.kind).toBe('rejected');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(Error);
      expect(String((outcome as { error: Error }).error.message)).toContain('FlareSolverr');
    });
  });

  describe('search rejects a solver slot-wait timeout rather than answering zero (AC6)', () => {
    const bound = useSolverBound(server);

    it('surfaces the slot wait as a ProxyError', async () => {
      const stub = bound.stub(SOLVER_ENDPOINT);
      await bound.saturate(stub, SOLVER_URL);

      const timer = bound.captureTimers();
      const searching = bound.track(adapter({ flareSolverrUrl: SOLVER_URL }).search('kings'));
      await bound.accountedFor(stub, timer, { arrived: bound.max, queued: 1 });
      expect(timer.pending()).toBe(1);
      timer.fire();

      const outcome = await settle(searching);

      expect(outcome.kind).toBe('rejected');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(ProxyError);
      expect(String((outcome as { error: Error }).error.message)).toMatch(/waiting for a request slot/);
    });
  });

  // 11 — test() success paths
  describe('test success paths', () => {
    it('names the caps server title', async () => {
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(CAPS_XML)));

      await expect(adapter().test()).resolves.toEqual({
        success: true,
        message: 'Connected to Shared Caps Indexer',
      });
    });

    it('names a nested caps server title', async () => {
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(CAPS_NESTED_XML)));

      const result = await adapter().test();

      expect(result.message).toBe('Connected to Nested Caps Indexer');
    });

    it('falls back to the adapter name when caps carries no server title', async () => {
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(CAPS_NO_SERVER_XML)));

      const result = await adapter({}, 'My Indexer').test();

      expect(result).toEqual({ success: true, message: 'Connected to My Indexer' });
    });
  });

  // 12 — test() failure paths
  describe('test failure paths', () => {
    it('reports an HTTP error verbatim and issues no probe when no solver is configured', async () => {
      const calls = routeFetch(() => undefined);
      routed = calls;
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(null, { status: 401 })));

      const result = await adapter().test();

      expect(result.success).toBe(false);
      expect(result.message).toContain('401');
      expect(calls.probes()).toEqual([]);
    });

    it('reports a network error verbatim and issues no probe when no solver is configured', async () => {
      const calls = routeFetch((url, method) =>
        (method === 'GET' && url.startsWith(`${API_BASE}/api`) ? codedRejection('ECONNREFUSED') : undefined));
      routed = calls;

      const result = await adapter().test();

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/^Connection refused on port /);
      expect(calls.probes()).toEqual([]);
    });
  });

  // 13 — solver vs proxy precedence
  describe('solver takes precedence over the standard proxy', () => {
    it('routes through the solver and never resolves the exit IP when both are set', async () => {
      server.use(
        http.post(SOLVER_ENDPOINT, () =>
          HttpResponse.json({ status: 'ok', solution: { response: CAPS_XML, status: 200 } })),
      );

      const result = await adapter({ flareSolverrUrl: SOLVER_URL, proxyUrl: PROXY_URL }).test();

      expect(result.success).toBe(true);
      expect(vi.mocked(resolveProxyIp)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchWithProxyAgent)).not.toHaveBeenCalled();
    });

    it('resolves the exit IP when only a standard proxy is configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(CAPS_XML, { status: 200, headers: { 'Content-Type': 'application/xml' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ip: '1.2.3.4' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const result = await adapter({ proxyUrl: PROXY_URL }).test();

      expect(result.ip).toBe('1.2.3.4');
      expect(vi.mocked(resolveProxyIp)).toHaveBeenCalledWith(PROXY_URL);
      fetchSpy.mockRestore();
    });

    it('touches no proxy machinery when neither is configured', async () => {
      server.use(http.get(`${API_BASE}/api`, () => new HttpResponse(CAPS_XML)));

      await adapter().test();

      expect(vi.mocked(resolveProxyIp)).not.toHaveBeenCalled();
      expect(vi.mocked(fetchWithProxyAgent)).toHaveBeenCalledWith(
        `${API_BASE}/api?t=caps&apikey=${API_KEY}`,
        expect.objectContaining({ proxyUrl: undefined }),
      );
    });
  });

  // 14 — solver failure diagnosis (#2374, AC7 + AC9)
  describe('solver failure diagnosis (#2374)', () => {
    function solverAdapter(): IndexerAdapter {
      // A display name that differs from the host, so a message built from `name` is visible.
      return adapter({ flareSolverrUrl: SOLVER_URL }, 'My Indexer');
    }

    it('names the target host from apiUrl when the site refuses connections', async () => {
      routed = routeFetch((url, method) => {
        if (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)) return abortRejection();
        if (method === 'HEAD' && url.includes(API_HOST)) return codedRejection('ECONNREFUSED');
        if (method === 'HEAD') return new Response(null, { status: 405 });
        return undefined;
      });

      const result = await solverAdapter().test();

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        `Target unreachable: ${API_HOST} refused the connection (ECONNREFUSED). Probed directly, not through the solver.`,
      );
      expect(result.message).not.toContain('My Indexer');
    });

    it('names the solver address when the solver itself refuses, and issues no probe', async () => {
      const calls = routeFetch((url, method) => (method === 'POST' && url.startsWith(SOLVER_ENDPOINT)
        ? codedRejection('ECONNREFUSED')
        : undefined));
      routed = calls;

      const result = await solverAdapter().test();

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

      const result = await solverAdapter().test();

      expect(result.message).toMatch(/^No page came back\./);
      expect(calls.probes().map((call) => call.url)).toEqual([API_BASE]);
      expect(calls.probes().some((call) => call.url.includes('apikey'))).toBe(false);
    });

    it('keeps a non-solver failure verbatim when no solver is configured (AC7)', async () => {
      routed = routeFetch((url) => (url.includes(API_HOST) ? codedRejection('ECONNREFUSED') : undefined));

      const result = await adapter().test();

      expect(result.message).toMatch(/^Connection refused on port /);
    });
  });

  // 15 — AbortSignal threading
  describe('AbortSignal threading', () => {
    it('forwards the caller signal on the direct path', async () => {
      let capturedSignal: AbortSignal | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(rss(ITEM_FULL), { headers: { 'Content-Type': 'application/rss+xml' } });
      });

      const controller = new AbortController();
      await adapter().search('kings', { signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
      fetchSpy.mockRestore();
    });

    it('forwards the caller signal on the proxied path', async () => {
      let capturedSignal: AbortSignal | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return new Response(rss(ITEM_FULL), { headers: { 'Content-Type': 'application/rss+xml' } });
      });

      const controller = new AbortController();
      await adapter({ proxyUrl: PROXY_URL }).search('kings', { signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
      fetchSpy.mockRestore();
    });

    it('forwards the caller signal on the solver path', async () => {
      let capturedSignal: AbortSignal | undefined;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return Response.json({ status: 'ok', solution: { response: rss(ITEM_FULL), status: 200 } });
      });

      const controller = new AbortController();
      await adapter({ flareSolverrUrl: SOLVER_URL }).search('kings', { signal: controller.signal });

      expect(capturedSignal).toBeDefined();
      controller.abort();
      expect(capturedSignal!.aborted).toBe(true);
      fetchSpy.mockRestore();
    });
  });
});
