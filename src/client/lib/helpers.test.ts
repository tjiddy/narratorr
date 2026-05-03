import { describe, it, expect } from 'vitest';
import { mapBookMetadataToPayload, isBookInLibrary } from './helpers.js';
import { createMockBook } from '@/__tests__/factories';
import type { BookMetadata, BookWithAuthor, BookIdentifier } from './api/index.js';

describe('mapBookMetadataToPayload', () => {
  const fullBook: BookMetadata = {
    title: 'The Way of Kings',
    asin: 'B003P2WO5E',
    authors: [
      { name: 'Brandon Sanderson', asin: 'B001IGFHW6' },
      { name: 'Co-Author', asin: 'B999' },
    ],
    narrators: ['Michael Kramer', 'Kate Reading'],
    series: [
      { name: 'The Stormlight Archive', position: 1 },
      { name: 'Cosmere', position: 5 },
    ],
    description: 'Epic fantasy',
    coverUrl: 'https://example.com/cover.jpg',
    duration: 2700,
    genres: ['Fantasy', 'Epic'],
    providerId: 'audnexus',
  };

  it('maps all fields from a complete metadata object', () => {
    const payload = mapBookMetadataToPayload(fullBook);
    expect(payload).toEqual({
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }, { name: 'Co-Author', asin: 'B999' }],
      narrators: ['Michael Kramer', 'Kate Reading'],
      description: 'Epic fantasy',
      coverUrl: 'https://example.com/cover.jpg',
      asin: 'B003P2WO5E',
      seriesName: 'The Stormlight Archive',
      seriesPosition: 1,
      duration: 2700,
      genres: ['Fantasy', 'Epic'],
      providerId: 'audnexus',
    });
  });

  it('includes all authors as array', () => {
    const payload = mapBookMetadataToPayload(fullBook);
    expect(payload.authors![0]!.name).toBe('Brandon Sanderson');
    expect(payload.authors).toHaveLength(2);
  });

  it('uses only the first series entry', () => {
    const payload = mapBookMetadataToPayload(fullBook);
    expect(payload.seriesName).toBe('The Stormlight Archive');
    expect(payload.seriesPosition).toBe(1);
  });

  it('handles no authors', () => {
    const book: BookMetadata = { title: 'Orphan Book', authors: [] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.authors).toHaveLength(0);
  });

  it('handles no narrators', () => {
    const book: BookMetadata = { title: 'Silent Book', authors: [{ name: 'Author' }] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.narrators).toBeUndefined();
  });

  it('handles no series', () => {
    const book: BookMetadata = { title: 'Standalone', authors: [{ name: 'Author' }] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.seriesName).toBeUndefined();
    expect(payload.seriesPosition).toBeUndefined();
  });

  it('includes monitorForUpgrades and searchImmediately from qualityDefaults', () => {
    const book: BookMetadata = { title: 'Test', authors: [{ name: 'Author' }] };
    const payload = mapBookMetadataToPayload(book, { searchImmediately: true, monitorForUpgrades: true });
    expect(payload.monitorForUpgrades).toBe(true);
    expect(payload.searchImmediately).toBe(true);
  });

  it('omits monitorForUpgrades and searchImmediately when no qualityDefaults', () => {
    const book: BookMetadata = { title: 'Test', authors: [{ name: 'Author' }] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.monitorForUpgrades).toBeUndefined();
    expect(payload.searchImmediately).toBeUndefined();
  });
});

describe('isBookInLibrary', () => {
  const libraryBook: BookWithAuthor = createMockBook();

  it('returns false for undefined libraryBooks', () => {
    const book: BookMetadata = { title: 'Test', authors: [{ name: 'Author' }] };
    expect(isBookInLibrary(book, undefined)).toBe(false);
  });

  it('returns false for empty libraryBooks', () => {
    const book: BookMetadata = { title: 'Test', authors: [{ name: 'Author' }] };
    expect(isBookInLibrary(book, [])).toBe(false);
  });

  it('matches by ASIN', () => {
    const book: BookMetadata = {
      title: 'Completely Different Title',
      asin: 'B003P2WO5E',
      authors: [{ name: 'Different Author' }],
    };
    expect(isBookInLibrary(book, [libraryBook])).toBe(true);
  });

  it('matches by case-insensitive title + author', () => {
    const book: BookMetadata = {
      title: 'the way of kings',
      authors: [{ name: 'brandon sanderson' }],
    };
    const libBook: BookWithAuthor = { ...libraryBook, asin: null };
    expect(isBookInLibrary(book, [libBook])).toBe(true);
  });

  it('requires both title and author for non-ASIN match', () => {
    const book: BookMetadata = {
      title: 'The Way of Kings',
      authors: [{ name: 'Wrong Author' }],
    };
    const libBook: BookWithAuthor = { ...libraryBook, asin: null };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });

  it('does not match title-only when book has no authors', () => {
    const book: BookMetadata = {
      title: 'The Way of Kings',
      authors: [],
    };
    const libBook: BookWithAuthor = { ...libraryBook, asin: null };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });

  it('does not match when library book has no author', () => {
    const book: BookMetadata = {
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson' }],
    };
    const libBook: BookWithAuthor = { ...libraryBook, asin: null, authors: [] };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });
});

