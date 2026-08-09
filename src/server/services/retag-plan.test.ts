import { describe, it, expect } from 'vitest';
import { SIMPLE_EXCLUDABLE_FIELDS } from './retag-plan.js';
import { RETAG_EXCLUDABLE_FIELDS } from '@shared/schemas.js';

describe('retag-plan SIMPLE_EXCLUDABLE_FIELDS', () => {
  // Numeric seriesPart/track are special-cased; every other field must match the shared set.
  it('plus the special-cased seriesPart/track covers exactly the shared RETAG_EXCLUDABLE_FIELDS set', () => {
    expect(new Set([...SIMPLE_EXCLUDABLE_FIELDS, 'seriesPart', 'track'])).toEqual(
      new Set(RETAG_EXCLUDABLE_FIELDS),
    );
  });
});
