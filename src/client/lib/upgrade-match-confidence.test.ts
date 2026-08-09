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

// UAT case: a 14h53m scan is 300 seconds outside a 14h58m edition.
const SCANNED_14H53M = 53580;

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

  describe('medium re-pick — duration re-evaluation (#1929)', () => {
    it('duration-mismatch → re-pick to an in-band edition clears to high, drops reason+reasonKind, preserves scannedSeconds', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 894 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect(result?.reasonKind).toBeUndefined();
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('duration-mismatch → re-pick still out of band stays medium with the reason re-rendered against the PICKED edition', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 20h 0m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 898 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
      expect(result?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('missing-duration → re-pick to a duration-less edition stays medium with the best-match-missing string', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: undefined });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('missing-duration');
      expect(result?.reason).toBe('Best match missing duration — cannot verify');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('missing-duration → re-pick to an edition whose duration is 0 stays medium with the best-match-missing string', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 0 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('missing-duration');
      expect(result?.reason).toBe('Best match missing duration — cannot verify');
      expect(result?.reason).not.toContain('0h 0m');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('missing-duration → re-pick to an in-band edition clears to high', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 894 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect(result?.reasonKind).toBeUndefined();
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('missing-duration → re-pick to a positive out-of-band edition flips to duration-mismatch with re-rendered reason', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 898 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
      expect(result?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    it('duration-mismatch but scannedSeconds absent, picked HAS a duration → stays medium with the scanned-missing string', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
      });
      const newMetadata = baseMetadata({ duration: 898 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('missing-duration');
      expect(result?.reason).toBe('Scanned duration unavailable — cannot verify');
    });

    it('duration-mismatch with scannedSeconds === 0 also routes to the scanned-missing string', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 0h 0m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 0,
      });
      const newMetadata = baseMetadata({ duration: 898 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('missing-duration');
      expect(result?.reason).toBe('Scanned duration unavailable — cannot verify');
    });

    it('duration-mismatch with BOTH scannedSeconds and picked duration missing → scanner-side string (scanner-first precedence)', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
      });
      const newMetadata = baseMetadata({ duration: undefined });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('missing-duration');
      expect(result?.reason).toBe('Scanned duration unavailable — cannot verify');
    });

    it('Δ exactly 240s is within the band → high', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned x vs expected y',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 3600,
      });
      const newMetadata = baseMetadata({ duration: 64 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
    });

    it('Δ 241s is outside the band → stays Review', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned x vs expected y',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 3599,
      });
      const newMetadata = baseMetadata({ duration: 64 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
    });

    it('applies the minutes→seconds conversion on the picked edition (893min in-band, not 60× too loose)', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 20h 0m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 53580,
      });
      const newMetadata = baseMetadata({ duration: 893 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
    });
  });

  describe('medium re-pick — ambiguity/legacy classes clear to high (#1929)', () => {
    it('no-duration-data → explicit re-pick clears to high and removes BOTH reason and reasonKind', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Multiple results — no duration data to disambiguate',
        reasonKind: 'no-duration-data',
      });
      const newMetadata = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect('reasonKind' in (result ?? {})).toBe(false);
    });

    it('undefined reasonKind (attempt-cap / narrator-cap / legacy medium) → explicit re-pick clears to high, preserving scannedSeconds', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Low confidence match. Please verify.',
        scannedSeconds: 3600,
      });
      const newMetadata = baseMetadata({ duration: 700 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect(result?.reasonKind).toBeUndefined();
      expect(result?.scannedSeconds).toBe(3600);
    });
  });

  describe('scope + no-op contract (#1929)', () => {
    it('high row + explicit re-pick (out of band) stays high, unchanged', () => {
      const matchResult = baseMatchResult({ confidence: 'high', scannedSeconds: 3600 });
      const newMetadata = baseMetadata({ duration: 700 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result).toBe(matchResult);
    });

    it('high row + explicit re-pick (in band) stays high, unchanged', () => {
      const matchResult = baseMatchResult({ confidence: 'high', scannedSeconds: 3600 });
      const newMetadata = baseMetadata({ duration: 60 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result).toBe(matchResult);
    });

    it('by-reference no-op on a duration-mismatch row keeps confidence, reason and reasonKind', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      const shared = baseMetadata({ duration: 60 });

      const result = upgradeMatchConfidence(matchResult, shared, shared);

      expect(result).toBe(matchResult);
      expect(result?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(result?.reasonKind).toBe('duration-mismatch');
    });

    it('by-reference no-op on a missing-duration row keeps confidence, reason and reasonKind', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const shared = baseMetadata();

      const result = upgradeMatchConfidence(matchResult, shared, shared);

      expect(result).toBe(matchResult);
      expect(result?.reasonKind).toBe('missing-duration');
    });

    it('none → medium still upgrades and preserves reason + reasonKind', () => {
      const matchResult = baseMatchResult({
        confidence: 'none',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 894 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, undefined);

      expect(result?.confidence).toBe('medium');
      expect(result?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(result?.reasonKind).toBe('duration-mismatch');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });
  });
});
