import { describe, it, expect } from 'vitest';
import { normalizeExternalId, externalIdRefusal } from './external-id.js';
import { DownloadClientError } from './errors.js';

/**
 * #2488 AC1 — the one place the blank/non-blank decision is ASSERTED rather than merely used.
 * Every adapter routes its id decision through `normalizeExternalId`, so this fence is what stops
 * a site quietly reverting to a bare truthiness check that a whitespace-only id clears.
 */
describe('normalizeExternalId (#2488)', () => {
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['tab', '\t'],
    ['newline', '\n '],
    ['mixed whitespace', ' \t\n '],
  ])('refuses a %s id', (_label, blank) => {
    expect(normalizeExternalId(blank)).toBeUndefined();
  });

  /** The trap this module exists for: every whitespace-only id clears a bare truthiness guard. */
  it.each([['spaces', '   '], ['tab', '\t'], ['newline', '\n ']])(
    'refuses a %s id that a bare truthiness guard would let through',
    (_label, blank) => {
      expect(Boolean(blank)).toBe(true);
      expect(normalizeExternalId(blank)).toBeUndefined();
    },
  );

  it.each([
    ['a hash', 'abc123def456', 'abc123def456'],
    ['a padded hash', '  abc123def456  ', 'abc123def456'],
    ['a single character', 'a', 'a'],
    ['a zero', '0', '0'],
    // Blankness alone is the rule — shape validation is a different change (#2485 kept 'a' live).
    ['non-blank garbage', '12abc', '12abc'],
  ])('passes %s through trimmed', (_label, input, expected) => {
    expect(normalizeExternalId(input)).toBe(expected);
  });

  it('does not lowercase or otherwise rewrite the surviving value', () => {
    expect(normalizeExternalId('  AbC123  ')).toBe('AbC123');
  });
});

describe('externalIdRefusal (#2488)', () => {
  it('names the blankness and the field so an operator can repair the record', () => {
    const error = externalIdRefusal('Transmission');

    expect(error).toBeInstanceOf(DownloadClientError);
    expect(error.clientName).toBe('Transmission');
    expect(error.message).toMatch(/blank/i);
    expect(error.message).toMatch(/external id/i);
  });

  it('keeps both markers when a client supplies its own stricter requirement', () => {
    const error = externalIdRefusal('NZBGet', 'it is blank or is not a non-negative integer NZBID');

    expect(error.message).toMatch(/blank/i);
    expect(error.message).toMatch(/external id/i);
    expect(error.message).toContain('non-negative integer NZBID');
  });
});
