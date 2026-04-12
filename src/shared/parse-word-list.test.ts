import { describe, expect, it } from 'vitest';
import { parseWordList } from './parse-word-list.js';

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
