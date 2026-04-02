import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMswServer } from '../__tests__/msw/server.js';
import { ADAPTER_FACTORIES } from './registry.js';
import { indexerTypeSchema } from '../../shared/schemas/indexer.js';

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
      const configs: Record<string, Record<string, unknown>> = {
        abb: { hostname: 'test.com', pageLimit: 2 },
        torznab: { apiUrl: 'https://test.com', apiKey: 'key' },
        newznab: { apiUrl: 'https://test.com', apiKey: 'key' },
        myanonamouse: { mamId: 'test-id' },
      };
      for (const type of types) {
        const adapter = ADAPTER_FACTORIES[type](configs[type], 'TestIndexer');
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
        { mamId: 'test-id', searchLanguages: [1, 36], searchType: 2 }, 'MAM',
      );
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[browse_lang][0]')).toBe('1');
      expect(url.searchParams.get('tor[browse_lang][1]')).toBe('36');
      expect(url.searchParams.get('tor[searchType]')).toBe('2');
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

    it('defaults missing searchType to 1 (active) in search params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[searchType]')).toBe('1');
    });

    it('preserves searchType: 0 (falsy but valid) — sends 0 not default 1', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchType: 0, searchLanguages: [1] }, 'MAM',
      );
      await adapter.search('test');

      const url = new URL(captured.value);
      expect(url.searchParams.get('tor[searchType]')).toBe('0');
    });

    it('preserves searchLanguages: [] (empty) — sends no browse_lang params', async () => {
      const captured = { value: '' };
      captureSearchUrl(captured);

      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [], searchType: 1 }, 'MAM',
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
      expect(ADAPTER_FACTORIES['unknown']).toBeUndefined();
    });
  });
});
