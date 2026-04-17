import { describe, it, expect, beforeEach } from 'vitest';
import { registerImportAdapter, getImportAdapter, clearImportAdapters } from './registry.js';
import type { ImportAdapter } from './types.js';

function createStubAdapter(type: 'manual' | 'auto'): ImportAdapter {
  return { type, process: async () => {} };
}

describe('ImportAdapterRegistry', () => {
  beforeEach(() => {
    clearImportAdapters();
  });

  describe('registerImportAdapter', () => {
    it('registers an adapter and allows lookup by type', () => {
      const adapter = createStubAdapter('manual');
      registerImportAdapter(adapter);
      expect(getImportAdapter('manual')).toBe(adapter);
    });

    it('throws an error when registering a duplicate type', () => {
      registerImportAdapter(createStubAdapter('manual'));
      expect(() => registerImportAdapter(createStubAdapter('manual')))
        .toThrow('Import adapter already registered for type "manual"');
    });

    it('returns undefined for an unregistered type', () => {
      expect(getImportAdapter('auto')).toBeUndefined();
    });

    it('allows multiple adapters to coexist (manual + auto)', () => {
      const manual = createStubAdapter('manual');
      const auto = createStubAdapter('auto');
      registerImportAdapter(manual);
      registerImportAdapter(auto);
      expect(getImportAdapter('manual')).toBe(manual);
      expect(getImportAdapter('auto')).toBe(auto);
    });
  });
});
