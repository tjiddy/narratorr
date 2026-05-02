import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { useLibraryFilters, applyClientFilters } from './useLibraryFilters';
import type { BookWithAuthor } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';

/** Wrapper that provides Router context with optional initial URL */
function createWrapper(route = '/library') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>;
  };
}

/** Mutable ref object for capturing URL state from inside components */
const urlRef = { current: '' };
function UrlCapture() {
  const [params] = useSearchParams();
  const serialized = '?' + params.toString();
  useEffect(() => {
    urlRef.current = serialized;
  });
  return null;
}

function createCapturingWrapper(route = '/library') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <UrlCapture />
        {children}
      </MemoryRouter>
    );
  };
}

describe('useLibraryFilters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    expect(result.current.params.apiParams).toEqual({
      status: undefined,
      search: undefined,
      sortField: 'createdAt',
      sortDirection: 'desc',
      limit: 100,
      offset: 0,
    });
  });

  it('status filter updates apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.actions.setStatusFilter('wanted'); });

    expect(result.current.params.apiParams.status).toBe('wanted');
  });

  it('status=all sets undefined in apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.actions.setStatusFilter('wanted'); });
    act(() => { result.current.actions.setStatusFilter('all'); });

    expect(result.current.params.apiParams.status).toBeUndefined();
  });

  it('search query updates apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.actions.setSearchQuery('tolkien'); });
    act(() => { vi.advanceTimersByTime(350); });

    expect(result.current.params.apiParams.search).toBe('tolkien');
    expect(result.current.state.isSearching).toBe(true);
  });

  it('sort field and direction update apiParams', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => {
      result.current.actions.setSortField('title');
      result.current.actions.setSortDirection('asc');
    });

    expect(result.current.params.apiParams.sortField).toBe('title');
    expect(result.current.params.apiParams.sortDirection).toBe('asc');
  });

  it('pagination resets when status filter changes', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.params.pagination.setPage(2); });
    expect(result.current.params.pagination.page).toBe(2);

    act(() => { result.current.actions.setStatusFilter('wanted'); });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('pagination resets when search query changes', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.params.pagination.setPage(3); });
    act(() => { result.current.actions.setSearchQuery('foo'); });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('pagination resets when sort changes', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => { result.current.params.pagination.setPage(2); });
    act(() => { result.current.actions.setSortField('title'); });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('tracks active filter count for client-side filters', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    expect(result.current.counts.activeFilterCount).toBe(0);

    act(() => { result.current.actions.setAuthorFilter('Author A'); });
    expect(result.current.counts.activeFilterCount).toBe(1);

    act(() => { result.current.actions.setSeriesFilter('Series X'); });
    expect(result.current.counts.activeFilterCount).toBe(2);

    act(() => { result.current.actions.setNarratorFilter('Michael Kramer'); });
    expect(result.current.counts.activeFilterCount).toBe(3);
  });

  it('clearAllFilters resets all filter state', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });

    act(() => {
      result.current.actions.setStatusFilter('wanted');
      result.current.actions.setAuthorFilter('Author A');
      result.current.actions.setSeriesFilter('Series X');
      result.current.actions.setSearchQuery('foo');
      result.current.params.pagination.setPage(3);
    });

    act(() => { result.current.actions.clearAllFilters(); });

    expect(result.current.state.statusFilter).toBe('all');
    expect(result.current.state.authorFilter).toBe('');
    expect(result.current.state.seriesFilter).toBe('');
    expect(result.current.state.searchQuery).toBe('');
    expect(result.current.params.pagination.page).toBe(1);
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
    expect(result[0]!.seriesName).toBe('Series X');
  });

  it('filters by narrator', () => {
    const result = applyClientFilters(books, { ...defaultFilters, narratorFilter: 'Michael Kramer' });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(1);
  });

  it('collapse series groups books', () => {
    const seriesBooks: BookWithAuthor[] = [
      createMockBook({ id: 10, seriesName: 'Stormlight', seriesPosition: 1, createdAt: '2024-01-01T00:00:00Z' }),
      createMockBook({ id: 11, seriesName: 'Stormlight', seriesPosition: 2, createdAt: '2024-01-02T00:00:00Z' }),
      createMockBook({ id: 12, seriesName: null, createdAt: '2024-01-03T00:00:00Z' }),
    ];
    const result = applyClientFilters(seriesBooks, { ...defaultFilters, collapseSeriesEnabled: true });
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
      authorFilter: 'Author B', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(10);
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
      authorFilter: '', seriesFilter: '', narratorFilter: 'Kate Reading', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(11);
  });

  it('author filter does not match book where no author matches', () => {
    const book = createMockBook({
      id: 12,
      authors: [{ id: 1, name: 'Author A', slug: 'author-a' }],
      createdAt: '2024-01-01T00:00:00Z',
    });
    const result = applyClientFilters([book], {
      authorFilter: 'Author Z', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const,
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
      authorFilter: '', seriesFilter: '', narratorFilter: 'Kate Reading', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const,
    });
    expect(result).toHaveLength(0);
  });
});

