import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibraryFilters } from './useLibraryFilters';
import type { BookWithAuthor } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';

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

describe('useLibraryFilters', () => {
  const books: BookWithAuthor[] = [
    createMockBook({ id: 1, title: 'Alpha', status: 'wanted', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: 'Series X', createdAt: '2024-01-01T00:00:00Z' }),
    createMockBook({ id: 2, title: 'Zulu', status: 'imported', author: { id: 2, name: 'Author B', slug: 'author-b', asin: null, imageUrl: null, bio: null }, seriesName: 'Series Y', createdAt: '2024-01-02T00:00:00Z' }),
    createMockBook({ id: 3, title: 'Middle', status: 'downloading', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: null, createdAt: '2024-01-03T00:00:00Z' }),
    createMockBook({ id: 4, title: 'Bravo', status: 'searching', author: undefined, seriesName: null, createdAt: '2024-01-04T00:00:00Z' }),
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
      failed: 0,
      missing: 0,
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
      createMockBook({ id: 10, title: 'Book 1', status: 'wanted', seriesName: 'Stormlight', seriesPosition: 1, createdAt: '2024-01-01T00:00:00Z' }),
      createMockBook({ id: 11, title: 'Book 2', status: 'imported', seriesName: 'Stormlight', seriesPosition: 2, createdAt: '2024-01-02T00:00:00Z' }),
      createMockBook({ id: 12, title: 'Book 3', status: 'wanted', seriesName: 'Stormlight', seriesPosition: 3, createdAt: '2024-01-03T00:00:00Z' }),
      createMockBook({ id: 13, title: 'Standalone', status: 'wanted', seriesName: null, createdAt: '2024-01-04T00:00:00Z' }),
      createMockBook({ id: 14, title: 'Other Series 1', status: 'imported', seriesName: 'Cosmere', seriesPosition: 1, createdAt: '2024-01-05T00:00:00Z' }),
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
        createMockBook({ id: 20, title: 'SA 1', seriesName: 'Stormlight', seriesPosition: 1, author: { id: 1, name: 'Sanderson', slug: 's', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-01T00:00:00Z' }),
        createMockBook({ id: 21, title: 'SA 2', seriesName: 'Stormlight', seriesPosition: 2, author: { id: 1, name: 'Sanderson', slug: 's', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-02T00:00:00Z' }),
        createMockBook({ id: 22, title: 'KKC 1', seriesName: 'Kingkiller', seriesPosition: 1, author: { id: 2, name: 'Rothfuss', slug: 'r', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-03T00:00:00Z' }),
        createMockBook({ id: 23, title: 'KKC 2', seriesName: 'Kingkiller', seriesPosition: 2, author: { id: 2, name: 'Rothfuss', slug: 'r', asin: null, imageUrl: null, bio: null }, createdAt: '2024-01-04T00:00:00Z' }),
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

  // #282 — Narrator filter
  describe('narrator filter (#282)', () => {
    const narratorBooks: BookWithAuthor[] = [
      createMockBook({ id: 30, title: 'Book A', status: 'wanted', narrator: 'Michael Kramer, Kate Reading', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: 'Series X', createdAt: '2024-01-01T00:00:00Z' }),
      createMockBook({ id: 31, title: 'Book B', status: 'imported', narrator: 'Tim Gerard Reynolds', author: { id: 2, name: 'Author B', slug: 'author-b', asin: null, imageUrl: null, bio: null }, seriesName: null, createdAt: '2024-01-02T00:00:00Z' }),
      createMockBook({ id: 32, title: 'Book C', status: 'wanted', narrator: 'Kate Reading & Steven Pacey', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: 'Series X', createdAt: '2024-01-03T00:00:00Z' }),
      createMockBook({ id: 33, title: 'Book D', status: 'downloading', narrator: null, author: { id: 2, name: 'Author B', slug: 'author-b', asin: null, imageUrl: null, bio: null }, seriesName: null, createdAt: '2024-01-04T00:00:00Z' }),
      createMockBook({ id: 34, title: 'Book E', status: 'searching', narrator: 'michael kramer; Ray Porter', author: { id: 1, name: 'Author A', slug: 'author-a', asin: null, imageUrl: null, bio: null }, seriesName: 'Series Y', createdAt: '2024-01-05T00:00:00Z' }),
    ];

    it('computes unique narrators from all books, splitting on [,;&]', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      // Case-insensitive dedup: 'michael kramer' (Book E) is same as 'Michael Kramer' (Book A)
      expect(result.current.uniqueNarrators).toEqual([
        'Kate Reading',
        'Michael Kramer',
        'Ray Porter',
        'Steven Pacey',
        'Tim Gerard Reynolds',
      ]);
    });

    it('handles multi-narrator books contributing each narrator to the set', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      // Kate Reading appears in both Book A (comma-delimited) and Book C (ampersand-delimited)
      // but should only appear once in the unique list
      const kateCount = result.current.uniqueNarrators.filter((n) => n === 'Kate Reading').length;
      expect(kateCount).toBe(1);

      // All individual narrators from multi-narrator strings should be present
      expect(result.current.uniqueNarrators).toContain('Michael Kramer');
      expect(result.current.uniqueNarrators).toContain('Kate Reading');
      expect(result.current.uniqueNarrators).toContain('Steven Pacey');
      expect(result.current.uniqueNarrators).toContain('Ray Porter');
    });

    it('excludes null/empty narrators from unique list', () => {
      const emptyBooks: BookWithAuthor[] = [
        createMockBook({ id: 40, narrator: null, createdAt: '2024-01-01T00:00:00Z' }),
        createMockBook({ id: 41, narrator: '', createdAt: '2024-01-02T00:00:00Z' }),
        createMockBook({ id: 42, narrator: '  ', createdAt: '2024-01-03T00:00:00Z' }),
        createMockBook({ id: 43, narrator: 'Ray Porter', createdAt: '2024-01-04T00:00:00Z' }),
      ];

      const { result } = renderHook(() => useLibraryFilters(emptyBooks));

      expect(result.current.uniqueNarrators).toEqual(['Ray Porter']);
    });

    it('filters books by selected narrator (case-insensitive)', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      act(() => {
        result.current.setNarratorFilter('Tim Gerard Reynolds');
      });

      expect(result.current.filteredBooks).toHaveLength(1);
      expect(result.current.filteredBooks[0].id).toBe(31);
    });

    it('multi-narrator book matches when any narrator matches', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      act(() => {
        result.current.setNarratorFilter('Kate Reading');
      });

      // Book A has "Michael Kramer, Kate Reading" and Book C has "Kate Reading & Steven Pacey"
      expect(result.current.filteredBooks).toHaveLength(2);
      const ids = result.current.filteredBooks.map((b) => b.id);
      expect(ids).toContain(30);
      expect(ids).toContain(32);
    });

    it('narrator filter combines with status + author + series filters', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      act(() => {
        result.current.setNarratorFilter('Kate Reading');
        result.current.setStatusFilter('wanted');
        result.current.setAuthorFilter('Author A');
        result.current.setSeriesFilter('Series X');
      });

      // Book A: wanted, Author A, Series X, has Kate Reading -> matches
      // Book C: wanted, Author A, Series X, has Kate Reading -> matches
      expect(result.current.filteredBooks).toHaveLength(2);
      const ids = result.current.filteredBooks.map((b) => b.id);
      expect(ids).toContain(30);
      expect(ids).toContain(32);
    });

    it('clearing narrator filter restores full list', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      act(() => {
        result.current.setNarratorFilter('Tim Gerard Reynolds');
      });

      expect(result.current.filteredBooks).toHaveLength(1);

      act(() => {
        result.current.setNarratorFilter('');
      });

      expect(result.current.filteredBooks).toHaveLength(5);
    });

    it('includes narrator in active filter count', () => {
      const { result } = renderHook(() => useLibraryFilters(narratorBooks));

      expect(result.current.activeFilterCount).toBe(0);

      act(() => {
        result.current.setNarratorFilter('Kate Reading');
      });

      expect(result.current.activeFilterCount).toBe(1);

      act(() => {
        result.current.setAuthorFilter('Author A');
      });

      expect(result.current.activeFilterCount).toBe(2);
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

  // #351 — failed and missing status counts and filtering
  describe('failed and missing status filters (#351)', () => {
    const booksWithAllStatuses: BookWithAuthor[] = [
      createMockBook({ id: 1, title: 'Wanted Book', status: 'wanted', createdAt: '2024-01-01T00:00:00Z' }),
      createMockBook({ id: 2, title: 'Downloading Book', status: 'downloading', createdAt: '2024-01-02T00:00:00Z' }),
      createMockBook({ id: 3, title: 'Imported Book', status: 'imported', createdAt: '2024-01-03T00:00:00Z' }),
      createMockBook({ id: 4, title: 'Failed Book', status: 'failed', createdAt: '2024-01-04T00:00:00Z' }),
      createMockBook({ id: 5, title: 'Missing Book', status: 'missing', createdAt: '2024-01-05T00:00:00Z' }),
    ];

    it('statusCounts includes failed and missing keys', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      expect(result.current.statusCounts).toHaveProperty('failed');
      expect(result.current.statusCounts).toHaveProperty('missing');
    });

    it('statusCounts.failed equals count of books with failed status', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      expect(result.current.statusCounts.failed).toBe(1);
    });

    it('statusCounts.missing equals count of books with missing status', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      expect(result.current.statusCounts.missing).toBe(1);
    });

    it('existing status count values unchanged', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      expect(result.current.statusCounts.all).toBe(5);
      expect(result.current.statusCounts.wanted).toBe(1);
      expect(result.current.statusCounts.downloading).toBe(1);
      expect(result.current.statusCounts.imported).toBe(1);
    });

    it('setting statusFilter to failed returns only failed books', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      act(() => { result.current.setStatusFilter('failed'); });
      expect(result.current.filteredBooks).toHaveLength(1);
      expect(result.current.filteredBooks[0].title).toBe('Failed Book');
    });

    it('setting statusFilter to missing returns only missing books', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      act(() => { result.current.setStatusFilter('missing'); });
      expect(result.current.filteredBooks).toHaveLength(1);
      expect(result.current.filteredBooks[0].title).toBe('Missing Book');
    });

    it('clearAllFilters resets from failed back to all', () => {
      const { result } = renderHook(() => useLibraryFilters(booksWithAllStatuses));
      act(() => { result.current.setStatusFilter('failed'); });
      expect(result.current.filteredBooks).toHaveLength(1);
      act(() => { result.current.clearAllFilters(); });
      expect(result.current.statusFilter).toBe('all');
      expect(result.current.filteredBooks).toHaveLength(5);
    });
  });
});
