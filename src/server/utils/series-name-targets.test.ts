import { describe, it, expect } from 'vitest';
import { buildSeriesNameTargets, seriesNameMatchesTargets } from './series-name-targets.js';

/**
 * The membership rule the series-card pool is loaded through (#2175). Pure, so
 * every equivalence-class and guard case is pinned here; the DB-facing halves
 * (one statement, no pool-derived parameters, id order) live in
 * `series-card.integration.test.ts`.
 */
describe('series name targets (#2175)', () => {
  describe('buildSeriesNameTargets', () => {
    it('collapses spellings of one equivalence class onto a single normalized entry', () => {
      const targets = buildSeriesNameTargets(['The Band', 'the band', '  The   Band ', 'the-band']);
      expect([...targets.normalized]).toEqual(['the band']);
      expect([...targets.exact]).toEqual([]);
    });

    it('routes an empty-normalizing name to the exact arm, deduped on the RAW string', () => {
      const targets = buildSeriesNameTargets(['Дозоры', 'Дозоры', '三体', '!!!', '']);
      expect([...targets.normalized]).toEqual([]);
      expect([...targets.exact]).toEqual(['Дозоры', '三体', '!!!', '']);
    });

    it('populates both arms when the name list mixes the two kinds', () => {
      const targets = buildSeriesNameTargets(['三体', 'The Band', 'THE BAND', '三体']);
      expect([...targets.normalized]).toEqual(['the band']);
      expect([...targets.exact]).toEqual(['三体']);
    });

    it('yields two empty arms for an empty name list', () => {
      const targets = buildSeriesNameTargets([]);
      expect(targets.normalized.size).toBe(0);
      expect(targets.exact.size).toBe(0);
    });
  });

  describe('seriesNameMatchesTargets — the normalized arm', () => {
    const targets = buildSeriesNameTargets(['The Band']);

    it.each([
      ['The Band', 'the exact spelling'],
      ['the band', 'case drift'],
      ['THE BAND', 'upper case'],
      ['  The   Band ', 'whitespace drift'],
      ['The_Band', 'punctuation drift'],
    ])('accepts %j (%s)', (spelling) => {
      expect(seriesNameMatchesTargets(targets, spelling)).toBe(true);
    });

    it.each([
      ['The Bands', 'a longer word'],
      ['Band', 'a missing word'],
      ['', 'the empty string'],
      ['三体', 'an empty-normalizing name'],
    ])('rejects %j (%s)', (spelling) => {
      expect(seriesNameMatchesTargets(targets, spelling)).toBe(false);
    });

    it('keeps a digit-separating space significant', () => {
      const digits = buildSeriesNameTargets(['Series 2']);
      expect(seriesNameMatchesTargets(digits, 'series  2')).toBe(true);
      expect(seriesNameMatchesTargets(digits, 'Series2')).toBe(false);
    });
  });

  describe('seriesNameMatchesTargets — the exact arm (AC5)', () => {
    it('matches only the byte-identical spelling of an empty-normalizing target', () => {
      const targets = buildSeriesNameTargets(['Дозоры']);
      expect(seriesNameMatchesTargets(targets, 'Дозоры')).toBe(true);
      expect(seriesNameMatchesTargets(targets, 'дозоры')).toBe(false);
      expect(seriesNameMatchesTargets(targets, '三体')).toBe(false);
      expect(seriesNameMatchesTargets(targets, '!!!')).toBe(false);
      expect(seriesNameMatchesTargets(targets, '')).toBe(false);
    });

    it('does not pool distinct non-Latin names together', () => {
      const targets = buildSeriesNameTargets(['三体', '!!!']);
      expect(seriesNameMatchesTargets(targets, '三体')).toBe(true);
      expect(seriesNameMatchesTargets(targets, '!!!')).toBe(true);
      expect(seriesNameMatchesTargets(targets, 'Дозоры')).toBe(false);
      expect(seriesNameMatchesTargets(targets, '')).toBe(false);
    });

    it('treats the empty string as its own bucket', () => {
      const targets = buildSeriesNameTargets(['']);
      expect(seriesNameMatchesTargets(targets, '')).toBe(true);
      expect(seriesNameMatchesTargets(targets, '三体')).toBe(false);
      expect(seriesNameMatchesTargets(targets, 'The Band')).toBe(false);
    });
  });

  describe('seriesNameMatchesTargets — the two arms are a union, never a mode', () => {
    const targets = buildSeriesNameTargets(['The Band', '三体']);

    it('accepts a member of either arm and nothing else', () => {
      expect(seriesNameMatchesTargets(targets, 'the  band')).toBe(true);
      expect(seriesNameMatchesTargets(targets, '三体')).toBe(true);
      expect(seriesNameMatchesTargets(targets, 'Дозоры')).toBe(false);
      expect(seriesNameMatchesTargets(targets, 'The Bands')).toBe(false);
    });

    it('never matches anything when both arms are empty', () => {
      const none = buildSeriesNameTargets([]);
      expect(seriesNameMatchesTargets(none, 'The Band')).toBe(false);
      expect(seriesNameMatchesTargets(none, '')).toBe(false);
    });
  });
});
