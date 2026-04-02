import { describe, it, expect } from 'vitest';
import { ADAPTER_FACTORIES } from './registry.js';
import { indexerTypeSchema } from '../../shared/schemas/indexer.js';

describe('Indexer ADAPTER_FACTORIES', () => {
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
    it('creates adapter when searchLanguages and searchType are provided', () => {
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [1, 36], searchType: 2 }, 'MAM',
      );
      expect(adapter.type).toBe('myanonamouse');
      expect(adapter.name).toBe('MAM');
    });

    it('creates adapter with defaults when searchLanguages is missing/undefined', () => {
      // Should not throw — factory applies default [1]
      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      expect(adapter.type).toBe('myanonamouse');
    });

    it('creates adapter with defaults when searchType is missing/undefined', () => {
      // Should not throw — factory applies default 1
      const adapter = ADAPTER_FACTORIES.myanonamouse({ mamId: 'test-id' }, 'MAM');
      expect(adapter.type).toBe('myanonamouse');
    });

    it('preserves searchType: 0 (falsy but valid — uses ?? not ||)', () => {
      // searchType: 0 means "all torrents" — must not be replaced with default 1
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchType: 0, searchLanguages: [1] }, 'MAM',
      );
      expect(adapter.type).toBe('myanonamouse');
    });

    it('preserves searchLanguages: [] (empty but intentional — uses ?? not ||)', () => {
      // Empty array means "all languages" — must not be replaced with default [1]
      const adapter = ADAPTER_FACTORIES.myanonamouse(
        { mamId: 'test-id', searchLanguages: [], searchType: 1 }, 'MAM',
      );
      expect(adapter.type).toBe('myanonamouse');
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown indexer type (no factory)', () => {
      expect(ADAPTER_FACTORIES['unknown']).toBeUndefined();
    });
  });
});
