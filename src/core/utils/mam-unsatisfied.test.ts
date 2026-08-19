import { describe, it, expect } from 'vitest';
import { readUnsatisfiedStatus, isAtUnsatisfiedLimit, isResultAtUnsatisfiedLimit } from './mam-unsatisfied.js';

describe('readUnsatisfiedStatus', () => {
  it('reads the documented snatch_summary pair', () => {
    expect(readUnsatisfiedStatus({ count: 139, limit: 150, size: 73954762929, red: false }))
      .toEqual({ count: 139, limit: 150 });
  });

  it('reads a fresh account at zero without treating 0 as missing', () => {
    expect(readUnsatisfiedStatus({ count: 0, limit: 150 })).toEqual({ count: 0, limit: 150 });
  });

  describe('degenerate shapes read as absent (fail open)', () => {
    const cases: Array<{ name: string; raw: unknown }> = [
      { name: 'undefined', raw: undefined },
      { name: 'null', raw: null },
      { name: 'a string', raw: '139/150' },
      { name: 'a number', raw: 139 },
      { name: 'an array', raw: [139, 150] },
      { name: 'limit absent', raw: { count: 5 } },
      { name: 'count absent', raw: { limit: 150 } },
      { name: 'limit zero', raw: { count: 0, limit: 0 } },
      { name: 'limit negative', raw: { count: 5, limit: -1 } },
      { name: 'limit null', raw: { count: 5, limit: null } },
      { name: 'count null', raw: { count: null, limit: 150 } },
      { name: 'count negative', raw: { count: -1, limit: 150 } },
      { name: 'count NaN', raw: { count: Number.NaN, limit: 150 } },
      { name: 'limit NaN', raw: { count: 5, limit: Number.NaN } },
      { name: 'count Infinity', raw: { count: Number.POSITIVE_INFINITY, limit: 150 } },
      { name: 'count fractional', raw: { count: 1.5, limit: 150 } },
      { name: 'limit fractional', raw: { count: 5, limit: 150.5 } },
      { name: 'count a numeric string', raw: { count: '139', limit: '150' } },
    ];

    for (const { name, raw } of cases) {
      it(`returns null when ${name}`, () => {
        expect(readUnsatisfiedStatus(raw)).toBeNull();
      });
    }
  });
});

describe('isAtUnsatisfiedLimit', () => {
  it('is false one below the limit', () => {
    expect(isAtUnsatisfiedLimit({ count: 149, limit: 150 })).toBe(false);
  });

  it('is true exactly at the limit', () => {
    expect(isAtUnsatisfiedLimit({ count: 150, limit: 150 })).toBe(true);
  });

  it('is true past the limit', () => {
    expect(isAtUnsatisfiedLimit({ count: 151, limit: 150 })).toBe(true);
  });

  it('is false for a fresh account', () => {
    expect(isAtUnsatisfiedLimit({ count: 0, limit: 150 })).toBe(false);
  });

  it('is false when nothing was observed', () => {
    expect(isAtUnsatisfiedLimit(undefined)).toBe(false);
    expect(isAtUnsatisfiedLimit(null)).toBe(false);
  });

  it('uses the reported limit rather than a hardcoded 150', () => {
    expect(isAtUnsatisfiedLimit({ count: 40, limit: 40 })).toBe(true);
    expect(isAtUnsatisfiedLimit({ count: 160, limit: 400 })).toBe(false);
  });
});

describe('isResultAtUnsatisfiedLimit', () => {
  it('blocks a result carrying an at-limit pair', () => {
    expect(isResultAtUnsatisfiedLimit({ unsatisfied: { count: 150, limit: 150 } })).toBe(true);
  });

  it('never blocks a result carrying nothing', () => {
    expect(isResultAtUnsatisfiedLimit({})).toBe(false);
  });

  it('never blocks a result carrying a below-limit pair', () => {
    expect(isResultAtUnsatisfiedLimit({ unsatisfied: { count: 149, limit: 150 } })).toBe(false);
  });
});
