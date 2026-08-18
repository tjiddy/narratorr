import { describe, it, expect } from 'vitest';
import { buildAbbQuery } from './abb-query.js';

/** Apostrophe-free, already trimmed and single-spaced — the domain where identity holds (AC4). */
const IDENTITY_CORPUS = [
  'Brandon Sanderson',
  'A Dragon Guide to Retirement Julia Huni',
  'J K Rowling',
  '11 22 63 Stephen King',
  'Dune',
  'the way of kings',
];

describe('buildAbbQuery', () => {
  describe('the fold', () => {
    // The prod receipt: this exact string is what the manual probe grabbed on (#2422).
    it('drops the apostrophe-bearing word from the live failing query', () => {
      expect(buildAbbQuery("A Dragon Rider's Guide to Retirement Julia Huni"))
        .toBe('A Dragon Guide to Retirement Julia Huni');
    });

    it('folds a curly apostrophe (U+2019) to the same output as the straight form', () => {
      expect(buildAbbQuery('A Dragon Rider’s Guide to Retirement Julia Huni'))
        .toBe('A Dragon Guide to Retirement Julia Huni');
    });

    it('folds an opening curly apostrophe (U+2018) to the same output as the straight form', () => {
      expect(buildAbbQuery('A Dragon Rider‘s Guide to Retirement Julia Huni'))
        .toBe('A Dragon Guide to Retirement Julia Huni');
    });

    it('drops a medial apostrophe token', () => {
      expect(buildAbbQuery("A Dragon Rider's Guide Julia Huni")).toBe('A Dragon Guide Julia Huni');
    });

    it('drops a trailing apostrophe token', () => {
      expect(buildAbbQuery("The Riders' Guide Julia Huni")).toBe('The Guide Julia Huni');
    });

    it('drops a leading apostrophe token, and the whole word it belongs to', () => {
      expect(buildAbbQuery("'Salem's Lot Stephen King")).toBe('Lot Stephen King');
    });

    it('drops every apostrophe-bearing token when a query carries more than one', () => {
      expect(buildAbbQuery("Rider's Guide to Ocean's Deep Julia Huni"))
        .toBe('Guide to Deep Julia Huni');
    });
  });

  describe('identity anchor (AC4) — the non-regression guarantee', () => {
    it.each(IDENTITY_CORPUS)(
      'returns a trimmed, single-spaced, apostrophe-free query byte-identical: %s',
      (query) => {
        expect(buildAbbQuery(query)).toBe(query);
      },
    );
  });

  describe('whitespace normalization beats identity outside that domain (AC4)', () => {
    it('trims leading and trailing whitespace rather than returning verbatim', () => {
      expect(buildAbbQuery(' Dune Messiah ')).toBe('Dune Messiah');
    });

    it('collapses repeated interior whitespace rather than returning verbatim', () => {
      expect(buildAbbQuery('Dune  Messiah')).toBe('Dune Messiah');
    });
  });

  describe('degenerate guard (AC5) — the threshold is exclusive', () => {
    it('falls back when exactly one meaningful token survives', () => {
      expect(buildAbbQuery("The Hitchhiker's")).toBe('The Hitchhikers');
    });

    it('folds when exactly two meaningful tokens survive', () => {
      expect(buildAbbQuery("Ocean's Eleven Soderbergh")).toBe('Eleven Soderbergh');
    });

    it('falls back when no token survives at all', () => {
      expect(buildAbbQuery("It's")).toBe('Its');
    });

    it('deletes the apostrophe in the fallback rather than substituting a space', () => {
      expect(buildAbbQuery("The Hitchhiker's").split(' ')).toEqual(['The', 'Hitchhikers']);
    });

    it('folds a curly apostrophe to U+0027 before deleting it in the fallback', () => {
      expect(buildAbbQuery('It’s')).toBe('Its');
    });

    it('trims and single-spaces the fallback too', () => {
      expect(buildAbbQuery("  It's  ")).toBe('Its');
    });
  });

  describe('stopwords count for the guard but are never removed (AC6)', () => {
    it('falls back when every survivor is a stopword', () => {
      expect(buildAbbQuery("Rider's of the")).toBe('Riders of the');
    });

    it('keeps stopwords in the emitted query — the receipt that worked kept them', () => {
      const folded = buildAbbQuery("A Dragon Rider's Guide to Retirement Julia Huni");
      expect(folded.split(' ')).toContain('A');
      expect(folded.split(' ')).toContain('to');
    });

    it.each(['The', 'THE', 'the'])('counts %s as a stopword regardless of case', (article) => {
      expect(buildAbbQuery(`${article} Hitchhiker's`)).toBe(`${article} Hitchhikers`);
    });

    it('counts a non-stopword survivor even when it shares a case-folded prefix with one', () => {
      expect(buildAbbQuery("Their Rider's Guide")).toBe('Their Guide');
    });
  });

  describe('empty input (AC7)', () => {
    it('returns an empty string for an empty query without throwing', () => {
      expect(buildAbbQuery('')).toBe('');
    });

    it('returns an empty string for a whitespace-only query without throwing', () => {
      expect(buildAbbQuery('   ')).toBe('');
    });
  });

  describe('idempotence', () => {
    it.each([
      ...IDENTITY_CORPUS,
      "A Dragon Rider's Guide to Retirement Julia Huni",
      "'Salem's Lot Stephen King",
      "The Hitchhiker's",
      "It's",
      ' Dune Messiah ',
      '',
    ])('is a fixed point after one application: %s', (query) => {
      const once = buildAbbQuery(query);
      expect(buildAbbQuery(once)).toBe(once);
    });
  });
});
