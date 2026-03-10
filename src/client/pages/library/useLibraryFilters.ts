import { useState, useMemo } from 'react';
import type { BookWithAuthor } from '@/lib/api';
import { useLibrarySearch } from '@/hooks/useLibrarySearch';
import { type StatusFilter, type SortField, type SortDirection, type DisplayBook, filterTabs, matchesStatusFilter, getStatusCount, sortBooks, collapseSeries, extractNarrators } from './helpers.js';

export function useLibraryFilters(books: BookWithAuthor[]) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('');
  const [narratorFilter, setNarratorFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapseSeriesEnabled, setCollapseSeriesEnabled] = useState(false);

  const { query: searchQuery, setQuery: setSearchQuery, clearQuery: clearSearch, results: searchResults, isSearching } = useLibrarySearch(books);

  const uniqueAuthors = useMemo(() => {
    const names = new Set<string>();
    for (const book of books) {
      if (book.author?.name) names.add(book.author.name);
    }
    return Array.from(names).sort();
  }, [books]);

  const uniqueSeries = useMemo(() => {
    const names = new Set<string>();
    for (const book of books) {
      if (book.seriesName) names.add(book.seriesName);
    }
    return Array.from(names).sort();
  }, [books]);

  const uniqueNarrators = useMemo(() => {
    const seen = new Map<string, string>();
    for (const book of books) {
      for (const narrator of extractNarrators(book.narrator)) {
        const lower = narrator.toLowerCase();
        if (!seen.has(lower)) seen.set(lower, narrator);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [books]);

  const filteredBooks = useMemo((): DisplayBook[] => {
    let result: BookWithAuthor[] = searchResults.filter((b) => matchesStatusFilter(b.status, statusFilter));
    if (authorFilter) {
      result = result.filter((b) => b.author?.name === authorFilter);
    }
    if (seriesFilter) {
      result = result.filter((b) => b.seriesName === seriesFilter);
    }
    if (narratorFilter) {
      const filterLower = narratorFilter.toLowerCase();
      result = result.filter((b) => {
        const narrators = extractNarrators(b.narrator);
        return narrators.some((n) => n.toLowerCase() === filterLower);
      });
    }
    const toSort = collapseSeriesEnabled
      ? collapseSeries(result, sortField, sortDirection)
      : result;
    return sortBooks(toSort, sortField, sortDirection);
  }, [searchResults, statusFilter, authorFilter, seriesFilter, narratorFilter, sortField, sortDirection, collapseSeriesEnabled]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: books.length, wanted: 0, downloading: 0, imported: 0 };
    for (const tab of filterTabs) {
      if (tab.key !== 'all') counts[tab.key] = getStatusCount(books, tab.key);
    }
    return counts;
  }, [books]);

  const activeFilterCount = (authorFilter ? 1 : 0) + (seriesFilter ? 1 : 0) + (narratorFilter ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilter('all');
    setAuthorFilter('');
    setSeriesFilter('');
    setNarratorFilter('');
    clearSearch();
  };

  return {
    statusFilter, setStatusFilter,
    authorFilter, setAuthorFilter,
    seriesFilter, setSeriesFilter,
    narratorFilter, setNarratorFilter,
    sortField, setSortField,
    sortDirection, setSortDirection,
    filtersOpen, setFiltersOpen,
    collapseSeriesEnabled, setCollapseSeriesEnabled,
    searchQuery, setSearchQuery, clearSearch,
    isSearching,
    uniqueAuthors, uniqueSeries, uniqueNarrators,
    filteredBooks, statusCounts,
    activeFilterCount, clearAllFilters,
  };
}
