import { describe, it, expect } from 'vitest';
import { NOTIFIER_FIELD_COMPONENTS } from './index.js';
import { NOTIFIER_TYPES } from '../../../../shared/notifier-registry.js';

describe('NOTIFIER_FIELD_COMPONENTS', () => {
  it('has a field component for every NOTIFIER_TYPES entry', () => {
    for (const type of NOTIFIER_TYPES) {
      expect(NOTIFIER_FIELD_COMPONENTS[type], `Missing field component for notifier type: ${type}`).toBeDefined();
      expect(NOTIFIER_FIELD_COMPONENTS[type]).toBeTypeOf('function');
    }
  });

  it('returns undefined for type not in the registry', () => {
    expect(NOTIFIER_FIELD_COMPONENTS['nonexistent']).toBeUndefined();
  });
});