describe('applyClientFilters case-insensitive (issue #79)', () => {
  const defaultFilters = { authorFilter: '', seriesFilter: '', narratorFilter: '', collapseSeriesEnabled: false, sortField: 'createdAt' as const, sortDirection: 'desc' as const };

  it('author filter matches book with different casing', () => {
    const book = createMockBook({
      id: 20, createdAt: '2024-01-01T00:00:00Z',
      authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
    });
    const result = applyClientFilters([book], { ...defaultFilters, authorFilter: 'brandon sanderson' });
    expect(result).toHaveLength(1);
  });

  it('series filter matches book with different casing', () => {
    const book = createMockBook({
      id: 21, createdAt: '2024-01-01T00:00:00Z',
      seriesName: 'The Stormlight Archive',
    });
    const result = applyClientFilters([book], { ...defaultFilters, seriesFilter: 'the stormlight archive' });
    expect(result).toHaveLength(1);
  });

  it('narrator filter regression-free after refactor (case-insensitive behavior preserved)', () => {
    const book = createMockBook({
      id: 22, createdAt: '2024-01-01T00:00:00Z',
      narrators: [{ id: 1, name: 'Kate Reading', slug: 'kate-reading' }],
    });
    const result = applyClientFilters([book], { ...defaultFilters, narratorFilter: 'KATE READING' });
    expect(result).toHaveLength(1);
  });
});

describe('grouped return shape (REACT-1 refactor)', () => {
  it('returned object has state, actions, counts, params keys with no top-level leaked values', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('actions');
    expect(result.current).toHaveProperty('counts');
    expect(result.current).toHaveProperty('params');
    expect(result.current).not.toHaveProperty('statusFilter');
    expect(result.current).not.toHaveProperty('apiParams');
    expect(result.current).not.toHaveProperty('activeFilterCount');
    expect(result.current).not.toHaveProperty('filterTabs');
  });

  it('state group contains all filter values and isSearching', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    expect(result.current.state).toMatchObject({
      statusFilter: 'all',
      authorFilter: '',
      seriesFilter: '',
      narratorFilter: '',
      sortField: 'createdAt',
      sortDirection: 'desc',
      filtersOpen: false,
      collapseSeriesEnabled: false,
      searchQuery: '',
      isSearching: false,
    });
  });

  it('state.isSearching reflects searchQuery truthiness', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    expect(result.current.state.isSearching).toBe(false);
    act(() => { result.current.actions.setSearchQuery('tolkien'); });
    expect(result.current.state.isSearching).toBe(true);
    act(() => { result.current.actions.clearSearch(); });
    expect(result.current.state.isSearching).toBe(false);
  });

  it('actions group contains all setters plus clearSearch and clearAllFilters', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    const actionNames = ['setStatusFilter', 'setAuthorFilter', 'setSeriesFilter', 'setNarratorFilter',
      'setSortField', 'setSortDirection', 'setFiltersOpen', 'setCollapseSeriesEnabled',
      'setSearchQuery', 'clearSearch', 'clearAllFilters'] as const;
    for (const name of actionNames) {
      expect(typeof result.current.actions[name]).toBe('function');
    }
  });

  it('counts group contains activeFilterCount with correct value', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    expect(result.current.counts).toHaveProperty('activeFilterCount');
    expect(result.current.counts.activeFilterCount).toBe(0);
    act(() => { result.current.actions.setAuthorFilter('Tolkien'); });
    expect(result.current.counts.activeFilterCount).toBe(1);
  });

  it('params group contains apiParams, pagination, and filterTabs', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper() });
    expect(result.current.params).toHaveProperty('apiParams');
    expect(result.current.params).toHaveProperty('pagination');
    expect(result.current.params).toHaveProperty('filterTabs');
    expect(result.current.params.apiParams).toMatchObject({
      sortField: 'createdAt',
      sortDirection: 'desc',
    });
  });
});

