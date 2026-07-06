import { describe, expect, it } from 'vitest';
import { parseOptionalNumber } from './parse-attr.js';

describe('parseOptionalNumber', () => {
  it('parses a positive integer string', () => {
    expect(parseOptionalNumber('42')).toBe(42);
  });

  it('parses zero (falsy but valid; must not drop to undefined)', () => {
    expect(parseOptionalNumber('0')).toBe(0);
  });

  it('parses a negative integer string', () => {
    expect(parseOptionalNumber('-3')).toBe(-3);
  });

  it('maps non-numeric strings to undefined', () => {
    expect(parseOptionalNumber('abc')).toBeUndefined();
  });

  it('maps empty string to undefined (an empty attr is absent, not zero)', () => {
    expect(parseOptionalNumber('')).toBeUndefined();
  });

  it('maps whitespace-only string to undefined', () => {
    expect(parseOptionalNumber('   ')).toBeUndefined();
  });

  it('maps undefined to undefined', () => {
    expect(parseOptionalNumber(undefined)).toBeUndefined();
  });

  it('maps "Infinity" to undefined', () => {
    expect(parseOptionalNumber('Infinity')).toBeUndefined();
  });

  it('maps "-Infinity" to undefined', () => {
    expect(parseOptionalNumber('-Infinity')).toBeUndefined();
  });

  it('maps "1e999" (overflows to Infinity) to undefined', () => {
    expect(parseOptionalNumber('1e999')).toBeUndefined();
  });
});
