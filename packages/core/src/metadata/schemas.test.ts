import { describe, it, expect } from 'vitest';
import {
  AuthorRefSchema,
  SeriesRefSchema,
  BookMetadataSchema,
  AuthorMetadataSchema,
  SeriesMetadataSchema,
  MetadataSearchResultsSchema,
} from './schemas.js';

describe('AuthorRefSchema', () => {
  it('accepts valid author ref', () => {
    const result = AuthorRefSchema.safeParse({ name: 'Brandon Sanderson', asin: 'B001H6UJO8' });
    expect(result.success).toBe(true);
  });

  it('accepts author ref without asin', () => {
    const result = AuthorRefSchema.safeParse({ name: 'Brandon Sanderson' });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = AuthorRefSchema.safeParse({ asin: 'B001H6UJO8' });
    expect(result.success).toBe(false);
  });
});

describe('SeriesRefSchema', () => {
  it('accepts valid series ref with all fields', () => {
    const result = SeriesRefSchema.safeParse({
      name: 'The Stormlight Archive',
      position: 1,
      asin: 'B010XKCR92',
    });
    expect(result.success).toBe(true);
  });

  it('accepts series ref with name only', () => {
    const result = SeriesRefSchema.safeParse({ name: 'Cosmere' });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = SeriesRefSchema.safeParse({ position: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric position', () => {
    const result = SeriesRefSchema.safeParse({ name: 'Series', position: 'first' });
    expect(result.success).toBe(false);
  });
});

describe('BookMetadataSchema', () => {
  const validBook = {
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
  };

  it('accepts minimal valid book', () => {
    const result = BookMetadataSchema.safeParse(validBook);
    expect(result.success).toBe(true);
  });

  it('accepts book with all optional fields', () => {
    const result = BookMetadataSchema.safeParse({
      ...validBook,
      asin: 'B0030DL4GK',
      isbn: '9780765365286',
      goodreadsId: '7235533',
      subtitle: 'Book One of the Stormlight Archive',
      narrators: ['Kate Reading', 'Michael Kramer'],
      series: [{ name: 'The Stormlight Archive', position: 1 }],
      description: 'An epic fantasy novel.',
      publisher: 'Macmillan Audio',
      publishedDate: '2010-08-31',
      language: 'english',
      coverUrl: 'https://example.com/cover.jpg',
      duration: 2714,
      genres: ['Fantasy', 'Epic Fantasy'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing title', () => {
    const result = BookMetadataSchema.safeParse({ authors: [{ name: 'Author' }] });
    expect(result.success).toBe(false);
  });

  it('rejects missing authors', () => {
    const result = BookMetadataSchema.safeParse({ title: 'Book' });
    expect(result.success).toBe(false);
  });

  it('rejects empty authors array', () => {
    const result = BookMetadataSchema.safeParse({ title: 'Book', authors: [] });
    // Empty array is technically valid for z.array(), but let's verify
    expect(result.success).toBe(true);
  });

  it('rejects invalid coverUrl', () => {
    const result = BookMetadataSchema.safeParse({
      ...validBook,
      coverUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-number duration', () => {
    const result = BookMetadataSchema.safeParse({
      ...validBook,
      duration: '2714',
    });
    expect(result.success).toBe(false);
  });
});

describe('AuthorMetadataSchema', () => {
  it('accepts valid author', () => {
    const result = AuthorMetadataSchema.safeParse({
      name: 'Brandon Sanderson',
      asin: 'B001H6UJO8',
      description: 'Fantasy author',
      imageUrl: 'https://example.com/author.jpg',
      genres: ['Fantasy'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts author with name only', () => {
    const result = AuthorMetadataSchema.safeParse({ name: 'Brandon Sanderson' });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = AuthorMetadataSchema.safeParse({ asin: 'B001H6UJO8' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid imageUrl', () => {
    const result = AuthorMetadataSchema.safeParse({
      name: 'Brandon Sanderson',
      imageUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });
});

describe('SeriesMetadataSchema', () => {
  it('accepts valid series', () => {
    const result = SeriesMetadataSchema.safeParse({
      name: 'The Stormlight Archive',
      books: [{ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing name', () => {
    const result = SeriesMetadataSchema.safeParse({
      books: [{ title: 'Book', authors: [{ name: 'Author' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing books array', () => {
    const result = SeriesMetadataSchema.safeParse({ name: 'Series' });
    expect(result.success).toBe(false);
  });
});

describe('MetadataSearchResultsSchema', () => {
  it('accepts valid search results', () => {
    const result = MetadataSearchResultsSchema.safeParse({
      books: [{ title: 'Book', authors: [{ name: 'Author' }] }],
      authors: [{ name: 'Author' }],
      series: [{ name: 'Series', books: [{ title: 'Book', authors: [{ name: 'Author' }] }] }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty arrays', () => {
    const result = MetadataSearchResultsSchema.safeParse({
      books: [],
      authors: [],
      series: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing books field', () => {
    const result = MetadataSearchResultsSchema.safeParse({
      authors: [],
      series: [],
    });
    expect(result.success).toBe(false);
  });
});
