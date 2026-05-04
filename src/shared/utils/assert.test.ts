import { describe, expect, it } from 'vitest';
import { firstOrThrow, requireDefined } from './assert.js';

describe('firstOrThrow', () => {
  it('returns the first element of a populated array', () => {
    expect(firstOrThrow([1, 2, 3], 'msg')).toBe(1);
  });

  it('throws with the supplied message when the array is empty', () => {
    expect(() => firstOrThrow([], 'expected ≥1 row from blacklist insert')).toThrow(
      'expected ≥1 row from blacklist insert',
    );
  });

  it('returns a single-element value (truthy)', () => {
    expect(firstOrThrow(['a'], 'msg')).toBe('a');
  });

  it('returns 0 (falsy but defined)', () => {
    expect(firstOrThrow([0], 'msg')).toBe(0);
  });

  it('throws when the first slot holds undefined (defensive: hole at index 0)', () => {
    expect(() => firstOrThrow([undefined as unknown as string], 'hole at 0')).toThrow('hole at 0');
  });
});

describe('requireDefined', () => {
  it('returns 0 (falsy but defined)', () => {
    expect(requireDefined(0, 'msg')).toBe(0);
  });

  it("returns '' (empty string is defined)", () => {
    expect(requireDefined('', 'msg')).toBe('');
  });

  it('returns false (falsy but defined)', () => {
    expect(requireDefined(false, 'msg')).toBe(false);
  });

  it('throws with the supplied message on undefined', () => {
    expect(() => requireDefined(undefined, 'undef msg')).toThrow('undef msg');
  });

  it('throws with the supplied message on null', () => {
    expect(() => requireDefined(null, 'null msg')).toThrow('null msg');
  });
});
