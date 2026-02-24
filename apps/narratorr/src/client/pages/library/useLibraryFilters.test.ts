import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibraryFilters } from './useLibraryFilters';
import type { BookWithAuthor } from '@/lib/api';

// Mock the library search hook
vi.mock('@/hooks/useLibrarySearch', () => ({
  useLibrarySearch: (books: BookWithAuthor[]) => ({
    query: '',
    setQuery: vi.fn(),
    clearQuery: vi.fn(),
    results: books,
    isSearching: false,
  }),
}));

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
    ...overrides,
  };
}

describe('useLibraryFilters', () => {
  const books: BookWithAuthor[] = [
    makeBook({ id: 1, title: 'Alpha', status: 'wanted', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: 'Series X', createdAt: '2024-01-01T00:00:00Z' }),
    makeBook({ id: 2, title: 'Zulu', status: 'imported', author: { id: 2, name: 'Author B', slug: 'author-b', asin: null, imageUrl: null, bio: null }, seriesName: 'Series Y', createdAt: '2024-01-02T00:00:00Z' }),
    makeBook({ id: 3, title: 'Middle', status: 'downloading', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-03T00:00:00Z' }),
    makeBook({ id: 4, title: 'Bravo', status: 'searching', createdAt: '2024-01-04T00:00:00Z' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes unique authors sorted alphabetically', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    expect(result.current.uniqueAuthors).toEqual(['Author A', 'Author B']);
  });

  it('computes unique series sorted alphabetically', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    expect(result.current.uniqueSeries).toEqual(['Series X', 'Series Y']);
  });

  it('computes status counts correctly', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    expect(result.current.statusCounts).toEqual({
      all: 4,
      wanted: 1,
      downloading: 2, // downloading + searching
      imported: 1,
    });
  });

  it('filters by status', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setStatusFilter('wanted');
    });

    expect(result.current.filteredBooks).toHaveLength(1);
    expect(result.current.filteredBooks[0].title).toBe('Alpha');
  });

  it('filters by author', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setAuthorFilter('Author A');
    });

    expect(result.current.filteredBooks).toHaveLength(2);
    expect(result.current.filteredBooks.every((b) => b.author?.name === 'Author A')).toBe(true);
  });

  it('filters by series', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setSeriesFilter('Series X');
    });

    expect(result.current.filteredBooks).toHaveLength(1);
    expect(result.current.filteredBooks[0].seriesName).toBe('Series X');
  });

  it('combines multiple filters', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setStatusFilter('wanted');
      result.current.setAuthorFilter('Author A');
    });

    expect(result.current.filteredBooks).toHaveLength(1);
    expect(result.current.filteredBooks[0].title).toBe('Alpha');
  });

  it('sorts by title ascending', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setSortField('title');
      result.current.setSortDirection('asc');
    });

    const titles = result.current.filteredBooks.map((b) => b.title);
    expect(titles).toEqual(['Alpha', 'Bravo', 'Middle', 'Zulu']);
  });

  it('sorts by title descending', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setSortField('title');
      result.current.setSortDirection('desc');
    });

    const titles = result.current.filteredBooks.map((b) => b.title);
    expect(titles).toEqual(['Zulu', 'Middle', 'Bravo', 'Alpha']);
  });

  it('sorts by createdAt descending by default', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    // Default is createdAt desc (newest first)
    const ids = result.current.filteredBooks.map((b) => b.id);
    expect(ids).toEqual([4, 3, 2, 1]);
  });

  it('tracks active filter count', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    expect(result.current.activeFilterCount).toBe(0);

    act(() => {
      result.current.setAuthorFilter('Author A');
    });
    expect(result.current.activeFilterCount).toBe(1);

    act(() => {
      result.current.setSeriesFilter('Series X');
    });
    expect(result.current.activeFilterCount).toBe(2);
  });

  it('clearAllFilters resets all filter state', () => {
    const { result } = renderHook(() => useLibraryFilters(books));

    act(() => {
      result.current.setStatusFilter('wanted');
      result.current.setAuthorFilter('Author A');
      result.current.setSeriesFilter('Series X');
    });

    act(() => {
      result.current.clearAllFilters();
    });

    expect(result.current.statusFilter).toBe('all');
    expect(result.current.authorFilter).toBe('');
    expect(result.current.seriesFilter).toBe('');
    expect(result.current.filteredBooks).toHaveLength(4);
  });
});
