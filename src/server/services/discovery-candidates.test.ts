import { describe, it, expect } from 'vitest';
import { toScoredCandidate, isEligibleCandidate, type CandidateContext } from './discovery-candidates.js';
import type { BookMetadata } from '../../core/index.js';

function makeBook(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Test Book',
    authors: [{ name: 'Author One', asin: 'A001' }],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    languages: ['english'],
    existingAsins: new Set<string>(),
    existingTitleAuthors: [],
    dismissedAsins: new Set<string>(),
    maxPerAuthor: 5,
    signals: { topAuthors: [], topSeries: [], topGenres: [], topNarrators: [], underrepresentedGenres: [] },
    warnings: [],
    multipliers: { author: 1, series: 1, genre: 1, narrator: 1, diversity: 1 },
    ...overrides,
  };
}

describe('toScoredCandidate', () => {
  it('maps book.authors[0]?.asin to authorAsin field', () => {
    const book = makeBook({ authors: [{ name: 'Joe', asin: 'ASIN123' }] });
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.authorAsin).toBe('ASIN123');
    expect(result.authorName).toBe('Joe');
  });

  it('sets authorAsin to undefined when author has no ASIN', () => {
    const book = makeBook({ authors: [{ name: 'Joe' }] });
    const result = toScoredCandidate(book, 'author', 'test', 80);
    expect(result.authorAsin).toBeUndefined();
    expect(result.authorName).toBe('Joe');
  });

  it('sets authorName to Unknown and authorAsin to undefined when book has no authors', () => {
    const book = makeBook({ authors: [] });
    const result = toScoredCandidate(book, 'genre', 'test', 60);
    expect(result.authorName).toBe('Unknown');
    expect(result.authorAsin).toBeUndefined();
  });
});

describe('isEligibleCandidate — language filtering', () => {
  it('accepts book whose language matches one of configured languages', () => {
    const book = makeBook({ asin: 'B001', language: 'english' });
    const ctx = makeCtx({ languages: ['english', 'french'] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });

  it('rejects book whose language matches none of configured languages', () => {
    const book = makeBook({ asin: 'B001', language: 'german' });
    const ctx = makeCtx({ languages: ['english', 'french'] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('rejects book with null language even when languages are configured', () => {
    const book = makeBook({ asin: 'B001' });
    const ctx = makeCtx({ languages: ['english'] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('accepts any book with a language when languages array is empty (no filtering)', () => {
    const book = makeBook({ asin: 'B001', language: 'japanese' });
    const ctx = makeCtx({ languages: [] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });

  it('rejects book with null language when languages array is empty', () => {
    const book = makeBook({ asin: 'B001' });
    const ctx = makeCtx({ languages: [] });
    expect(isEligibleCandidate(book, ctx)).toBe(false);
  });

  it('performs case-insensitive language comparison', () => {
    const book = makeBook({ asin: 'B001', language: 'English' });
    const ctx = makeCtx({ languages: ['english'] });
    expect(isEligibleCandidate(book, ctx)).toBe(true);
  });
});
