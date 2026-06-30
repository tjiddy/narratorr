import { describe, it, expect } from 'vitest';
import { normalizeProductionType } from './production-type.js';
import { PRODUCTION_TYPES } from '../../shared/schemas/book.js';

describe('normalizeProductionType (#1710)', () => {
  it('maps unabridged (any case / whitespace) → unabridged', () => {
    expect(normalizeProductionType('unabridged')).toBe('unabridged');
    expect(normalizeProductionType('Unabridged')).toBe('unabridged');
    expect(normalizeProductionType(' UNABRIDGED ')).toBe('unabridged');
  });

  it('maps abridged → abridged', () => {
    expect(normalizeProductionType('abridged')).toBe('abridged');
    expect(normalizeProductionType('Abridged')).toBe('abridged');
  });

  it('folds undefined / null / empty / unknown values → unknown (Audnexus-absent case)', () => {
    expect(normalizeProductionType(undefined)).toBe('unknown');
    expect(normalizeProductionType(null)).toBe('unknown');
    expect(normalizeProductionType('')).toBe('unknown');
    expect(normalizeProductionType('   ')).toBe('unknown');
    expect(normalizeProductionType('whatever')).toBe('unknown');
  });

  it('never produces the reserved values, though they are valid enum members', () => {
    // Reserved for stories 2/3 — no provider field surfaces them today, so the
    // helper cannot emit them even when handed the literal string.
    for (const reserved of ['full_cast', 'dramatized', 'graphic_audio'] as const) {
      expect(PRODUCTION_TYPES).toContain(reserved);
      expect(normalizeProductionType(reserved)).toBe('unknown');
    }
  });
});