describe('useLibraryFilters — URL param initialization', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('initializes statusFilter from ?status=wanted', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?status=wanted') });
    expect(result.current.state.statusFilter).toBe('wanted');
    expect(result.current.params.apiParams.status).toBe('wanted');
  });

  it('falls back to default for invalid ?status=bogus', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?status=bogus') });
    expect(result.current.state.statusFilter).toBe('all');
  });

  it('initializes sortField from ?sortField=title', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortField=title') });
    expect(result.current.state.sortField).toBe('title');
    expect(result.current.params.apiParams.sortField).toBe('title');
  });

  it('falls back to default for invalid ?sortField=bogus', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortField=bogus') });
    expect(result.current.state.sortField).toBe('createdAt');
  });

  it('initializes sortDirection from ?sortDirection=asc', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortDirection=asc') });
    expect(result.current.state.sortDirection).toBe('asc');
    expect(result.current.params.apiParams.sortDirection).toBe('asc');
  });

  it('falls back to default for invalid ?sortDirection=bogus', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortDirection=bogus') });
    expect(result.current.state.sortDirection).toBe('desc');
  });

  it('initializes page from ?page=3 with correct offset on first render', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?page=3') });
    // Page must be synchronous (no effect flush) so the first API fetch uses the right offset
    expect(result.current.params.pagination.page).toBe(3);
    expect(result.current.params.pagination.offset).toBe(200);
    expect(result.current.params.apiParams.offset).toBe(200);
  });

  it('falls back to page 1 for ?page=abc', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?page=abc') });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('falls back to page 1 for ?page=0', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?page=0') });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('falls back to page 1 for ?page=-1', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?page=-1') });
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('initializes search from ?search=tolkien', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?search=tolkien') });
    expect(result.current.state.searchQuery).toBe('tolkien');
    expect(result.current.params.apiParams.search).toBe('tolkien');
  });

  it('decodes special characters in ?search param', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?search=tolkien%20%26%20lewis') });
    expect(result.current.state.searchQuery).toBe('tolkien & lewis');
  });

  it('initializes authorFilter from ?author=Sanderson', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?author=Sanderson') });
    expect(result.current.state.authorFilter).toBe('Sanderson');
  });

  it('initializes seriesFilter from ?series=Stormlight', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?series=Stormlight') });
    expect(result.current.state.seriesFilter).toBe('Stormlight');
  });

  it('initializes narratorFilter from ?narrator=Kramer', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?narrator=Kramer') });
    expect(result.current.state.narratorFilter).toBe('Kramer');
  });

  it('initializes collapseSeriesEnabled from ?collapse=true', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?collapse=true') });
    expect(result.current.state.collapseSeriesEnabled).toBe(true);
  });

  it('initializes all defaults when no URL params present', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library') });
    expect(result.current.state.statusFilter).toBe('all');
    expect(result.current.state.sortField).toBe('createdAt');
    expect(result.current.state.sortDirection).toBe('desc');
    expect(result.current.state.searchQuery).toBe('');
    expect(result.current.state.authorFilter).toBe('');
    expect(result.current.state.seriesFilter).toBe('');
    expect(result.current.state.narratorFilter).toBe('');
    expect(result.current.state.collapseSeriesEnabled).toBe(false);
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('initializes multiple params simultaneously', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createWrapper('/library?status=imported&sortField=title&sortDirection=asc&author=Sanderson&collapse=true'),
    });
    expect(result.current.state.statusFilter).toBe('imported');
    expect(result.current.state.sortField).toBe('title');
    expect(result.current.state.sortDirection).toBe('asc');
    expect(result.current.state.authorFilter).toBe('Sanderson');
    expect(result.current.state.collapseSeriesEnabled).toBe(true);
  });

  it('ignores empty ?search= param (treats as default)', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?search=') });
    expect(result.current.state.searchQuery).toBe('');
    expect(result.current.params.apiParams.search).toBeUndefined();
  });
});

