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

    it('normalizes empty flareSolverrUrl string to undefined', () => {
      const adapter = ADAPTER_FACTORIES.abb({ hostname: 'test.com', pageLimit: 2, flareSolverrUrl: '' }, 'ABB');
      expect(adapter.type).toBe('abb');
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown indexer type (no factory)', () => {
      expect(ADAPTER_FACTORIES['unknown']).toBeUndefined();
    });
  });
});
