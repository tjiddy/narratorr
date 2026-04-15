import { describe, it, expect } from 'vitest';
import { IMPORT_LIST_ADAPTER_FACTORIES } from './registry.js';
import { importListTypeSchema, type ImportListSettings } from '../../shared/schemas/import-list.js';

describe('Import List IMPORT_LIST_ADAPTER_FACTORIES', () => {
  const types = importListTypeSchema.options;

  const configs: Record<string, ImportListSettings> = {
    abs: { serverUrl: 'http://abs.local', apiKey: 'key', libraryId: 'lib1' },
    nyt: { apiKey: 'nytkey' },
    hardcover: { apiKey: 'hckey' },
  };

  describe('invariants', () => {
    it('has a factory for every import list type in the Zod enum', () => {
      for (const type of types) {
        expect(IMPORT_LIST_ADAPTER_FACTORIES[type], `Missing factory for type: ${type}`).toBeTypeOf('function');
      }
    });

    it('each factory returns an object satisfying the ImportListProvider interface', () => {
      for (const type of types) {
        const provider = IMPORT_LIST_ADAPTER_FACTORIES[type](configs[type]);
        expect(provider).toHaveProperty('type');
        expect(provider).toHaveProperty('name');
        expect(provider.fetchItems).toBeTypeOf('function');
        expect(provider.test).toBeTypeOf('function');
      }
    });
  });

  describe('error handling', () => {
    it('returns undefined for unknown import list type (no factory)', () => {
      expect((IMPORT_LIST_ADAPTER_FACTORIES as Record<string, unknown>)['unknown']).toBeUndefined();
    });
  });
});
