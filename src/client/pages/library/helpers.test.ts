import { describe, it, expect } from 'vitest';
import { sortBooks, collapseSeries, matchesStatusFilter, getStatusCount } from './helpers';
import type { BookWithAuthor } from '@/lib/api';

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'Test Book',
    status: 'wanted',
    enrichmentStatus: 'pending',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    author: undefined,
    authorId: null,
    narrator: null,
    description: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    path: null,
    size: null,
    audioCodec: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitrateMode: null,
    audioFileFormat: null,
    audioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    monitorForUpgrades: false,
    ...overrides,
  };
}

describe('sortBooks', () => {
  it('sorts by title using toSortTitle — "The Way of Kings" sorts after "Warbreaker"', () => {
    const books = [
      makeBook({ id: 1, title: 'The Way of Kings' }),
      makeBook({ id: 2, title: 'Warbreaker' }),
      makeBook({ id: 3, title: 'A Game of Thrones' }),
    ];

    const sorted = sortBooks(books, 'title', 'asc');
    const titles = sorted.map((b) => b.title);
    // "A Game of Thrones" → "Game of Thrones" (G), "The Way of Kings" → "Way of Kings" (W), "Warbreaker" (W)
    expect(titles).toEqual(['A Game of Thrones', 'Warbreaker', 'The Way of Kings']);
  });

  it('sorts by author alphabetically', () => {
    const books = [
      makeBook({ id: 1, author: { id: 1, name: 'Sanderson', slug: 's', asin: null, imageUrl: null, bio: null } }),
      makeBook({ id: 2, author: { id: 2, name: 'Abercrombie', slug: 'a', asin: null, imageUrl: null, bio: null } }),
    ];

    const sorted = sortBooks(books, 'author', 'asc');
    expect(sorted[0].author?.name).toBe('Abercrombie');
    expect(sorted[1].author?.name).toBe('Sanderson');
  });

  it('sorts by createdAt', () => {
    const books = [
      makeBook({ id: 1, createdAt: '2024-01-03T00:00:00Z' }),
      makeBook({ id: 2, createdAt: '2024-01-01T00:00:00Z' }),
      makeBook({ id: 3, createdAt: '2024-01-02T00:00:00Z' }),
    ];

    const sortedAsc = sortBooks(books, 'createdAt', 'asc');
    expect(sortedAsc.map((b) => b.id)).toEqual([2, 3, 1]);

    const sortedDesc = sortBooks(books, 'createdAt', 'desc');
    expect(sortedDesc.map((b) => b.id)).toEqual([1, 3, 2]);
  });
});

describe('collapseSeries', () => {
  it('groups books by seriesName and picks lowest seriesPosition as representative', () => {
    const books = [
      makeBook({ id: 1, title: 'Book 1', seriesName: 'Stormlight', seriesPosition: 1 }),
      makeBook({ id: 2, title: 'Book 2', seriesName: 'Stormlight', seriesPosition: 2 }),
      makeBook({ id: 3, title: 'Book 3', seriesName: 'Stormlight', seriesPosition: 3 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe(1);
    expect(collapsed[0].collapsedCount).toBe(2);
  });

  it('passes standalone books (no seriesName) through unchanged', () => {
    const books = [
      makeBook({ id: 1, title: 'Standalone', seriesName: null }),
      makeBook({ id: 2, title: 'Book 1', seriesName: 'Series A', seriesPosition: 1 }),
      makeBook({ id: 3, title: 'Book 2', seriesName: 'Series A', seriesPosition: 2 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(2);
    const standalone = collapsed.find((b) => b.id === 1);
    expect(standalone).toBeTruthy();
    expect(standalone?.collapsedCount).toBeUndefined();
  });

  it('badge count equals visible books in series minus 1', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'WoT', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 2 }),
      makeBook({ id: 3, seriesName: 'WoT', seriesPosition: 3 }),
      makeBook({ id: 4, seriesName: 'WoT', seriesPosition: 4 }),
      makeBook({ id: 5, seriesName: 'WoT', seriesPosition: 5 }),
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].collapsedCount).toBe(4);
  });

  it('falls back to first by current sort order when no book has seriesPosition', () => {
    const books = [
      makeBook({ id: 1, title: 'Zulu', seriesName: 'NoPos', seriesPosition: null }),
      makeBook({ id: 2, title: 'Alpha', seriesName: 'NoPos', seriesPosition: null }),
    ];

    // Sort by title asc — Alpha comes first
    const collapsed = collapseSeries(books, 'title', 'asc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].title).toBe('Alpha');
    expect(collapsed[0].collapsedCount).toBe(1);
  });

  it('only operates on input set — does not include books outside the input', () => {
    // Simulate pre-filtered input: only 2 of 5 WoT books passed in
    const filteredBooks = [
      makeBook({ id: 2, seriesName: 'WoT', seriesPosition: 2 }),
      makeBook({ id: 4, seriesName: 'WoT', seriesPosition: 4 }),
    ];

    const collapsed = collapseSeries(filteredBooks, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].id).toBe(2); // lowest position in filtered set
    expect(collapsed[0].collapsedCount).toBe(1); // only 1 other book in filtered set
  });

  it('handles multiple series correctly', () => {
    const books = [
      makeBook({ id: 1, seriesName: 'Series A', seriesPosition: 1 }),
      makeBook({ id: 2, seriesName: 'Series A', seriesPosition: 2 }),
      makeBook({ id: 3, seriesName: 'Series B', seriesPosition: 1 }),
      makeBook({ id: 4, seriesName: 'Series B', seriesPosition: 2 }),
      makeBook({ id: 5, seriesName: 'Series B', seriesPosition: 3 }),
      makeBook({ id: 6, seriesName: null }), // standalone
    ];

    const collapsed = collapseSeries(books, 'createdAt', 'desc');
    expect(collapsed).toHaveLength(3); // 1 per series + 1 standalone
    const seriesA = collapsed.find((b) => b.seriesName === 'Series A');
    const seriesB = collapsed.find((b) => b.seriesName === 'Series B');
    expect(seriesA?.collapsedCount).toBe(1);
    expect(seriesB?.collapsedCount).toBe(2);
  });
});

describe('matchesStatusFilter', () => {
  it('all matches everything', () => {
    expect(matchesStatusFilter('wanted', 'all')).toBe(true);
    expect(matchesStatusFilter('imported', 'all')).toBe(true);
  });

  it('downloading matches both searching and downloading', () => {
    expect(matchesStatusFilter('searching', 'downloading')).toBe(true);
    expect(matchesStatusFilter('downloading', 'downloading')).toBe(true);
  });

  it('imported matches both imported and importing', () => {
    expect(matchesStatusFilter('imported', 'imported')).toBe(true);
    expect(matchesStatusFilter('importing', 'imported')).toBe(true);
  });
});

describe('getStatusCount', () => {
  it('counts books matching the filter', () => {
    const books = [
      makeBook({ status: 'wanted' }),
      makeBook({ status: 'downloading' }),
      makeBook({ status: 'imported' }),
    ];
    expect(getStatusCount(books, 'wanted')).toBe(1);
    expect(getStatusCount(books, 'downloading')).toBe(1);
  });
});
