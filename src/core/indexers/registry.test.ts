import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMswServer } from '../__tests__/msw/server.js';
import { routeFetch } from '../__tests__/solver-routes.js';
import { ADAPTER_FACTORIES } from './registry.js';
import { createIndexerSchema, indexerTypeSchema, type IndexerSettings } from '@shared/schemas/indexer.js';

const MAM_BASE = 'https://www.myanonamouse.net';

describe('Indexer ADAPTER_FACTORIES', () => {
  const server = useMswServer();
  const types = indexerTypeSchema.options;

  describe('invariants', () => {
    it('has a factory for every indexer type in the Zod enum', () => {
      for (const type of types) {
        expect(ADAPTER_FACTORIES[type], `Missing factory for type: ${type}`).toBeTypeOf('function');
      }
    });

    it('each factory returns an object satisfying the IndexerAdapter interface', () => {
      const configs: Record<string, IndexerSettings> = {
        abb: { hostname: 'test.com', pageLimit: 2 },
        torznab: { apiUrl: 'https://test.com', apiKey: 'key' },
        newznab: { apiUrl: 'https://test.com', apiKey: 'key' },
        myanonamouse: { mamId: 'test-id' },
      };
      for (const type of types) {
        const adapter = ADAPTER_FACTORIES[type](configs[type]!, 'TestIndexer');
        expect(adapter).toHaveProperty('type');
        expect(adapter).toHaveProperty('name');
        expect(adapter.search).toBeTypeOf('function');
        expect(adapter.test).toBeTypeOf('function');
      }
    });
  });

  describe('factory config extraction', () => {
    it('abb factory creates adapter with hostname and pageLimit', () => {
      const adapter = ADAPTER_FACTORIES.abb({ hostname: 'myabb.com', pageLimit: 5 }, 'ABB');
      expect(adapter.type).toBe('abb');
    });

    it('newznab factory creates adapter with apiUrl and apiKey', () => {
      const adapter = ADAPTER_FACTORIES.newznab({ apiUrl: 'https://nzb.test', apiKey: 'abc' }, 'NZB');
      expect(adapter.type).toBe('newznab');
      expect(adapter.name).toBe('NZB');
    });

    it('torznab factory creates adapter with apiUrl and apiKey', () => {
      const adapter = ADAPTER_FACTORIES.torznab({ apiUrl: 'https://torz.test', apiKey: 'xyz' }, 'Torz');
      expect(adapter.type).toBe('torznab');
      expect(adapter.name).toBe('Torz');
    });

    it('myanonamouse factory creates adapter with mamId', () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-mam-id' }, 'MAM');
      expect(adapter.type).toBe('myanonamouse');
      expect(adapter.name).toBe('MAM');
    });

    it('normalizes empty flareSolverrUrl string to undefined', () => {
      const adapter = ADAPTER_FACTORIES.abb({ hostname: 'test.com', pageLimit: 2, flareSolverrUrl: '' }, 'ABB');
      expect(adapter.type).toBe('abb');
    });
  });

  describe('myanonamouse factory — searchLanguages and searchType (#291)', () => {
    function captureSearchUrl(capturedUrl: { value: string }) {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl.value = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
    }

    it('forwards explicit searchLanguages and searchType to adapter search params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1, 36], searchType: 'fl' }, 'MAM',
      );
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[browse_lang][0]')).toBe('1');
      expect(url.searchParams.get('tor[browse_lang][1]')).toBe('36');
      expect(url.searchParams.get('tor[searchType]')).toBe('fl');
    });

    it('defaults missing searchLanguages to [1] (English) in search params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[browse_lang][0]')).toBe('1');
      expect(url.searchParams.getAll('tor[browse_lang][1]')).toHaveLength(0);
    });

    it('defaults missing searchType to "active" in search params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[searchType]')).toBe('active');
    });

    it('preserves searchType: "all" — sends "all" not default "active"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchType: 'all', searchLanguages: [1] }, 'MAM',
      );
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[searchType]')).toBe('all');
    });

    it('preserves searchLanguages: [] (empty) — sends no browse_lang params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [], searchType: 'active' }, 'MAM',
      );
      await adapter.search('test');

      const url = new URL(captured.value);
      const allParams = Array.from(url.searchParams.keys());
      const browseLangParams = allParams.filter(k => k.startsWith('tor[browse_lang]'));
      expect(browseLangParams).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown indexer type (no factory)', () => {
      expect((ADAPTER_FACTORIES as Record<string, unknown>)['unknown']).toBeUndefined();
    });
  });

  describe('#363 — searchType string coercion and isVip forwarding', () => {
    function captureSearchUrl(capturedUrl: { value: string }) {
      server.use(
        http.get(`${MAM_BASE}/tor/js/loadSearchJSONbasic.php`, ({ request }) => {
          capturedUrl.value = request.url;
          return HttpResponse.json({ data: [] });
        }),
      );
    }

    it('forwards string searchType to adapter (no coercion needed)', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 'fl' }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('fl');
    });

    it('coerces legacy integer searchType 0 to "all"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 0 as never }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('coerces legacy integer searchType 1 to "active"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 1 as never }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('active');
    });

    it('coerces legacy integer searchType 2 to "fl"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 2 as never }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('fl');
    });

    it('coerces legacy integer searchType 3 to "fl-VIP"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 3 as never }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('fl-VIP');
    });

    it('coerces unknown legacy integer (4) to "active" (fallback)', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 4 as never }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('active');
    });

    it('defaults missing searchType to "active"', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('active');
    });

    it('forwards isVip: false from settings — adapter emits tor[searchType]=nVIP', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 'active', isVip: false }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('nVIP');
    });

    it('forwards isVip: true from settings — adapter emits tor[searchType]=all', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 'fl', isVip: true }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('all');
    });

    it('forwards isVip: undefined from settings — adapter uses saved searchType', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1], searchType: 'VIP' }, 'MAM',
      );
      await adapter.search('test');
      expect(new URL(captured.value).searchParams.get('tor[searchType]')).toBe('VIP');
    });
  });

  describe('myanonamouse factory — wedge fields (#1156)', () => {
    function captureDownload() {
      const captured: { url: string } = { url: '' };
      server.use(
        http.get(`${MAM_BASE}/tor/download.php`, ({ request }) => {
          captured.url = request.url;
          return new HttpResponse(Buffer.from('t'), { headers: { 'Content-Type': 'application/x-bittorrent' } });
        }),
      );
      return captured;
    }

    it('forwards useFreeleechWedge=preferred to adapter — appends &fl when not already freeleech', async () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', useFreeleechWedge: 'preferred' }, 'MAM',
      );
      const captured = captureDownload();
      const result = await adapter.resolveDownloadUrl!({ guid: '1', downloadUrl: 'mam-torrent://1', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeRequested).toBe(true);
      expect(captured.url).toMatch(/[?&]fl(?:&|$)/);
    });

    it('forwards useFreeleechWedge=preferred to adapter — skips &fl when already freeleech', async () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', useFreeleechWedge: 'preferred' }, 'MAM',
      );
      const captured = captureDownload();
      const result = await adapter.resolveDownloadUrl!({ guid: '1', downloadUrl: 'mam-torrent://1', protocol: 'torrent', isFreeleech: true });
      expect(result.wedgeRequested).toBe(false);
      expect(captured.url).not.toContain('fl');
    });

    it('forwards useFreeleechWedge=never to adapter — never appends &fl', async () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', useFreeleechWedge: 'never' }, 'MAM',
      );
      const captured = captureDownload();
      const result = await adapter.resolveDownloadUrl!({ guid: '1', downloadUrl: 'mam-torrent://1', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeRequested).toBe(false);
      expect(captured.url).not.toContain('fl');
    });

    it('defaults useFreeleechWedge to "never" when missing from settings', async () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      const captured = captureDownload();
      const result = await adapter.resolveDownloadUrl!({ guid: '1', downloadUrl: 'mam-torrent://1', protocol: 'torrent', isFreeleech: false });
      expect(result.wedgeRequested).toBe(false);
      expect(captured.url).not.toContain('fl');
    });
  });
  /**
   * #2392 — the doubled scheme this issue is named for, observed where it actually shows: the URL
   * the adapter requests. `baseUrl` is private, so the factory + a mocked transport is the seam.
   */
  describe('#2392 abb factory composes exactly one scheme', () => {
    const ABB_HOST = 'audiobookbay.test';

    async function requestUrlFor(hostname: string): Promise<string> {
      server.use(
        http.get(`https://${ABB_HOST}/`, () => new HttpResponse('<html><body></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        })),
      );
      const adapter = ADAPTER_FACTORIES.abb({ hostname, pageLimit: 1 }, 'ABB');
      const response = await adapter.search('brandon sanderson');
      expect(response.requestUrl).toBeDefined();
      return response.requestUrl!;
    }

    it('requests https://<host>/ from settings a pasted URL was normalized into', async () => {
      const parsed = createIndexerSchema.parse({
        name: 'ABB', type: 'abb', enabled: true, priority: 50,
        settings: { hostname: `https://${ABB_HOST}`, pageLimit: 1 },
      });
      expect(parsed.settings.hostname).toBe(ABB_HOST);

      const requestUrl = await requestUrlFor(parsed.settings.hostname as string);

      expect(requestUrl.startsWith(`https://${ABB_HOST}/`)).toBe(true);
      expect(requestUrl.match(/https:\/\//g)).toHaveLength(1);
    });

    it('an unnormalized pasted URL is what produced the doubled scheme — the failure being fixed', async () => {
      const routed = routeFetch(() => new Response('<html><body></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      }));
      try {
        const adapter = ADAPTER_FACTORIES.abb({ hostname: `https://${ABB_HOST}`, pageLimit: 1 }, 'ABB');
        await adapter.search('brandon sanderson');

        expect(routed.calls[0]?.url.startsWith('https://https://')).toBe(true);
      } finally {
        routed.restore();
      }
    });
  });
});

/**
 * #2391 case 19 — the caps-family adapters now share one implementation, so this drives each factory
 * end to end against its own fixture feed. The registry bodies are unchanged; what this pins is that
 * the shared base still reaches the wire with each adapter's own profile and protocol.
 */
describe('caps-family factories — registry to wire (#2391)', () => {
  const server = useMswServer();
  const fixturesDir = resolve(import.meta.dirname, '../__tests__/fixtures');

  const CASES = [
    {
      type: 'torznab' as const,
      apiUrl: 'https://tracker.test',
      fixture: 'torznab-search.xml',
      protocol: 'torrent',
      attrsParam: 'grabs,language',
    },
    {
      type: 'newznab' as const,
      apiUrl: 'https://indexer.test',
      fixture: 'newznab-search.xml',
      protocol: 'usenet',
      attrsParam: 'grabs,language,group,files',
    },
  ];

  it.each(CASES)('$type reaches the wire with its own profile and returns $protocol results', async (testCase) => {
    const xml = readFileSync(resolve(fixturesDir, testCase.fixture), 'utf-8');
    let capturedUrl = '';
    server.use(
      http.get(`${testCase.apiUrl}/api`, ({ request }) => {
        capturedUrl = request.url;
        return new HttpResponse(xml, { headers: { 'Content-Type': 'application/rss+xml' } });
      }),
    );

    const adapter = ADAPTER_FACTORIES[testCase.type](
      { apiUrl: testCase.apiUrl, apiKey: 'realkey' },
      'Operator Name',
    );
    const { results, parseStats } = await adapter.search('Brandon Sanderson', { limit: 50 });

    expect(new URL(capturedUrl).searchParams.get('attrs')).toBe(testCase.attrsParam);
    expect(parseStats.itemsObserved).toBe(3);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.protocol).toBe(testCase.protocol);
      expect(result.indexer).toBe('Operator Name');
      expect(result.downloadUrl).toBeTruthy();
      expect(result.title).toContain('Brandon Sanderson');
    }
    expect(results[0]!.size).toBe(1073741824);
    expect(results[0]!.grabs).toBe(42);
  });
});
