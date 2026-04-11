import { describe, it, expect } from 'vitest';
import { buildDiscoveredBook } from './library-scan.helpers.js';

describe('buildDiscoveredBook', () => {
  it('builds a non-duplicate discovered book with parsed metadata', () => {
    const result = buildDiscoveredBook(
      '/audiobooks/Author/Book Title',
      { title: 'Book Title', author: 'Author', series: null },
      10,
      500000,
      false,
    );

    expect(result).toEqual({
      path: '/audiobooks/Author/Book Title',
      parsedTitle: 'Book Title',
      parsedAuthor: 'Author',
      parsedSeries: null,
      fileCount: 10,
      totalSize: 500000,
      isDuplicate: false,
    });
  });

  it('includes duplicate fields when provided', () => {
    const result = buildDiscoveredBook(
      '/audiobooks/Author/Book',
      { title: 'Book', author: 'Author', series: 'Series' },
      5,
      250000,
      true,
      42,
      'slug',
      '/audiobooks/Author/Book Original',
    );

    expect(result).toMatchObject({
      isDuplicate: true,
      existingBookId: 42,
      duplicateReason: 'slug',
      duplicateFirstPath: '/audiobooks/Author/Book Original',
    });
  });

  it('omits optional duplicate fields when not provided', () => {
    const result = buildDiscoveredBook(
      '/path',
      { title: 'T', author: null, series: null },
      1,
      100,
      false,
    );

    expect(result).not.toHaveProperty('existingBookId');
    expect(result).not.toHaveProperty('duplicateReason');
    expect(result).not.toHaveProperty('duplicateFirstPath');
  });
});
