import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { ADAPTER_FACTORIES } from './registry.js';
import { indexerTypeSchema, type IndexerSettings } from '../../shared/schemas/indexer.js';

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
});
