import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import type { BookListParams, BookWithAuthor } from '@/lib/api';
import { type StatusFilter, type SortField, type SortDirection, type DisplayBook, filterTabs, collapseSeries } from './helpers.js';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';
import { usePagination } from '@/hooks/usePagination';

export function useLibraryFilters() {
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('');
  const [narratorFilter, setNarratorFilter] = useState('');
  const [sortField, setSortFieldState] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirectionState] = useState<SortDirection>('desc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapseSeriesEnabled, setCollapseSeriesEnabled] = useState(false);
  const [searchQuery, setSearchQueryState] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const pagination = usePagination(DEFAULT_LIMITS.books);

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
    setStatusFilterState('all');
    setAuthorFilter('');
    setSeriesFilter('');
    setNarratorFilter('');
    setSearchQueryState('');
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
