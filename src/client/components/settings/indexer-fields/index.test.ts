import { describe, it, expect } from 'vitest';
import { INDEXER_FIELD_COMPONENTS } from './index.js';
import { INDEXER_TYPES } from '../../../../shared/indexer-registry.js';

describe('INDEXER_FIELD_COMPONENTS', () => {
  it('has a field component for every INDEXER_TYPES entry', () => {
    for (const type of INDEXER_TYPES) {
      expect(INDEXER_FIELD_COMPONENTS[type], `Missing field component for indexer type: ${type}`).toBeDefined();
      expect(INDEXER_FIELD_COMPONENTS[type]).toBeTypeOf('function');
    }
  });

  it('returns undefined for type not in the registry', () => {
    expect(INDEXER_FIELD_COMPONENTS['nonexistent']).toBeUndefined();
  });
});
