import { describe, it, expect } from 'vitest';
import { canonicalizeAsin, isAudibleAsin } from './asin.js';

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

describe('isAudibleAsin (#2292)', () => {
  it('accepts the real ASINs the OPF rung has to survive', () => {
    // Dark Tower I, Fablehaven Book 2, The Book of Dust: The Rose Field.
    expect(isAudibleAsin('B019NNU7XE')).toBe(true);
    expect(isAudibleAsin('B00CXXELZM')).toBe(true);
    expect(isAudibleAsin('B0F452D4QT')).toBe(true);
  });

  it('canonicalizes before testing, so case and surrounding whitespace are accepted', () => {
    expect(isAudibleAsin('b019nnu7xe')).toBe(true);
    expect(isAudibleAsin('  B019NNU7XE  ')).toBe(true);
  });

  it('rejects an ISBN sitting in the OPF ASIN field', () => {
    // The Secret Commonwealth's sidecar carries this ISBN-10 under scheme="ASIN".
    expect(isAudibleAsin('0593105192')).toBe(false);
    expect(isAudibleAsin('9780593105191')).toBe(false);
  });

  it('rejects the wrong length in both directions', () => {
    expect(isAudibleAsin('B019NNU7X')).toBe(false);
    expect(isAudibleAsin('B019NNU7XE1')).toBe(false);
  });

  it('rejects a wrong leading letter and an illegal character', () => {
    expect(isAudibleAsin('A019NNU7XE')).toBe(false);
    expect(isAudibleAsin('B019NNU7X!')).toBe(false);
  });

  it('rejects an ASIN embedded in prose — the OPF field is a structured identifier', () => {
    expect(isAudibleAsin('see B019NNU7XE for details')).toBe(false);
  });

  it('rejects absent and blank values', () => {
    expect(isAudibleAsin('')).toBe(false);
    expect(isAudibleAsin('   ')).toBe(false);
    expect(isAudibleAsin(null)).toBe(false);
    expect(isAudibleAsin(undefined)).toBe(false);
  });
});