describe('isBookInLibrary — authorless matching (#246)', () => {
  it('matches by title when both search result and BookWithAuthor library book have no authors', () => {
    const book: BookMetadata = { title: 'Shogun', authors: [] };
    const libBook: BookWithAuthor = { ...createMockBook(), asin: null, title: 'Shogun', authors: [] };
    expect(isBookInLibrary(book, [libBook])).toBe(true);
  });

  it('matches by title when both search result and BookIdentifier library book have authorName: null', () => {
    const book: BookMetadata = { title: 'Shogun', authors: [] };
    const libBook: BookIdentifier = { asin: null, title: 'Shogun', authorName: null, authorSlug: null };
    expect(isBookInLibrary(book, [libBook])).toBe(true);
  });

  it('does not match by title alone when library book has authors', () => {
    const book: BookMetadata = { title: 'Shogun', authors: [] };
    const libBook: BookWithAuthor = { ...createMockBook(), asin: null, title: 'Shogun' };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });

  it('does not match when titles differ even if both have no authors', () => {
    const book: BookMetadata = { title: 'Shogun', authors: [] };
    const libBook: BookWithAuthor = { ...createMockBook(), asin: null, title: 'Different Book', authors: [] };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });
});

describe('mapBookMetadataToPayload — array shape (#71)', () => {
  it('BookMetadata with one author → authors: [{ name, asin }] in payload', () => {
    const book: BookMetadata = {
      title: 'Test',
      authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
    };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.authors).toEqual([{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }]);
  });

  it('BookMetadata with two authors → authors: [{ name, asin }, { name, asin }] (all, not just first)', () => {
    const book: BookMetadata = {
      title: 'Test',
      authors: [
        { name: 'Author One', asin: 'AAAA' },
        { name: 'Author Two', asin: 'BBBB' },
      ],
    };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.authors).toHaveLength(2);
    expect(payload.authors![1]).toEqual({ name: 'Author Two', asin: 'BBBB' });
  });

  it('narrators: ["Kate Reading", "Michael Kramer"] → narrators: ["Kate Reading", "Michael Kramer"] in payload (array not joined)', () => {
    const book: BookMetadata = {
      title: 'Test',
      authors: [{ name: 'Author' }],
      narrators: ['Kate Reading', 'Michael Kramer'],
    };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.narrators).toEqual(['Kate Reading', 'Michael Kramer']);
  });

  it('no narrators → narrators: [] in payload', () => {
    const book: BookMetadata = {
      title: 'Test',
      authors: [{ name: 'Author' }],
      narrators: [],
    };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.narrators).toEqual([]);
  });
});

describe('isBookInLibrary — array author matching (#71)', () => {
  it('BookWithAuthor branch matches on lb.authors[0]?.name', () => {
    const libBook: BookWithAuthor = {
      ...createMockBook(),
      asin: null,
      authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
    };
    const searchBook: BookMetadata = {
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson' }],
    };
    expect(isBookInLibrary(searchBook, [libBook])).toBe(true);
  });

  it('BookIdentifier branch retains lb.authorName lookup (unchanged)', () => {
    const bookId = { id: 1, title: 'The Way of Kings', asin: null, authorName: 'Brandon Sanderson' };
    const searchBook: BookMetadata = {
      title: 'The Way of Kings',
      authors: [{ name: 'Brandon Sanderson' }],
    };
    // BookIdentifier has authorName (not authors array) — should still match
    expect(isBookInLibrary(searchBook, [bookId as never])).toBe(true);
  });
});
