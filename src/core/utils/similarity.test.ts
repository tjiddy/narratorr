import { describe, it, expect } from 'vitest';
import { diceCoefficient, scoreResult, tokenizeNarrators, normalizeNarrator, narratorsFuzzyMatch, NARRATOR_MATCH_THRESHOLD } from './similarity.js';

describe('diceCoefficient', () => {
  it('returns 1.0 for identical strings', () => {
    expect(diceCoefficient('hello', 'hello')).toBe(1);
  });

  it('returns 1.0 for identical strings regardless of case', () => {
    expect(diceCoefficient('Hello World', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(diceCoefficient('abc', 'xyz')).toBe(0);
  });

  it('returns 0 for empty strings', () => {
    expect(diceCoefficient('', '')).toBe(0);
    expect(diceCoefficient('hello', '')).toBe(0);
    expect(diceCoefficient('', 'hello')).toBe(0);
  });

  it('returns 0 for single character strings', () => {
    expect(diceCoefficient('a', 'a')).toBe(0);
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  it('returns partial score for substring matches', () => {
    const score = diceCoefficient('night', 'nightly');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('handles real author name variations', () => {
    // Same author, different ordering
    const score = diceCoefficient('Brandon Sanderson', 'Sanderson, Brandon');
    expect(score).toBeGreaterThan(0.5);
  });

  it('scores similar titles higher than dissimilar ones', () => {
    const similar = diceCoefficient('The Way of Kings', 'Way of Kings');
    const dissimilar = diceCoefficient('The Way of Kings', 'Mistborn');
    expect(similar).toBeGreaterThan(dissimilar);
  });

  it('handles whitespace trimming', () => {
    expect(diceCoefficient('  hello  ', 'hello')).toBe(1);
  });
});

describe('scoreResult', () => {
  it('returns 1.0 for exact title and author match', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(1);
  });

  it('weights title at 0.6 and author at 0.4', () => {
    // Perfect title, no author match
    const titleOnly = scoreResult(
      { title: 'The Way of Kings', author: 'Wrong Author' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Perfect author, no title match
    const authorOnly = scoreResult(
      { title: 'Wrong Title xxxxxxxxx', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Title match should contribute more
    expect(titleOnly).toBeGreaterThan(authorOnly);
  });

  it('uses full weight on title when no author context provided', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      { title: 'The Way of Kings' },
    );
    expect(score).toBe(1);
  });

  it('uses full weight on title when result has no author', () => {
    const score = scoreResult(
      { title: 'The Way of Kings' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(1);
  });

  it('returns 0 when title and author are completely different', () => {
    const score = scoreResult(
      { title: 'xyz abc', author: 'xyz abc' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    expect(score).toBe(0);
  });

  it('returns 0 when no context is provided', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
      {},
    );
    expect(score).toBe(0);
  });

  it('scores real-world variation: "Sanderson, Brandon" vs "Brandon Sanderson"', () => {
    const score = scoreResult(
      { title: 'The Way of Kings', author: 'Sanderson, Brandon' },
      { title: 'The Way of Kings', author: 'Brandon Sanderson' },
    );
    // Should still be a strong match despite name ordering
    expect(score).toBeGreaterThan(0.7);
  });
});

describe('tokenizeNarrators', () => {
  it('splits on comma delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree, Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('splits on semicolon delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree; Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('splits on ampersand delimiter', () => {
    expect(tokenizeNarrators('Travis Baldree & Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('drops empty tokens from consecutive delimiters', () => {
    expect(tokenizeNarrators('Travis Baldree,, Jeff Hays')).toEqual(['Travis Baldree', 'Jeff Hays']);
  });

  it('drops whitespace-only tokens', () => {
    expect(tokenizeNarrators('A, , B')).toEqual(['A', 'B']);
  });

  it('returns single token when no delimiter', () => {
    expect(tokenizeNarrators('Single Narrator')).toEqual(['Single Narrator']);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeNarrators('')).toEqual([]);
  });
});

describe('normalizeNarrator', () => {
  it('strips periods and lowercases', () => {
    expect(normalizeNarrator('Kevin R. Free')).toBe('kevin r free');
  });

  it('lowercases without stripping when no punctuation', () => {
    expect(normalizeNarrator('Kevin R Free')).toBe('kevin r free');
  });

  it('trims and collapses whitespace', () => {
    expect(normalizeNarrator('  John   Smith  ')).toBe('john smith');
  });

  it('strips apostrophes', () => {
    expect(normalizeNarrator("O'Brien")).toBe('obrien');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeNarrator('')).toBe('');
  });

  it('returns single character unchanged except lowercase', () => {
    expect(normalizeNarrator('A')).toBe('a');
  });

  it('does NOT strip commas, semicolons, or ampersands', () => {
    // These are delimiters handled by tokenizeNarrators, not normalization
    expect(normalizeNarrator('a,b')).toBe('a,b');
    expect(normalizeNarrator('a;b')).toBe('a;b');
    expect(normalizeNarrator('a&b')).toBe('a&b');
  });
});

describe('narratorsFuzzyMatch (#1650)', () => {
  it('exposes the 0.8 default threshold as the single source of truth', () => {
    expect(NARRATOR_MATCH_THRESHOLD).toBe(0.8);
  });

  it('returns true for a spelling variant at or above threshold (dice ≈ 0.875)', () => {
    expect(narratorsFuzzyMatch('Juliet Stevenson', ['Juliette Stevenson'])).toBe(true);
  });

  it('returns true when normalization collapses punctuation noise (Ray Porter / Ray. Porter)', () => {
    expect(narratorsFuzzyMatch('Ray Porter', ['Ray. Porter'])).toBe(true);
  });

  it('returns false for a bare-surname variant below threshold (dice ≈ 0.706)', () => {
    // Documents the design contract: no phonetic/alias layer — Stevenson/Stephenson
    // scores below 0.8 and is (correctly) treated as a mismatch.
    expect(narratorsFuzzyMatch('Stevenson', ['Stephenson'])).toBe(false);
  });

  it('returns false for distinct narrators (wrong-edition headline)', () => {
    expect(narratorsFuzzyMatch('Adriel Brandt', ['Michael York'])).toBe(false);
  });

  it('set-overlap: any file token matching any edition narrator satisfies the match', () => {
    expect(narratorsFuzzyMatch('Ethan Hawke', ['James Franco', 'Ethan Hawke'])).toBe(true);
    expect(narratorsFuzzyMatch('Ethan Hawke', ['James Franco', 'Tatiana Maslany'])).toBe(false);
  });

  it('splits a multi-value file narrator string on delimiters', () => {
    expect(narratorsFuzzyMatch('Ethan Hawke, James Franco', ['James Franco'])).toBe(true);
  });

  it('returns false when the file narrator has no signal', () => {
    expect(narratorsFuzzyMatch(undefined, ['Michael York'])).toBe(false);
    expect(narratorsFuzzyMatch('', ['Michael York'])).toBe(false);
    expect(narratorsFuzzyMatch('   ', ['Michael York'])).toBe(false);
  });

  it('returns false when the edition has no narrators', () => {
    expect(narratorsFuzzyMatch('Adriel Brandt', undefined)).toBe(false);
    expect(narratorsFuzzyMatch('Adriel Brandt', [])).toBe(false);
    expect(narratorsFuzzyMatch('Adriel Brandt', ['   '])).toBe(false);
  });

  it('honors a caller-supplied threshold override', () => {
    // Stevenson/Stephenson scores ≈ 0.706 — clears a relaxed 0.7 bar.
    expect(narratorsFuzzyMatch('Stevenson', ['Stephenson'], 0.7)).toBe(true);
  });
});
