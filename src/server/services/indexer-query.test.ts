import { describe, it, expect } from 'vitest';
import type { SearchOptions } from '../../core/index.js';
import { cleanIndexerQuery, cleanIndexerSearchOptions } from './indexer-query.js';

describe('cleanIndexerQuery', () => {
  it('strips parens and inner colon, keeping inner words', () => {
    expect(cleanIndexerQuery('Blood Ties (World of Warcraft: Midnight)'))
      .toBe('Blood Ties World of Warcraft Midnight');
  });

  it('strips dots from spaced author initials', () => {
    expect(cleanIndexerQuery('M. O. Walsh')).toBe('M O Walsh');
  });

  it('strips colon subtitle separator', () => {
    expect(cleanIndexerQuery('Dune: Messiah')).toBe('Dune Messiah');
  });

  it('strips dots from numeric titles (indexers tokenize dots themselves)', () => {
    expect(cleanIndexerQuery('11.22.63')).toBe('11 22 63');
  });

  it('passes already-clean input through unchanged (idempotency)', () => {
    expect(cleanIndexerQuery('Mistborn Brandon Sanderson'))
      .toBe('Mistborn Brandon Sanderson');
  });

  it('cleaning is idempotent — applying twice yields the same result', () => {
    const once = cleanIndexerQuery('Blood Ties (World of Warcraft: Midnight)');
    expect(cleanIndexerQuery(once)).toBe(once);
  });

  it('returns empty string for parens-only input', () => {
    expect(cleanIndexerQuery('()')).toBe('');
  });

  it('returns empty string for dots-only input', () => {
    expect(cleanIndexerQuery('...')).toBe('');
  });

  it('returns empty string for colons-only input', () => {
    expect(cleanIndexerQuery(':::')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanIndexerQuery('   ')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(cleanIndexerQuery('')).toBe('');
  });

  it('strips brackets, keeping inner words', () => {
    expect(cleanIndexerQuery('Mistborn [Audible Studios]'))
      .toBe('Mistborn Audible Studios');
  });

  it('strips braces, keeping inner words', () => {
    expect(cleanIndexerQuery('Mistborn {Box Set}'))
      .toBe('Mistborn Box Set');
  });

  it('strips semicolons', () => {
    expect(cleanIndexerQuery('Dune; Messiah')).toBe('Dune Messiah');
  });

  it('strips commas', () => {
    expect(cleanIndexerQuery('Foundation, Robot Series, Book 0'))
      .toBe('Foundation Robot Series Book 0');
  });

  it('collapses whitespace introduced by stripped punctuation', () => {
    expect(cleanIndexerQuery('Foo  (Bar)  Baz')).toBe('Foo Bar Baz');
  });
});

describe('cleanIndexerSearchOptions', () => {
  it('returns undefined when options is undefined', () => {
    expect(cleanIndexerSearchOptions(undefined)).toBeUndefined();
  });

  it('cleans both title and author', () => {
    const result = cleanIndexerSearchOptions({
      title: 'Dune: Messiah',
      author: 'M. O. Walsh',
    });
    expect(result).toEqual({ title: 'Dune Messiah', author: 'M O Walsh' });
  });

  it('cleans title only when author is absent', () => {
    const result = cleanIndexerSearchOptions({ title: 'Dune: Messiah' });
    expect(result).toEqual({ title: 'Dune Messiah' });
    expect(result?.author).toBeUndefined();
  });

  it('cleans author only when title is absent', () => {
    const result = cleanIndexerSearchOptions({ author: 'M. O. Walsh' });
    expect(result).toEqual({ author: 'M O Walsh' });
    expect(result?.title).toBeUndefined();
  });

  it('preserves limit, languages, and signal untouched', () => {
    const signal = new AbortController().signal;
    const result = cleanIndexerSearchOptions({
      title: 'Dune: Messiah',
      limit: 50,
      languages: ['english', 'french'],
      signal,
    });
    expect(result?.title).toBe('Dune Messiah');
    expect(result?.limit).toBe(50);
    expect(result?.languages).toEqual(['english', 'french']);
    expect(result?.signal).toBe(signal);
  });

  it('returns a new object — does not mutate input', () => {
    const input: SearchOptions = { title: 'Dune: Messiah', author: 'M. O. Walsh' };
    const result = cleanIndexerSearchOptions(input);
    expect(result).not.toBe(input);
    expect(input.title).toBe('Dune: Messiah');
    expect(input.author).toBe('M. O. Walsh');
  });

  it('preserves an empty options object', () => {
    expect(cleanIndexerSearchOptions({})).toEqual({});
  });
});