describe('useLibraryFilters — URL param sync on state change', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    urlRef.current = '';
  });
  afterEach(() => { vi.useRealTimers(); });

  it('writes status to URL when setStatusFilter called with non-default', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setStatusFilter('wanted'); });
    expect(urlRef.current).toContain('status=wanted');
  });

  it('removes status from URL when set back to all (default)', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?status=wanted') });
    act(() => { result.current.actions.setStatusFilter('all'); });
    expect(urlRef.current).not.toContain('status=');
  });

  it('writes sortField to URL when changed from default', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setSortField('title'); });
    expect(urlRef.current).toContain('sortField=title');
  });

  it('removes sortField from URL when set back to createdAt (default)', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?sortField=title') });
    act(() => { result.current.actions.setSortField('createdAt'); });
    expect(urlRef.current).not.toContain('sortField=');
  });

  it('writes sortDirection to URL when changed from default', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setSortDirection('asc'); });
    expect(urlRef.current).toContain('sortDirection=asc');
  });

  it('removes sortDirection from URL when set back to desc (default)', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?sortDirection=asc') });
    act(() => { result.current.actions.setSortDirection('desc'); });
    expect(urlRef.current).not.toContain('sortDirection=');
  });

  it('writes page to URL when pagination changes', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.params.pagination.setPage(3); });
    expect(urlRef.current).toContain('page=3');
  });

  it('removes page from URL when reset to 1', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?page=3') });
    act(() => { result.current.params.pagination.reset(); });
    expect(urlRef.current).not.toContain('page=');
  });

  it('writes author to URL when setAuthorFilter called', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setAuthorFilter('Sanderson'); });
    expect(urlRef.current).toContain('author=Sanderson');
  });

  it('writes series to URL when setSeriesFilter called', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setSeriesFilter('Stormlight'); });
    expect(urlRef.current).toContain('series=Stormlight');
  });

  it('writes narrator to URL when setNarratorFilter called', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setNarratorFilter('Kramer'); });
    expect(urlRef.current).toContain('narrator=Kramer');
  });

  it('writes collapse=true to URL when enabled', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setCollapseSeriesEnabled(true); });
    expect(urlRef.current).toContain('collapse=true');
  });

  it('removes collapse from URL when disabled (default)', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?collapse=true') });
    act(() => { result.current.actions.setCollapseSeriesEnabled(false); });
    expect(urlRef.current).not.toContain('collapse=');
  });

  it('writes only non-default values (clean URL for defaults)', () => {
    renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    expect(urlRef.current).toBe('?');
  });

  it('preserves other params when changing one filter', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createCapturingWrapper('/library?status=wanted&author=Sanderson'),
    });
    act(() => { result.current.actions.setSortField('title'); });
    expect(urlRef.current).toContain('status=wanted');
    expect(urlRef.current).toContain('author=Sanderson');
    expect(urlRef.current).toContain('sortField=title');
  });

  // Replace semantics are tested via mock in useLibraryFilters.replace.test.tsx
  // which mocks useSearchParams to assert { replace: true } is passed at runtime.
});

