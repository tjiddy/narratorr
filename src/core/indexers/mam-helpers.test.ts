import { describe, it, expect } from 'vitest';
import { parseMamSize } from './mam-helpers.js';

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const TIB = 1024 * 1024 * 1024 * 1024;

describe('parseMamSize — thousands separators (#2316)', () => {
  it('parses the reported regression "1,008.8 MiB" as its full byte count', () => {
    expect(parseMamSize('1,008.8 MiB')).toBe(1057803469);
  });

  // The pair that pins the bug: one byte-string either side of the separator threshold.
  it.each([
    ['999.5 MiB', 1048051712],
    ['1,000 MiB', 1000 * MIB],
  ])('parses %s either side of the separator threshold as %i bytes', (raw, expected) => {
    expect(parseMamSize(raw)).toBe(expected);
  });

  it('parses the top of the reachable band "1,023.9 MiB"', () => {
    expect(parseMamSize('1,023.9 MiB')).toBe(1073636966);
  });

  it('parses multiple separators, so the fix is not a single-comma special case', () => {
    expect(parseMamSize('1,234,567 KiB')).toBe(1234567 * KIB);
  });

  it('leaves a value above the band ("1.1 GiB") untouched', () => {
    expect(parseMamSize('1.1 GiB')).toBe(1181116006);
  });

  it('parses a grouped value with surrounding whitespace', () => {
    expect(parseMamSize(' 1,008.8 MiB ')).toBe(1057803469);
  });
});

describe('parseMamSize — malformed grouping is absent, never rescaled', () => {
  // A decimal comma stripped unconditionally would read "1,5 GiB" as 15 GiB — tenfold wrong.
  it.each([
    ['1,5 GiB'],
    ['1,08 MiB'],
    ['1,0088 MiB'],
    ['12,34,567 KiB'],
    ['1,234, MiB'],
  ])('returns undefined for %s rather than a rescaled number', (raw) => {
    expect(parseMamSize(raw)).toBeUndefined();
  });

  it('does not read "1,5 GiB" as 15 GiB', () => {
    expect(parseMamSize('1,5 GiB')).not.toBe(15 * GIB);
  });
});

describe('parseMamSize — malformed input fails open (absent, not zero)', () => {
  it.each([
    ['1,008.8 QB'],
    ['abc MiB'],
    ['MiB'],
    [''],
    ['1,008.8'],
    ['0 MiB'],
    ['0,000 MiB'],
  ])('returns undefined for %s', (raw) => {
    expect(parseMamSize(raw)).toBeUndefined();
  });
});

describe('parseMamSize — comma-free inputs are unchanged', () => {
  it.each([
    ['512 KiB', 512 * KIB],
    ['512 MiB', 512 * MIB],
    ['1.5 TiB', 1.5 * TIB],
    ['1 mib', MIB],
    ['1 GIB', GIB],
  ])('parses %s as %i bytes', (raw, expected) => {
    expect(parseMamSize(raw)).toBe(expected);
  });

  // Loose values today's bare parseFloat accepts. Not this bug; both fail open at the size
  // gates either way. An implementation that validates every token instead of only the
  // comma branch turns these into undefined — which is what these two cases catch.
  it.each([
    ['-5 MiB', -5 * MIB],
    ['1.5abc MiB', 1.5 * MIB],
  ])('keeps the current loose value for %s', (raw, expected) => {
    expect(parseMamSize(raw)).toBe(expected);
  });
});

describe('parseMamSize — numeric and absent input', () => {
  it('passes a numeric size through unchanged', () => {
    expect(parseMamSize(1073741824)).toBe(1073741824);
  });

  it('returns undefined for numeric zero', () => {
    expect(parseMamSize(0)).toBeUndefined();
  });

  it('returns undefined for absent input', () => {
    expect(parseMamSize(undefined)).toBeUndefined();
  });
});
