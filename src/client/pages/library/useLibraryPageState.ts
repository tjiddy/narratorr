import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useLibrary, useBookStats } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { DisplayBook, SortField } from './helpers.js';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { useImportPolling } from './useImportPolling.js';
import { useLibraryFilters, applyClientFilters } from './useLibraryFilters.js';
import { useLibraryMutations } from './useLibraryMutations.js';
import { useLibraryBulkActions } from './useLibraryBulkActions.js';
import type { ViewMode } from './LibraryToolbar.js';

const VIEW_STORAGE_KEY = 'narratorr:library-view';
const TABLE_ONLY_SORTS: SortField[] = ['quality', 'size', 'format', 'narrator', 'series'];

function getInitialViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'grid' || stored === 'table') return stored;
  } catch { /* localStorage unavailable */ }
  return 'grid';
}

export function useLibraryPageState() {
  const navigate = useNavigate();
  const filters = useLibraryFilters();
  const { data: libraryResponse, isLoading, isPlaceholderData } = useLibrary(filters.params.apiParams);
  const { data: stats } = useBookStats();
  const { data: settings } = useQuery({ queryKey: queryKeys.settings(), queryFn: api.getSettings });

  const books = useMemo(() => libraryResponse?.data ?? [], [libraryResponse]);
  const totalBooks = libraryResponse?.total ?? 0;

  // Settled-gated grid key: holds old sort params during placeholderData phase,
  // updates only when the sorted response settles.
  const currentSortKey = `${filters.state.sortField}-${filters.state.sortDirection}`;
  const [settledGridKey, setSettledGridKey] = useState(currentSortKey);
  if (!isPlaceholderData && settledGridKey !== currentSortKey) {
    setSettledGridKey(currentSortKey);
  }

  useEffect(() => {
    filters.params.pagination.clampToTotal(totalBooks);
  }, [totalBooks, filters.params.pagination]);

  useImportPolling(books);

  const displayBooks = useMemo((): DisplayBook[] =>
    applyClientFilters(books, {
      authorFilter: filters.state.authorFilter,
      seriesFilter: filters.state.seriesFilter,
      narratorFilter: filters.state.narratorFilter,
      collapseSeriesEnabled: filters.state.collapseSeriesEnabled,
      sortField: filters.state.sortField,
      sortDirection: filters.state.sortDirection,
    }),
  [books, filters.state.authorFilter, filters.state.seriesFilter, filters.state.narratorFilter, filters.state.collapseSeriesEnabled, filters.state.sortField, filters.state.sortDirection]);

  const bulk = useLibraryBulkActions(displayBooks);
  const { rescanMutation, deleteMutation, deleteMissingMutation, searchAllWantedMutation } = useLibraryMutations();
  const { data: indexers = [] } = useQuery({ queryKey: queryKeys.indexers(), queryFn: api.getIndexers });
  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [showRemoveMissingModal, setShowRemoveMissingModal] = useState(false);
  const [showSearchAllWantedModal, setShowSearchAllWantedModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'grid' && TABLE_ONLY_SORTS.includes(filters.state.sortField)) {
      filters.actions.setSortField('createdAt');
      filters.actions.setSortDirection('desc');
    }
    setViewMode(mode);
    try { localStorage.setItem(VIEW_STORAGE_KEY, mode); } catch { /* noop */ }
    if (mode === 'grid') bulk.clearSelection();
  }, [bulk, filters]);

  const statusCounts = useMemo(() => {
    if (!stats) return { all: 0, wanted: 0, downloading: 0, imported: 0, failed: 0, missing: 0 };
    const { counts } = stats;
    return {
      all: counts.wanted + counts.downloading + counts.imported + counts.failed + counts.missing,
      ...counts,
    };
  }, [stats]);

  const missingCount = statusCounts.missing;
  const wantedCount = statusCounts.wanted;
  const enabledIndexerCount = useMemo(() => indexers.filter((i) => i.enabled).length, [indexers]);
  const totalAll = statusCounts.all;

  const closeMenu = useCallback(() => setOpenMenuId(null), []);
  useEffect(() => {
    if (openMenuId !== null) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
  }, [openMenuId, closeMenu]);

  const handleCardMenuToggle = useCallback((bookId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenuId(prev => prev === bookId ? null : bookId);
  }, []);

  const handleCardClick = useCallback((bookId: number) => {
    navigate(`/books/${bookId}`);
  }, [navigate]);

  const handleCardSearchReleases = useCallback((book: BookWithAuthor) => {
    setSearchBook(book);
    setOpenMenuId(null);
  }, []);

  const handleCardRemove = useCallback((book: BookWithAuthor) => {
    deleteConfirm.requestDelete(book);
    setOpenMenuId(null);
  }, [deleteConfirm]);

  const anySelectedHasPath = bulk.selectedBooks.some((b) => b.path);
  const bulkFileCount = bulk.selectedBooks.reduce(
    (sum, b) => sum + (b.path && b.audioFileCount && b.audioFileCount > 0 ? b.audioFileCount : 0),
    0,
  );

  const uniqueAuthors = stats?.authors ?? [];
  const uniqueSeries = stats?.series ?? [];
  const uniqueNarrators = stats?.narrators ?? [];

  const bp = totalAll !== 1 ? 's' : '';
  const subtitle = filters.state.isSearching
    ? `${totalBooks} result${totalBooks !== 1 ? 's' : ''}`
    : `${totalAll} book${bp} in your collection`;
  const searchAllWantedMessage = `Search ${wantedCount} wanted book${wantedCount !== 1 ? 's' : ''} across ${enabledIndexerCount} enabled indexer${enabledIndexerCount !== 1 ? 's' : ''} (~${wantedCount * enabledIndexerCount} API calls)?`;

  return {
    filters,
    isLoading,
    totalBooks,
    totalAll,
    displayBooks,
    settledGridKey,
    viewMode,
    openMenuId,
    searchBook,
    settings,
    subtitle,
    searchAllWantedMessage,
    missingCount,
    wantedCount,
    enabledIndexerCount,
    anySelectedHasPath,
    bulkFileCount,
    uniqueAuthors,
    uniqueSeries,
    uniqueNarrators,
    statusCounts,
    bulk,
    deleteConfirm,
    showRemoveMissingModal,
    showSearchAllWantedModal,
    // Mutations
    rescanMutation,
    deleteMutation,
    deleteMissingMutation,
    searchAllWantedMutation,
    // Callbacks
    handleViewModeChange,
    handleCardMenuToggle,
    handleCardClick,
    handleCardSearchReleases,
    handleCardRemove,
    closeMenu,
    setSearchBook,
    setShowRemoveMissingModal,
    setShowSearchAllWantedModal,
  };
}
