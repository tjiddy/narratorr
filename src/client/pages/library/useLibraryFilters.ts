import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { BookListParams, BookWithAuthor } from '@/lib/api';
import { type StatusFilter, type SortField, type SortDirection, type DisplayBook, filterTabs, collapseSeries } from './helpers.js';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';
import { usePagination } from '@/hooks/usePagination';

const VALID_STATUS_FILTERS = new Set<string>(['all', 'wanted', 'downloading', 'imported', 'failed', 'missing']);
const VALID_SORT_FIELDS = new Set<string>(['createdAt', 'title', 'author', 'narrator', 'series', 'quality', 'size', 'format']);
const VALID_SORT_DIRECTIONS = new Set<string>(['asc', 'desc']);

const DEFAULTS = {
  status: 'all' as StatusFilter,
  sortField: 'createdAt' as SortField,
  sortDirection: 'desc' as SortDirection,
  search: '',
  author: '',
  series: '',
  narrator: '',
  collapse: false,
  page: 1,
} as const;

function parseStatus(value: string | null): StatusFilter {
  return value && VALID_STATUS_FILTERS.has(value) ? value as StatusFilter : DEFAULTS.status;
}

function parseSortField(value: string | null): SortField {
  return value && VALID_SORT_FIELDS.has(value) ? value as SortField : DEFAULTS.sortField;
}

function parseSortDirection(value: string | null): SortDirection {
  return value && VALID_SORT_DIRECTIONS.has(value) ? value as SortDirection : DEFAULTS.sortDirection;
}

function parsePage(value: string | null): number {
  if (!value) return DEFAULTS.page;
  const num = parseInt(value, 10);
  return Number.isFinite(num) && num >= 1 ? num : DEFAULTS.page;
}

