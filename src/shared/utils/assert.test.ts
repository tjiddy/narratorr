import { describe, expect, it } from 'vitest';
import { requireDefined } from './assert.js';

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