describe('useLibraryFilters — URL debounce sync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    urlRef.current = '';
  });
  afterEach(() => { vi.useRealTimers(); });

  it('does not write search to URL on every keystroke', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setSearchQuery('tol'); });
    expect(urlRef.current).not.toContain('search=');
  });

  it('writes debounced search value to URL after 300ms', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper() });
    act(() => { result.current.actions.setSearchQuery('tolkien'); });
    act(() => { vi.advanceTimersByTime(350); });
    expect(urlRef.current).toContain('search=tolkien');
  });

  it('removes search from URL when cleared', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?search=tolkien') });
    act(() => { result.current.actions.clearSearch(); });
    expect(urlRef.current).not.toContain('search=');
  });
});

describe('useLibraryFilters — clearAllFilters updated behavior', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('resets sortField to createdAt', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortField=title') });
    act(() => { result.current.actions.clearAllFilters(); });
    expect(result.current.state.sortField).toBe('createdAt');
  });

  it('resets sortDirection to desc', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?sortDirection=asc') });
    act(() => { result.current.actions.clearAllFilters(); });
    expect(result.current.state.sortDirection).toBe('desc');
  });

  it('resets collapseSeriesEnabled to false', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createWrapper('/library?collapse=true') });
    act(() => { result.current.actions.clearAllFilters(); });
    expect(result.current.state.collapseSeriesEnabled).toBe(false);
  });

  it('resets status, author, series, narrator, search, and page (existing behavior)', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createWrapper('/library?status=wanted&author=Sanderson&series=Stormlight&narrator=Kramer&search=test&page=3'),
    });
    act(() => { result.current.actions.clearAllFilters(); });
    expect(result.current.state.statusFilter).toBe('all');
    expect(result.current.state.authorFilter).toBe('');
    expect(result.current.state.seriesFilter).toBe('');
    expect(result.current.state.narratorFilter).toBe('');
    expect(result.current.state.searchQuery).toBe('');
    expect(result.current.params.pagination.page).toBe(1);
  });

  it('produces clean URL with no params after clearAllFilters', () => {
    urlRef.current = '';
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createCapturingWrapper('/library?status=wanted&sortField=title&sortDirection=asc&collapse=true&author=X'),
    });
    act(() => { result.current.actions.clearAllFilters(); });
    expect(urlRef.current).toBe('?');
  });
});

describe('useLibraryFilters — filter interactions with URL', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    urlRef.current = '';
  });
  afterEach(() => { vi.useRealTimers(); });

  it('setting status filter resets page to 1 in URL', () => {
    const { result } = renderHook(() => useLibraryFilters(), { wrapper: createCapturingWrapper('/library?page=3') });
    act(() => { result.current.actions.setStatusFilter('wanted'); });
    expect(urlRef.current).toContain('status=wanted');
    expect(urlRef.current).not.toContain('page=');
  });

  it('changing sort field preserves other active filters in URL', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createCapturingWrapper('/library?status=wanted&author=Sanderson'),
    });
    act(() => { result.current.actions.setSortField('title'); });
    expect(urlRef.current).toContain('status=wanted');
    expect(urlRef.current).toContain('author=Sanderson');
    expect(urlRef.current).toContain('sortField=title');
  });

  it('clearing search preserves other active filters in URL', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createCapturingWrapper('/library?status=wanted&search=tolkien'),
    });
    act(() => { result.current.actions.clearSearch(); });
    expect(urlRef.current).toContain('status=wanted');
    expect(urlRef.current).not.toContain('search=');
  });
});

describe('useLibraryFilters — error isolation', () => {
  it('handles malformed URL params without crashing (all fall back to defaults)', () => {
    const { result } = renderHook(() => useLibraryFilters(), {
      wrapper: createWrapper('/library?status=invalid&sortField=nope&sortDirection=wrong&page=abc&collapse=maybe'),
    });
    expect(result.current.state.statusFilter).toBe('all');
    expect(result.current.state.sortField).toBe('createdAt');
    expect(result.current.state.sortDirection).toBe('desc');
    expect(result.current.state.collapseSeriesEnabled).toBe(false);
    expect(result.current.params.pagination.page).toBe(1);
  });
});