export function useLibraryFilters() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Initialize state from URL params (synchronous, first render only)
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>(() => parseStatus(searchParams.get('status')));
  const [authorFilter, setAuthorFilter] = useState(() => searchParams.get('author') ?? DEFAULTS.author);
  const [seriesFilter, setSeriesFilter] = useState(() => searchParams.get('series') ?? DEFAULTS.series);
  const [narratorFilter, setNarratorFilter] = useState(() => searchParams.get('narrator') ?? DEFAULTS.narrator);
  const [sortField, setSortFieldState] = useState<SortField>(() => parseSortField(searchParams.get('sortField')));
  const [sortDirection, setSortDirectionState] = useState<SortDirection>(() => parseSortDirection(searchParams.get('sortDirection')));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapseSeriesEnabled, setCollapseSeriesEnabled] = useState(() => searchParams.get('collapse') === 'true');
  const [searchQuery, setSearchQueryState] = useState(() => searchParams.get('search') ?? DEFAULTS.search);
  const [debouncedSearch, setDebouncedSearch] = useState(() => searchParams.get('search') ?? DEFAULTS.search);

  const initialPage = parsePage(searchParams.get('page'));
  const pagination = usePagination(DEFAULT_LIMITS.books);

  // Set initial page from URL (only on mount)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && initialPage > 1) {
      pagination.setPage(initialPage);
      initializedRef.current = true;
    }
  }, [initialPage, pagination]);

  // Sync state → URL params (replaceState to avoid back-button noise)
  useEffect(() => {
    const params = new URLSearchParams();

    if (statusFilter !== DEFAULTS.status) params.set('status', statusFilter);
    if (sortField !== DEFAULTS.sortField) params.set('sortField', sortField);
    if (sortDirection !== DEFAULTS.sortDirection) params.set('sortDirection', sortDirection);
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (authorFilter) params.set('author', authorFilter);
    if (seriesFilter) params.set('series', seriesFilter);
    if (narratorFilter) params.set('narrator', narratorFilter);
    if (collapseSeriesEnabled) params.set('collapse', 'true');
    if (pagination.page > 1) params.set('page', String(pagination.page));

    setSearchParams(params, { replace: true });
  }, [statusFilter, sortField, sortDirection, debouncedSearch, authorFilter, seriesFilter, narratorFilter, collapseSeriesEnabled, pagination.page, setSearchParams]);

  // Debounce search to avoid rapid API calls per keystroke
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQuery]);

  // Reset pagination when filters change
  const setStatusFilter = useCallback((status: StatusFilter) => {
    setStatusFilterState(status);
    pagination.reset();
  }, [pagination]);

  const setSortField = useCallback((field: SortField) => {
    setSortFieldState(field);
    pagination.reset();
  }, [pagination]);

  const setSortDirection = useCallback((dir: SortDirection) => {
    setSortDirectionState(dir);
    pagination.reset();
  }, [pagination]);

  const setSearchQuery = useCallback((query: string) => {
    setSearchQueryState(query);
    pagination.reset();
  }, [pagination]);

  const clearSearch = useCallback(() => {
    setSearchQueryState('');
    setDebouncedSearch(''); // Immediately clear debounced value
    pagination.reset();
  }, [pagination]);

  // Build API params from filter state (search is debounced)
  const apiParams: BookListParams = useMemo(() => ({
    status: statusFilter === 'all' ? undefined : statusFilter,
    search: debouncedSearch || undefined,
    sortField,
    sortDirection,
    limit: pagination.limit,
    offset: pagination.offset,
  }), [statusFilter, debouncedSearch, sortField, sortDirection, pagination.limit, pagination.offset]);

  const activeFilterCount = (authorFilter ? 1 : 0) + (seriesFilter ? 1 : 0) + (narratorFilter ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilterState(DEFAULTS.status);
    setAuthorFilter(DEFAULTS.author);
    setSeriesFilter(DEFAULTS.series);
    setNarratorFilter(DEFAULTS.narrator);
    setSearchQueryState(DEFAULTS.search);
    setDebouncedSearch(DEFAULTS.search);
    setSortFieldState(DEFAULTS.sortField);
    setSortDirectionState(DEFAULTS.sortDirection);
    setCollapseSeriesEnabled(DEFAULTS.collapse);
    pagination.reset();
  };

  return {
    state: {
      statusFilter,
      authorFilter,
      seriesFilter,
      narratorFilter,
      sortField,
      sortDirection,
      filtersOpen,
      collapseSeriesEnabled,
      searchQuery,
      isSearching: !!searchQuery,
    },
    actions: {
      setStatusFilter,
      setAuthorFilter,
      setSeriesFilter,
      setNarratorFilter,
      setSortField,
      setSortDirection,
      setFiltersOpen,
      setCollapseSeriesEnabled,
      setSearchQuery,
      clearSearch,
      clearAllFilters,
    },
    counts: {
      activeFilterCount,
    },
    params: {
      apiParams,
      pagination,
      filterTabs,
    },
  };
}

/** Apply client-side author/series/narrator filters and series collapse to page data */
export function applyClientFilters(
  books: BookWithAuthor[],
  filters: { authorFilter: string; seriesFilter: string; narratorFilter: string; collapseSeriesEnabled: boolean; sortField: SortField; sortDirection: SortDirection },
): DisplayBook[] {
  let result = books;
  if (filters.authorFilter) {
    const authorLower = filters.authorFilter.toLowerCase();
    result = result.filter((b) => b.authors?.some((a) => a.name.toLowerCase() === authorLower));
  }
  if (filters.seriesFilter) {
    const seriesLower = filters.seriesFilter.toLowerCase();
    result = result.filter((b) => b.seriesName?.toLowerCase() === seriesLower);
  }
  if (filters.narratorFilter) {
    const filterLower = filters.narratorFilter.toLowerCase();
    result = result.filter((b) =>
      b.narrators.some((n) => n.name.toLowerCase() === filterLower),
    );
  }
  if (filters.collapseSeriesEnabled) {
    return collapseSeries(result, filters.sortField, filters.sortDirection);
  }
  return result;
}
