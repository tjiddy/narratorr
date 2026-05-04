import { describe, it, expect, vi } from 'vitest';
import { importListTypeSchema, type ImportListSettings } from '../../shared/schemas/import-list.js';

function makeMockProvider() {
  return { type: 'mock', name: 'Mock', fetchItems: vi.fn(), test: vi.fn() };
}

vi.mock('./nyt-provider.js', () => ({
  NytProvider: vi.fn(function (this: Record<string, unknown>) {
    return Object.assign(this, makeMockProvider());
  }),
}));

vi.mock('./hardcover-provider.js', () => ({
  HardcoverProvider: vi.fn(function (this: Record<string, unknown>) {
    return Object.assign(this, makeMockProvider());
  }),
}));

vi.mock('./abs-provider.js', () => ({
  AbsProvider: vi.fn(function (this: Record<string, unknown>) {
    return Object.assign(this, makeMockProvider());
  }),
}));

import { IMPORT_LIST_ADAPTER_FACTORIES } from './registry.js';
import { NytProvider } from './nyt-provider.js';
import { HardcoverProvider } from './hardcover-provider.js';

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
        const provider = IMPORT_LIST_ADAPTER_FACTORIES[type](configs[type]!);
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

  describe('factory fallback/coercion branches', () => {
    it('nyt factory uses audio-fiction default when list is empty string', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.nyt({ apiKey: 'key', list: '' });
      expect(NytProvider).toHaveBeenCalledWith({ apiKey: 'key', list: 'audio-fiction' });
    });

    it('nyt factory passes through explicit list value', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.nyt({ apiKey: 'key', list: 'audio-nonfiction' });
      expect(NytProvider).toHaveBeenCalledWith({ apiKey: 'key', list: 'audio-nonfiction' });
    });

    it('hardcover factory uses trending default when listType is undefined', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.hardcover({ apiKey: 'key', listType: undefined, shelfId: undefined });
      expect(HardcoverProvider).toHaveBeenCalledWith({ apiKey: 'key', listType: 'trending', shelfId: undefined });
    });

    it('hardcover factory passes through explicit shelf listType with numeric shelfId', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.hardcover({ apiKey: 'key', listType: 'shelf', shelfId: 123 });
      expect(HardcoverProvider).toHaveBeenCalledWith({ apiKey: 'key', listType: 'shelf', shelfId: 123 });
    });

    it('hardcover factory omits shelfId when undefined', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.hardcover({ apiKey: 'key', listType: 'trending', shelfId: undefined });
      // Producer-omit pattern: undefined shelfId is dropped from the
      // constructor payload, not passed through as explicit undefined
      // (eopt invariant per #939 AC4).
      const ctorArg = vi.mocked(HardcoverProvider).mock.calls[0][0];
      expect(ctorArg).not.toHaveProperty('shelfId');
    });

    it('hardcover factory passes through explicit numeric shelfId', () => {
      IMPORT_LIST_ADAPTER_FACTORIES.hardcover({ apiKey: 'key', listType: 'shelf', shelfId: 42 });
      expect(HardcoverProvider).toHaveBeenCalledWith(
        expect.objectContaining({ shelfId: 42 }),
      );
    });
  });
});
