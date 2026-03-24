import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibraryFilters, applyClientFilters } from './useLibraryFilters';
import type { BookWithAuthor } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';

describe('useLibraryFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters());

    expect(result.current.apiParams).toEqual({
      status: undefined,
      search: undefined,
      sortField: 'createdAt',
      sortDirection: 'desc',
      limit: 100,
      offset: 0,
    });
  });

  it('status filter updates apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => { result.current.setStatusFilter('wanted'); });

    expect(result.current.apiParams.status).toBe('wanted');
  });

  it('status=all sets undefined in apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => { result.current.setStatusFilter('wanted'); });
    act(() => { result.current.setStatusFilter('all'); });

    expect(result.current.apiParams.status).toBeUndefined();
  });

  it('search query updates apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => { result.current.setSearchQuery('tolkien'); });
    act(() => { vi.advanceTimersByTime(350); });

    expect(result.current.apiParams.search).toBe('tolkien');
    expect(result.current.isSearching).toBe(true);
  });

  it('sort field and direction update apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => {
      result.current.setSortField('title');
      result.current.setSortDirection('asc');
    });

    expect(result.current.apiParams.sortField).toBe('title');
    expect(result.current.apiParams.sortDirection).toBe('asc');
  });

  it('pagination resets when status filter changes', () => {
    const { result } = renderHook(() => useLibraryFilters());

    // Go to page 2
    act(() => { result.current.pagination.setPage(2); });
    expect(result.current.pagination.page).toBe(2);

    // Change status filter — should reset to page 1
    act(() => { result.current.setStatusFilter('wanted'); });
    expect(result.current.pagination.page).toBe(1);
  });

  it('pagination resets when search query changes', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => { result.current.pagination.setPage(3); });
    act(() => { result.current.setSearchQuery('foo'); });
    expect(result.current.pagination.page).toBe(1);
  });

  it('pagination resets when sort changes', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => { result.current.pagination.setPage(2); });
    act(() => { result.current.setSortField('title'); });
    expect(result.current.pagination.page).toBe(1);
  });

  it('tracks active filter count for client-side filters', () => {
    const { result } = renderHook(() => useLibraryFilters());

    expect(result.current.activeFilterCount).toBe(0);

    act(() => { result.current.setAuthorFilter('Author A'); });
    expect(result.current.activeFilterCount).toBe(1);

    act(() => { result.current.setSeriesFilter('Series X'); });
    expect(result.current.activeFilterCount).toBe(2);

    act(() => { result.current.setNarratorFilter('Michael Kramer'); });
    expect(result.current.activeFilterCount).toBe(3);
  });

  it('clearAllFilters resets all filter state', () => {
    const { result } = renderHook(() => useLibraryFilters());

    act(() => {
      result.current.setStatusFilter('wanted');
      result.current.setAuthorFilter('Author A');
      result.current.setSeriesFilter('Series X');
      result.current.setSearchQuery('foo');
      result.current.pagination.setPage(3);
    });

    act(() => { result.current.clearAllFilters(); });

    expect(result.current.statusFilter).toBe('all');
    expect(result.current.authorFilter).toBe('');
    expect(result.current.seriesFilter).toBe('');
    expect(result.current.searchQuery).toBe('');
    expect(result.current.pagination.page).toBe(1);
  });
});

describe('applyClientFilters', () => {
  const books: BookWithAuthor[] = [
    createMockBook({ id: 1, title: 'Alpha', status: 'wanted', authors: [{ id: 1, name: 'Author A', slug: 'author-a' }], seriesName: 'Series X', narrators: [{ id: 1, name: 'Michael Kramer', slug: 'michael-kramer' }], createdAt: '2024-01-01T00:00:00Z' }),
    createMockBook({ id: 2, title: 'Zulu', status: 'imported', authors: [{ id: 2, name: 'Author B', slug: 'author-b' }], seriesName: 'Series Y', narrators: [{ id: 2, name: 'Tim Gerard Reynolds', slug: 'tim-gerard-reynolds' }], createdAt: '2024-01-02T00:00:00Z' }),
    createMockBook({ id: 3, title: 'Middle', status: 'downloading', authors: [{ id: 1, name: 'Author A', slug: 'author-a' }], seriesName: null, narrators: [], createdAt: '2024-01-03T00:00:00Z' }),
  ];

  const defaultFilters = { authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const };

  it('returns all books with no filters', () => {
    const result = applyClientFilters(books, defaultFilters);
    expect(result).toHaveLength(3);
  });

  it('filters by author', () => {
    const result = applyClientFilters(books, { ...defaultFilters, authorFilter: 'Author A' });
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.authors?.[0]?.name === 'Author A')).toBe(true);
  });

  it('filters by series', () => {
    const result = applyClientFilters(books, { ...defaultFilters, seriesFilter: 'Series X' });
    expect(result).toHaveLength(1);
    expect(result[0].seriesName).toBe('Series X');
  });

  it('filters by narrator', () => {
    const result = applyClientFilters(books, { ...defaultFilters, narratorFilter: 'Michael Kramer' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('collapse series groups books', () => {
    const seriesBooks: BookWithAuthor[] = [
      createMockBook({ id: 10, seriesName: 'Stormlight', seriesPosition: 1, createdAt: '2024-01-01T00:00:00Z' }),
      createMockBook({ id: 11, seriesName: 'Stormlight', seriesPosition: 2, createdAt: '2024-01-02T00:00:00Z' }),
      createMockBook({ id: 12, seriesName: null, createdAt: '2024-01-03T00:00:00Z' }),
    ];
    const result = applyClientFilters(seriesBooks, { ...defaultFilters, collapseSeriesEnabled: true });
    // 1 representative for Stormlight + 1 standalone = 2
    expect(result).toHaveLength(2);
  });
});

describe('applyClientFilters — many-to-many author/narrator (#71)', () => {
  it('author filter matches when author is ANY of book.authors (not just first)', () => {
    const multiAuthorBook = createMockBook({
      id: 10,
      authors: [
        { id: 1, name: 'Author A', slug: 'author-a' },
        { id: 2, name: 'Author B', slug: 'author-b' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    });
    const result = applyClientFilters([multiAuthorBook], {
      ...{ authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const },
      authorFilter: 'Author B',
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
  });

  it('narrator filter matches when narrator is ANY of book.narrators (not just first)', () => {
    const multiNarratorBook = createMockBook({
      id: 11,
      narrators: [
        { id: 1, name: 'Michael Kramer', slug: 'michael-kramer' },
        { id: 2, name: 'Kate Reading', slug: 'kate-reading' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
    });
    const result = applyClientFilters([multiNarratorBook], {
      ...{ authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const },
      narratorFilter: 'Kate Reading',
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(11);
  });

  it('author filter does not match book where no author matches', () => {
    const book = createMockBook({
      id: 12,
      authors: [{ id: 1, name: 'Author A', slug: 'author-a' }],
      createdAt: '2024-01-01T00:00:00Z',
    });
    const result = applyClientFilters([book], {
      ...{ authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const },
      authorFilter: 'Author Z',
    });
    expect(result).toHaveLength(0);
  });

  it('narrator filter does not match book where no narrator matches', () => {
    const book = createMockBook({
      id: 13,
      narrators: [{ id: 1, name: 'Michael Kramer', slug: 'michael-kramer' }],
      createdAt: '2024-01-01T00:00:00Z',
    });
    const result = applyClientFilters([book], {
      ...{ authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const },
      narratorFilter: 'Kate Reading',
    });
    expect(result).toHaveLength(0);
  });
});
