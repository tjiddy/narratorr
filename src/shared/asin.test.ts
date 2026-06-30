import { describe, it, expect } from 'vitest';
import { canonicalizeAsin } from './asin.js';

describe('canonicalizeAsin (#1733)', () => {
  it('uppercases a lowercase ASIN', () => {
    expect(canonicalizeAsin('b003p2wo5e')).toBe('B003P2WO5E');
  });

  it('leaves an already-canonical ASIN unchanged', () => {
    expect(canonicalizeAsin('B003P2WO5E')).toBe('B003P2WO5E');
  });

  it('trims surrounding whitespace before uppercasing', () => {
    expect(canonicalizeAsin('  b003p2wo5e  ')).toBe('B003P2WO5E');
  });

  it('folds null to null', () => {
    expect(canonicalizeAsin(null)).toBeNull();
  });

  it('folds undefined to null', () => {
    expect(canonicalizeAsin(undefined)).toBeNull();
  });

  it('folds empty / whitespace-only to null', () => {
    expect(canonicalizeAsin('')).toBeNull();
    expect(canonicalizeAsin('   ')).toBeNull();
  });
});
