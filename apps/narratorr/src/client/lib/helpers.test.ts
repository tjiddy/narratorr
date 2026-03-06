import { describe, it, expect } from 'vitest';
import { formatDuration, mapBookMetadataToPayload, isBookInLibrary } from './helpers.js';
import { createMockBook } from '@/__tests__/factories';
import type { BookMetadata, BookWithAuthor } from './api/index.js';

describe('formatDuration', () => {
  it('returns null for undefined', () => {
    expect(formatDuration(undefined)).toBeNull();
  });

  it('returns null for null', () => {
    expect(formatDuration(null)).toBeNull();
  });

  it('returns null for 0', () => {
    expect(formatDuration(0)).toBeNull();
  });

  it('formats minutes only', () => {
    expect(formatDuration(45)).toBe('45m');
  });

  it('formats hours only when evenly divisible', () => {
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(120)).toBe('2h');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h 30m');
    expect(formatDuration(61)).toBe('1h 1m');
  });
});

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
      authorName: 'Brandon Sanderson',
      authorAsin: 'B001IGFHW6',
      narrator: 'Michael Kramer, Kate Reading',
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

  it('uses only the first author', () => {
    const payload = mapBookMetadataToPayload(fullBook);
    expect(payload.authorName).toBe('Brandon Sanderson');
  });

  it('uses only the first series entry', () => {
    const payload = mapBookMetadataToPayload(fullBook);
    expect(payload.seriesName).toBe('The Stormlight Archive');
    expect(payload.seriesPosition).toBe(1);
  });

  it('handles no authors', () => {
    const book: BookMetadata = { title: 'Orphan Book', authors: [] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.authorName).toBeUndefined();
    expect(payload.authorAsin).toBeUndefined();
  });

  it('handles no narrators', () => {
    const book: BookMetadata = { title: 'Silent Book', authors: [{ name: 'Author' }] };
    const payload = mapBookMetadataToPayload(book);
    expect(payload.narrator).toBeUndefined();
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
    const libBook: BookWithAuthor = { ...libraryBook, asin: null, author: undefined };
    expect(isBookInLibrary(book, [libBook])).toBe(false);
  });
});
