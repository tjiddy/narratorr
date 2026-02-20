import { useState, useMemo } from 'react';
import type { BookWithAuthor } from '@/lib/api';
import { useLibrarySearch } from '@/hooks/useLibrarySearch';
import { type StatusFilter, type SortField, type SortDirection, filterTabs, matchesStatusFilter, getStatusCount, sortBooks } from './helpers.js';

export function useLibraryFilters(books: BookWithAuthor[]) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [filtersOpen, setFiltersOpen] = useState(false);

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

  const filteredBooks = useMemo(() => {
    let result = searchResults.filter((b) => matchesStatusFilter(b.status, statusFilter));
    if (authorFilter) {
      result = result.filter((b) => b.author?.name === authorFilter);
    }
    if (seriesFilter) {
      result = result.filter((b) => b.seriesName === seriesFilter);
    }
    return sortBooks(result, sortField, sortDirection);
  }, [searchResults, statusFilter, authorFilter, seriesFilter, sortField, sortDirection]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: books.length, wanted: 0, downloading: 0, imported: 0 };
    for (const tab of filterTabs) {
      if (tab.key !== 'all') counts[tab.key] = getStatusCount(books, tab.key);
    }
    return counts;
  }, [books]);

  const activeFilterCount = (authorFilter ? 1 : 0) + (seriesFilter ? 1 : 0);

  const clearAllFilters = () => {
    setStatusFilter('all');
    setAuthorFilter('');
    setSeriesFilter('');
    clearSearch();
  };

  return {
    statusFilter, setStatusFilter,
    authorFilter, setAuthorFilter,
    seriesFilter, setSeriesFilter,
    sortField, setSortField,
    sortDirection, setSortDirection,
    filtersOpen, setFiltersOpen,
    searchQuery, setSearchQuery, clearSearch,
    isSearching,
    uniqueAuthors, uniqueSeries,
    filteredBooks, statusCounts,
    activeFilterCount, clearAllFilters,
  };
}
