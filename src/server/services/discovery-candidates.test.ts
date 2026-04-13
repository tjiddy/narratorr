import { describe, it, expect } from 'vitest';
import { toScoredCandidate } from './discovery-candidates.js';
import type { BookMetadata } from '../../core/index.js';

function makeBook(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Test Book',
    authors: [{ name: 'Author One', asin: 'A001' }],
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
