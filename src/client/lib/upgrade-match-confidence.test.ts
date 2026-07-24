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

// The real UAT case: 14h53m of files (Δ300s vs a 14h58m edition, out of band). #1929.
const SCANNED_14H53M = 53580; // 14h 53m in seconds

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

  // #1929 — a medium row whose Review is duration EVIDENCE (duration-mismatch /
  // missing-duration) must re-check the picked edition against the scanned runtime
  // on an explicit re-pick, never blanket-clear to green.
  describe('medium re-pick — duration re-evaluation (#1929)', () => {
    it('duration-mismatch → re-pick to an in-band edition clears to high, drops reason+reasonKind, preserves scannedSeconds', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      // A DIFFERENT edition that fits: 894min (14h54m) → Δ60s, inside the 240s band.
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
        reason: 'Duration mismatch — scanned 14h 53m vs expected 20h 0m', // original row's numbers
        reasonKind: 'duration-mismatch',
        scannedSeconds: SCANNED_14H53M,
      });
      // Re-pick to 898min (14h58m) → Δ300s, still out of band.
      const newMetadata = baseMetadata({ duration: 898 });

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
      // Re-rendered against the PICKED edition's numbers, not the original row's.
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

    it('missing-duration → re-pick to an in-band edition clears to high', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 894 }); // 14h54m → Δ60s, in band

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect(result?.reasonKind).toBeUndefined();
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    // F8 — the distinct missing-duration → duration-mismatch transition: a positive,
    // out-of-band picked edition flips the kind and re-renders against its numbers.
    it('missing-duration → re-pick to a positive out-of-band edition flips to duration-mismatch with re-rendered reason', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Best match missing duration — cannot verify',
        reasonKind: 'missing-duration',
        scannedSeconds: SCANNED_14H53M,
      });
      const newMetadata = baseMetadata({ duration: 898 }); // 14h58m → Δ300s, out of band

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
      expect(result?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(result?.scannedSeconds).toBe(SCANNED_14H53M);
    });

    // F3 (defensive) — scanned runtime missing on an evidence-bearing row: blaming
    // the best match would be false, so the SCAN side gets the truthful string.
    it('duration-mismatch but scannedSeconds absent, picked HAS a duration → stays medium with the scanned-missing string', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
        reasonKind: 'duration-mismatch',
        // scannedSeconds intentionally absent (missing/corrupt transport)
      });
      const newMetadata = baseMetadata({ duration: 898 }); // positive duration

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

    // Boundary — the shared band is inclusive at 240s (#1850).
    it('Δ exactly 240s is within the band → high', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned x vs expected y',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 3600, // 60m
      });
      const newMetadata = baseMetadata({ duration: 64 }); // 64m → 3840s, Δ240s

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
    });

    it('Δ 241s is outside the band → stays Review', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned x vs expected y',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 3599, // Δ241s vs 3840s
      });
      const newMetadata = baseMetadata({ duration: 64 }); // 64m → 3840s

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('medium');
      expect(result?.reasonKind).toBe('duration-mismatch');
    });

    // Units guard — a missing `* 60` on the picked edition would compare 893 vs 53580
    // (a giant gap → medium); the correct minutes→seconds conversion lands in-band → high.
    it('applies the minutes→seconds conversion on the picked edition (893min in-band, not 60× too loose)', () => {
      const matchResult = baseMatchResult({
        confidence: 'medium',
        reason: 'Duration mismatch — scanned 14h 53m vs expected 20h 0m',
        reasonKind: 'duration-mismatch',
        scannedSeconds: 53580, // 14h53m — exactly 893min in seconds
      });
      const newMetadata = baseMetadata({ duration: 893 }); // 893min → 53580s, Δ0

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
        scannedSeconds: undefined,
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
      const newMetadata = baseMetadata({ duration: 700 }); // would be out of band, but no reasonKind → not re-evaluated

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result?.confidence).toBe('high');
      expect(result?.reason).toBeUndefined();
      expect(result?.reasonKind).toBeUndefined();
      expect(result?.scannedSeconds).toBe(3600);
    });
  });

  describe('scope + no-op contract (#1929)', () => {
    // F1 — high (already-Matched) rows are out of scope: an explicit re-pick never
    // demotes, in-band or out.
    it('high row + explicit re-pick (out of band) stays high, unchanged', () => {
      const matchResult = baseMatchResult({ confidence: 'high', scannedSeconds: 3600 });
      const newMetadata = baseMetadata({ duration: 700 }); // 42000s — wildly out of band

      const result = upgradeMatchConfidence(matchResult, newMetadata, baseMetadata());

      expect(result).toBe(matchResult);
    });

    it('high row + explicit re-pick (in band) stays high, unchanged', () => {
      const matchResult = baseMatchResult({ confidence: 'high', scannedSeconds: 3600 });
      const newMetadata = baseMetadata({ duration: 60 }); // in band, still no change

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
