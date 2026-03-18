import { describe, it, expect } from 'vitest';
import { enrichmentStatusSchema } from './book.js';

describe('enrichmentStatusSchema', () => {
  it.each(['pending', 'enriched', 'failed', 'skipped', 'file-enriched'] as const)(
    'accepts valid value: %s',
    (value) => {
      expect(enrichmentStatusSchema.parse(value)).toBe(value);
    },
  );

  it('rejects invalid value', () => {
    expect(() => enrichmentStatusSchema.parse('invalid')).toThrow();
  });
});
