import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibraryFilters } from './useLibraryFilters';
import type { BookWithAuthor } from '@/lib/api';

// Mock the library search hook — searchResultFilter allows tests to simulate search narrowing
let searchResultFilter: ((books: BookWithAuthor[]) => BookWithAuthor[]) | null = null;

vi.mock('@/hooks/useLibrarySearch', () => ({
  useLibrarySearch: (books: BookWithAuthor[]) => ({
    query: '',
    setQuery: vi.fn(),
    clearQuery: vi.fn(),
    results: searchResultFilter ? searchResultFilter(books) : books,
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
    searchResultFilter = null;
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

  describe('collapse series', () => {
    const seriesBooks: BookWithAuthor[] = [
      makeBook({ id: 10, title: 'Book 1', status: 'wanted', seriesName: 'Stormlight', seriesPosition: 1, createdAt: '2024-01-01T00:00:00Z' }),
      makeBook({ id: 11, title: 'Book 2', status: 'imported', seriesName: 'Stormlight', seriesPosition: 2, createdAt: '2024-01-02T00:00:00Z' }),
      makeBook({ id: 12, title: 'Book 3', status: 'wanted', seriesName: 'Stormlight', seriesPosition: 3, createdAt: '2024-01-03T00:00:00Z' }),
      makeBook({ id: 13, title: 'Standalone', status: 'wanted', seriesName: null, createdAt: '2024-01-04T00:00:00Z' }),
      makeBook({ id: 14, title: 'Other Series 1', status: 'imported', seriesName: 'Cosmere', seriesPosition: 1, createdAt: '2024-01-05T00:00:00Z' }),
    ];

    it('collapseSeriesEnabled toggle state persists and affects output', () => {
      const { result } = renderHook(() => useLibraryFilters(seriesBooks));

      // Default: not collapsed, all books shown
      expect(result.current.collapseSeriesEnabled).toBe(false);
      expect(result.current.filteredBooks).toHaveLength(5);

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
      });

      expect(result.current.collapseSeriesEnabled).toBe(true);
      // 1 representative per series + 1 standalone = 3
      expect(result.current.filteredBooks).toHaveLength(3);
    });

    it('collapsed output contains one book per series with badge count', () => {
      const { result } = renderHook(() => useLibraryFilters(seriesBooks));

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
      });

      const stormlight = result.current.filteredBooks.find((b) => b.seriesName === 'Stormlight');
      expect(stormlight).toBeTruthy();
      expect(stormlight!.collapsedCount).toBe(2);

      const cosmere = result.current.filteredBooks.find((b) => b.seriesName === 'Cosmere');
      expect(cosmere).toBeTruthy();
      expect(cosmere!.collapsedCount).toBe(0);
    });

    it('collapse + status filter: badge count reflects only status-filtered books', () => {
      const { result } = renderHook(() => useLibraryFilters(seriesBooks));

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
        result.current.setStatusFilter('wanted');
      });

      // Only wanted Stormlight books: id 10 (pos 1) and id 12 (pos 3)
      const stormlight = result.current.filteredBooks.find((b) => b.seriesName === 'Stormlight');
      expect(stormlight).toBeTruthy();
      expect(stormlight!.id).toBe(10); // lowest position
      expect(stormlight!.collapsedCount).toBe(1); // only 1 other wanted book

      // Cosmere id 14 is imported, filtered out
      expect(result.current.filteredBooks.find((b) => b.seriesName === 'Cosmere')).toBeUndefined();
    });

    it('collapse + author filter: only books by that author are collapsed', () => {
      const mixedAuthorBooks: BookWithAuthor[] = [
        makeBook({ id: 20, title: 'SA 1', seriesName: 'Stormlight', seriesPosition: 1, author: { id: 1, name: 'Sanderson', slug: 's', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-01T00:00:00Z' }),
        makeBook({ id: 21, title: 'SA 2', seriesName: 'Stormlight', seriesPosition: 2, author: { id: 1, name: 'Sanderson', slug: 's', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-02T00:00:00Z' }),
        makeBook({ id: 22, title: 'KKC 1', seriesName: 'Kingkiller', seriesPosition: 1, author: { id: 2, name: 'Rothfuss', slug: 'r', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-03T00:00:00Z' }),
        makeBook({ id: 23, title: 'KKC 2', seriesName: 'Kingkiller', seriesPosition: 2, author: { id: 2, name: 'Rothfuss', slug: 'r', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-04T00:00:00Z' }),
      ];

      const { result } = renderHook(() => useLibraryFilters(mixedAuthorBooks));

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
        result.current.setAuthorFilter('Sanderson');
      });

      // Only Sanderson's books remain; Stormlight collapses to 1
      expect(result.current.filteredBooks).toHaveLength(1);
      expect(result.current.filteredBooks[0].seriesName).toBe('Stormlight');
      expect(result.current.filteredBooks[0].collapsedCount).toBe(1);
    });

    it('collapse + series filter: selected series still collapses', () => {
      const { result } = renderHook(() => useLibraryFilters(seriesBooks));

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
        result.current.setSeriesFilter('Stormlight');
      });

      // Series filter shows only Stormlight books, collapse groups them
      expect(result.current.filteredBooks).toHaveLength(1);
      expect(result.current.filteredBooks[0].seriesName).toBe('Stormlight');
      expect(result.current.filteredBooks[0].id).toBe(10); // lowest position
      expect(result.current.filteredBooks[0].collapsedCount).toBe(2);
    });

    it('collapse + search: representative and badge count reflect search-narrowed results', () => {
      // Simulate search returning only 2 of 3 Stormlight books
      searchResultFilter = (books) => books.filter((b) => b.id !== 12);

      const { result } = renderHook(() => useLibraryFilters(seriesBooks));

      act(() => {
        result.current.setCollapseSeriesEnabled(true);
      });

      const stormlight = result.current.filteredBooks.find((b) => b.seriesName === 'Stormlight');
      expect(stormlight).toBeTruthy();
      expect(stormlight!.id).toBe(10); // lowest position among search results
      expect(stormlight!.collapsedCount).toBe(1); // only 2 books visible, badge = 1
    });
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
