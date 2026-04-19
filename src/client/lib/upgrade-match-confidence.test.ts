import { describe, it, expect } from 'vitest';
import { upgradeMatchConfidence } from './upgrade-match-confidence.js';
import type { MatchResult } from './api/library-scan.js';
import type { BookMetadata } from './api/books.js';

const baseMatchResult = (overrides?: Partial<MatchResult>): MatchResult => ({
  path: '/library/book',
  confidence: 'none',
  bestMatch: null,
  alternatives: [],
  ...overrides,
});

const baseMetadata = (overrides?: Partial<BookMetadata>): BookMetadata => ({
  title: 'Test Book',
  authors: [{ name: 'Author' }],
  ...overrides,
});

describe('upgradeMatchConfidence', () => {
  describe('none → medium', () => {
    it('upgrades confidence from none to medium when newMetadata is provided', () => {
      const matchResult = baseMatchResult({ confidence: 'none' });
      const newMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, undefined);

      expect(result?.confidence).toBe('medium');
    });

    it('upgrades from none to medium even when newMetadata is the same reference as currentEditedMetadata', () => {
      const matchResult = baseMatchResult({ confidence: 'none' });
      const sharedMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, sharedMetadata, sharedMetadata);

      expect(result?.confidence).toBe('medium');
    });

    it('preserves the reason field when upgrading from none to medium', () => {
      const matchResult = baseMatchResult({ confidence: 'none', reason: 'duration-mismatch' });
      const newMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, undefined);

      expect(result?.reason).toBe('duration-mismatch');
    });
  });

  describe('medium → high', () => {
    it('upgrades from medium to high when newMetadata is a different reference than currentEditedMetadata', () => {
      const matchResult = baseMatchResult({ confidence: 'medium' });
      const previousMetadata = baseMetadata();
      const newMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, previousMetadata);

      expect(result?.confidence).toBe('high');
    });

    it('upgrades from medium to high on reference change even when field values are identical', () => {
      const matchResult = baseMatchResult({ confidence: 'medium' });
      const previousMetadata = baseMetadata({ title: 'Same Book', asin: 'B001' });
      const newMetadata = baseMetadata({ title: 'Same Book', asin: 'B001' });

      const result = upgradeMatchConfidence(matchResult, newMetadata, previousMetadata);

      expect(previousMetadata).not.toBe(newMetadata);
      expect(result?.confidence).toBe('high');
    });

    it('clears the reason field when upgrading from medium to high', () => {
      const matchResult = baseMatchResult({ confidence: 'medium', reason: 'duration-mismatch' });
      const previousMetadata = baseMetadata();
      const newMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, previousMetadata);

      expect(result?.reason).toBeUndefined();
    });
  });

  describe('no upgrade', () => {
    it('stays at medium when newMetadata is the same reference as currentEditedMetadata', () => {
      const matchResult = baseMatchResult({ confidence: 'medium', reason: 'duration-mismatch' });
      const sharedMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, sharedMetadata, sharedMetadata);

      expect(result).toBe(matchResult);
    });

    it('stays at high regardless of newMetadata', () => {
      const matchResult = baseMatchResult({ confidence: 'high' });
      const newMetadata = baseMetadata();
      const previousMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, previousMetadata);

      expect(result).toBe(matchResult);
    });
  });

  describe('null/undefined guards', () => {
    it('returns undefined when matchResult is undefined', () => {
      const result = upgradeMatchConfidence(undefined, baseMetadata(), undefined);

      expect(result).toBeUndefined();
    });

    it('returns the original matchResult unchanged when newMetadata is undefined', () => {
      const matchResult = baseMatchResult({ confidence: 'none' });

      const result = upgradeMatchConfidence(matchResult, undefined, baseMetadata());

      expect(result).toBe(matchResult);
    });
  });
});
