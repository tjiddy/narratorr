import { describe, expect, it } from 'vitest';
import { matchesRejectWord, parseWordList } from './parse-word-list.js';

describe('parseWordList', () => {
  it('returns empty array for undefined input', () => {
    expect(parseWordList(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseWordList('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(parseWordList('   ')).toEqual([]);
  });

  it('returns single word trimmed and lowercased', () => {
    expect(parseWordList('Horror')).toEqual(['horror']);
  });

  it('splits comma-separated words, trims and lowercases', () => {
    expect(parseWordList('horror, sci-fi, fantasy')).toEqual(['horror', 'sci-fi', 'fantasy']);
  });

  it('filters out empty entries from leading/trailing commas', () => {
    expect(parseWordList(',word,')).toEqual(['word']);
  });

  it('preserves duplicates (no dedup)', () => {
    expect(parseWordList('word,word')).toEqual(['word', 'word']);
  });

  it('lowercases mixed-case words', () => {
    expect(parseWordList('Word,WORD,word')).toEqual(['word', 'word', 'word']);
  });
});

describe('matchesRejectWord', () => {
  describe('word-boundary semantics', () => {
    it('matches when word is delimited by dots', () => {
      expect(matchesRejectWord('Sample.Audiobook.MP3', 'Sample')).toBe(true);
    });

    it('does not match inside a longer word (suffix)', () => {
      expect(matchesRejectWord('Sampleyana', 'Sample')).toBe(false);
    });

    it('matches when word is delimited by spaces on both sides', () => {
      expect(matchesRejectWord('Foo Sample Bar', 'Sample')).toBe(true);
    });

    it('does not match when there is no leading boundary (CamelCase prefix)', () => {
      expect(matchesRejectWord('FooSample', 'Sample')).toBe(false);
    });

    it('does not match when there is no trailing boundary (CamelCase suffix)', () => {
      expect(matchesRejectWord('SampleFoo', 'Sample')).toBe(false);
    });

    it('does not match "abridged" inside "unabridged" (canonical collision case)', () => {
      expect(matchesRejectWord('unabridged', 'abridged')).toBe(false);
    });

    it('does not match "Abridged" inside dotted "Unabridged"', () => {
      expect(matchesRejectWord('Dune.Unabridged.M4B', 'Abridged')).toBe(false);
    });
  });

  describe('case-insensitivity', () => {
    it('matches uppercase surface against lowercase word', () => {
      expect(matchesRejectWord('SAMPLE CHAPTERS', 'sample')).toBe(true);
    });

    it('matches lowercase surface against uppercase word', () => {
      expect(matchesRejectWord('sample chapters', 'SAMPLE')).toBe(true);
    });
  });

  describe('multi-word phrases', () => {
    it('matches multi-word phrase at start of surface', () => {
      expect(matchesRejectWord('Behind the Scenes Featurette', 'Behind the Scenes')).toBe(true);
    });

    it('matches multi-word phrase later in surface', () => {
      expect(matchesRejectWord('Right Behind the Scenes', 'Behind the Scenes')).toBe(true);
    });

    it('does not match multi-word phrase against CamelCase concatenation', () => {
      expect(matchesRejectWord('BehindTheScenes', 'Behind the Scenes')).toBe(false);
    });
  });

  describe('empty / edge inputs', () => {
    it('returns false for empty word (short-circuit, avoids \\b\\b regex)', () => {
      expect(matchesRejectWord('foo', '')).toBe(false);
    });

    it('returns false for empty surface', () => {
      expect(matchesRejectWord('', 'foo')).toBe(false);
    });

    it('returns false when both inputs are empty', () => {
      expect(matchesRejectWord('', '')).toBe(false);
    });
  });

  describe('regex-escape coverage', () => {
    it.each([
      ['parens', 'foo a(b)c bar', 'a(b)c', true],
      ['brackets', 'foo a[b]c bar', 'a[b]c', true],
      ['literal dot', 'a.b', 'a.b', true],
      ['literal dot does not match arbitrary char', 'axb', 'a.b', false],
      ['plus', 'foo+bar', 'foo+bar', true],
      ['asterisk', 'foo a*b bar', 'a*b', true],
      ['asterisk treated literally (not zero-or-more)', 'foo aab bar', 'a*b', false],
      ['question mark', 'foo a?b bar', 'a?b', true],
      ['question mark treated literally (not optional)', 'foo ab bar', 'a?b', false],
      ['caret', 'foo a^b bar', 'a^b', true],
      ['dollar', 'foo a$b bar', 'a$b', true],
      ['braces', 'foo a{2}b bar', 'a{2}b', true],
      ['braces treated literally (not quantifier)', 'foo aab bar', 'a{2}b', false],
      ['pipe', 'foo a|b bar', 'a|b', true],
      ['pipe treated literally (not alternation)', 'foo a bar', 'a|b', false],
      ['backslash', 'foo a\\b bar', 'a\\b', true],
    ] as const)('%s', (_label, surface, word, expected) => {
      expect(matchesRejectWord(surface, word)).toBe(expected);
    });
  });

  describe('ASCII-boundary limitation (documented per JSDoc)', () => {
    it('does not match a word ending in a non-ASCII letter (\\b only fires at ASCII transitions)', () => {
      expect(matchesRejectWord('café au lait', 'café')).toBe(false);
    });
  });
});
