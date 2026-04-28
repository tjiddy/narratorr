import { describe, expect, it } from 'vitest';
import { base32ToHex } from './base32.js';

// Top-level capture — guards against the import-cycle regression that hoisting
// previously masked: capturing `base32ToHex` at module scope must yield a function,
// not undefined.
const capturedAtTopLevel = base32ToHex;

describe('base32ToHex', () => {
  it('is defined when captured at module top level', () => {
    expect(typeof capturedAtTopLevel).toBe('function');
  });

  it('converts base32-encoded hash to hex', () => {
    // AAAA = 20 bits = 5 hex digits: 00000
    const result = base32ToHex('AAAA');
    expect(result).toBe('00000');
  });

  it('handles uppercase and lowercase base32 input', () => {
    const upper = base32ToHex('JBSWY3DP');
    const lower = base32ToHex('jbswy3dp');
    expect(upper).toBe(lower);
  });
});
