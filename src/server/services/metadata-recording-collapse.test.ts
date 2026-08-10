import { describe, expect, it } from 'vitest';
import type { BookMetadata } from '@core/index.js';
import { selectCanonicalRecording, usefulArray, usefulString } from './metadata-recording-collapse.js';

/**
 * The selector is pure over ANY candidate array — the eligibility gate lives in the caller. That
 * wider domain is what makes the AC9a exclusions observable: inputs the collapse gate would refuse
 * still reach this function directly, so a field wrongly added to the richness list shows up here.
 */
describe('selectCanonicalRecording (#2219)', () => {
  function listing(asin: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return {
      title: 'Bear Head',
      authors: [{ name: 'Adrian Tchaikovsky' }],
      asin,
      duration: 777,
      narrators: ['Sophie Aldred', 'Mark Elstob', 'Ben Allen'],
      ...overrides,
    };
  }

  describe('AC9.1 — the requested ASIN', () => {
    it('the member matching the input ASIN wins over a richer peer and over the smaller ASIN', () => {
      const richer = listing('B_AAA', { coverUrl: 'https://example.com/a.jpg', description: 'Blurb' });
      const requested = listing('B_ZZZ');

      expect(selectCanonicalRecording([richer, requested], 'B_ZZZ')).toBe(requested);
    });

    it('the comparison canonicalizes both sides, so a case-drifted and padded input ASIN still names it', () => {
      const other = listing('B_AAA');
      const requested = listing('  b_zzz  ');

      expect(selectCanonicalRecording([other, requested], ' b_ZzZ ')).toBe(requested);
    });

    it('an input ASIN that canonicalizes to null is ignored, and ranking proceeds', () => {
      const richer = listing('B_ZZZ', { publisher: 'Tor' });
      const plain = listing('B_AAA');

      expect(selectCanonicalRecording([richer, plain], '   ')).toBe(richer);
      expect(selectCanonicalRecording([richer, plain], undefined)).toBe(richer);
    });

    it('an input ASIN absent from the set is ignored, and ranking proceeds', () => {
      const richer = listing('B_ZZZ', { publisher: 'Tor' });
      const plain = listing('B_AAA');

      expect(selectCanonicalRecording([richer, plain], 'B_ELSEWHERE')).toBe(richer);
    });
  });

  describe('AC9a — fields deliberately excluded from the richness list', () => {
    // Every member of a COLLAPSIBLE set carries narrator signal by construction, so this input is
    // unreachable through resolveBook. Asserting it here is the only observation point at which
    // restoring `narrators` to the fixed list is visible: `usefulArray` is binary, so two non-blank
    // arrays of different length score identically and would prove nothing.
    it('narrators are not a richness field: the narrator-less candidate still wins the ASIN tie-break', () => {
      const narratorBearing = listing('B_ZZZ', { narrators: ['Jim Dale'] });
      const narratorLess = listing('B_AAA', { narrators: [] });

      expect(selectCanonicalRecording([narratorBearing, narratorLess], undefined)).toBe(narratorLess);
    });

    it.each([
      ['duration', 'B_ZZZ', { duration: 777 }, 'B_AAA', { duration: undefined }],
      ['asin presence', 'B_ZZZ', {}, '', {}],
    ])('%s is not a richness field', (_label, richAsin, richShape, plainAsin, plainShape) => {
      const bearing = listing(richAsin, richShape);
      const lacking = listing(plainAsin, plainShape);

      expect(selectCanonicalRecording([bearing, lacking], undefined)).toBe(lacking);
    });
  });

  describe('AC9.4 — the total tie-break', () => {
    it('two equally rich candidates fall to the smallest canonical ASIN, from either input order', () => {
      const small = listing('B_AAA');
      const large = listing('B_ZZZ');

      expect(selectCanonicalRecording([small, large], undefined)).toBe(small);
      expect(selectCanonicalRecording([large, small], undefined)).toBe(small);
    });

    it('the tie-break canonicalizes, so case does not decide the order', () => {
      const small = listing('b_aaa');
      const large = listing('B_ZZZ');

      expect(selectCanonicalRecording([large, small], undefined)).toBe(small);
    });
  });

  describe('AC10 — no merge', () => {
    it('the winner is returned by reference, carrying none of its peer’s fields', () => {
      const winner = listing('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' });
      const loser = listing('B_AAA', { publisher: 'Tor' });

      const result = selectCanonicalRecording([winner, loser], undefined);

      expect(result).toBe(winner);
      expect(result).not.toHaveProperty('publisher');
      expect(result.genres).toBeUndefined();
    });
  });
});

describe('usefulString / usefulArray (#2219 AC9)', () => {
  it.each([
    ['a plain value', 'Tor', true],
    ['a value with surrounding whitespace', '  Tor  ', true],
    ['the empty string', '', false],
    ['a whitespace-only value', '   ', false],
    ['a tab-and-newline-only value', '\t\n', false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['a number', 7, false],
  ])('usefulString: %s', (_label, value, expected) => {
    expect(usefulString(value)).toBe(expected);
  });

  it.each([
    ['an array with one real entry', ['Fantasy'], true],
    ['an array mixing blanks and a real entry', ['   ', 'Fantasy'], true],
    ['an empty array', [], false],
    ['an array of blanks', ['   ', ''], false],
    ['undefined', undefined, false],
    ['a bare string', 'Fantasy', false],
  ])('usefulArray: %s', (_label, value, expected) => {
    expect(usefulArray(value)).toBe(expected);
  });
});
