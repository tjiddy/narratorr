import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useLibrary, useBookStats } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { DisplayBook, SortField } from './helpers.js';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { LibraryModals } from './LibraryModals.js';
import { LoadingSpinner } from '@/components/icons';
import { useImportPolling } from './useImportPolling.js';
import { useLibraryFilters, applyClientFilters } from './useLibraryFilters.js';
import { useLibraryMutations } from './useLibraryMutations.js';
import { useLibraryBulkActions } from './useLibraryBulkActions.js';
import { LibraryToolbar, type ViewMode } from './LibraryToolbar.js';
import { LibraryBookCard } from './LibraryBookCard.js';
import { LibraryTableView } from './LibraryTableView.js';
import { BulkActionToolbar } from './BulkActionToolbar.js';
import { EmptyLibraryState } from './EmptyLibraryState.js';
import { NoMatchState } from './NoMatchState.js';
import { LibraryHeader } from './LibraryHeader.js';
import { Pagination } from '@/components/Pagination';

const VIEW_STORAGE_KEY = 'narratorr:library-view';
const TABLE_ONLY_SORTS: SortField[] = ['quality', 'size', 'format'];

function getInitialViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'grid' || stored === 'table') return stored;
  } catch { /* localStorage unavailable */ }
  return 'grid';
}

// eslint-disable-next-line max-lines-per-function, complexity -- page orchestrator with pagination, stats, filters, bulk actions
export function LibraryPage() {
  const navigate = useNavigate();
  const filters = useLibraryFilters();
  const { data: libraryResponse, isLoading, isPlaceholderData } = useLibrary(filters.params.apiParams);
  const { data: stats } = useBookStats();
  const { data: settings } = useQuery({ queryKey: queryKeys.settings(), queryFn: api.getSettings });

  const books = useMemo(() => libraryResponse?.data ?? [], [libraryResponse]);
  const totalBooks = libraryResponse?.total ?? 0;

  // Settled-gated grid key: holds old sort params during placeholderData phase,
  // updates only when the sorted response settles. This ensures the grid remounts
  // (replaying entrance animations) only after the new sort order arrives.
  // Pattern: "adjusting state when a prop changes" — React re-renders before commit.
  const currentSortKey = `${filters.state.sortField}-${filters.state.sortDirection}`;
  const [settledGridKey, setSettledGridKey] = useState(currentSortKey);
  if (!isPlaceholderData && settledGridKey !== currentSortKey) {
    setSettledGridKey(currentSortKey);
  }

  // Clamp page when total shrinks (e.g., after deleting last item on a page)
  useEffect(() => {
    filters.params.pagination.clampToTotal(totalBooks);
  }, [totalBooks, filters.params.pagination]);

  useImportPolling(books);

  // Apply client-side filters (author/series/narrator/collapse) to page data
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

  // Status counts and global action counts from stats endpoint
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
  const bp = totalAll !== 1 ? 's' : '';
  const subtitle = filters.state.isSearching
    ? `${totalBooks} result${totalBooks !== 1 ? 's' : ''}`
    : `${totalAll} book${bp} in your collection`;
  const searchAllWantedMessage = `Search ${wantedCount} wanted book${wantedCount !== 1 ? 's' : ''} across ${enabledIndexerCount} enabled indexer${enabledIndexerCount !== 1 ? 's' : ''} (~${wantedCount * enabledIndexerCount} API calls)?`;
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

  // Filter dropdowns from stats endpoint
  const uniqueAuthors = stats?.authors ?? [];
  const uniqueSeries = stats?.series ?? [];
  const uniqueNarrators = stats?.narrators ?? [];

  if (isLoading) return (
    <div className="space-y-6">
      <LibraryHeader />
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    </div>
  );
  if (totalAll === 0 && !filters.state.isSearching && filters.state.statusFilter === 'all') return (
    <div className="space-y-6">
      <LibraryHeader />
      <EmptyLibraryState hasLibraryPath={Boolean(settings?.library.path)} />
    </div>
  );

  const filterProps = {
    authorFilter: filters.state.authorFilter, onAuthorFilterChange: filters.actions.setAuthorFilter, uniqueAuthors,
    seriesFilter: filters.state.seriesFilter, onSeriesFilterChange: filters.actions.setSeriesFilter, uniqueSeries,
    narratorFilter: filters.state.narratorFilter, onNarratorFilterChange: filters.actions.setNarratorFilter, uniqueNarrators,
  };
  const sortProps = {
    sortField: filters.state.sortField, onSortFieldChange: filters.actions.setSortField,
    sortDirection: filters.state.sortDirection, onSortDirectionChange: filters.actions.setSortDirection,
  };

  return (
    <div className="space-y-5">
      <LibraryHeader subtitle={subtitle} />

      <LibraryToolbar
        searchQuery={filters.state.searchQuery}
        onSearchChange={filters.actions.setSearchQuery}
        onSearchClear={filters.actions.clearSearch}
        statusFilter={filters.state.statusFilter}
        onStatusFilterChange={filters.actions.setStatusFilter}
        statusCounts={statusCounts}
        filtersOpen={filters.state.filtersOpen}
        onFiltersToggle={() => filters.actions.setFiltersOpen(!filters.state.filtersOpen)}
        activeFilterCount={filters.counts.activeFilterCount}
        filterProps={filterProps}
        sortProps={sortProps}
        collapseSeriesEnabled={filters.state.collapseSeriesEnabled}
        onCollapseSeriesToggle={() => filters.actions.setCollapseSeriesEnabled(!filters.state.collapseSeriesEnabled)}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        onRescan={() => rescanMutation.mutate()}
        isRescanning={rescanMutation.isPending}
        missingCount={missingCount}
        onRemoveMissing={() => setShowRemoveMissingModal(true)}
        onSearchAllWanted={() => setShowSearchAllWantedModal(true)}
        isSearchingAllWanted={searchAllWantedMutation.isPending}
      />

      {viewMode === 'table' && bulk.selectedIds.size > 0 && (
        <BulkActionToolbar
          selectedCount={bulk.selectedIds.size}
          onDelete={(df) => bulk.bulkDeleteMutation.mutate({ deleteFiles: df })}
          isDeleting={bulk.bulkDeleteMutation.isPending}
          onSearch={() => bulk.bulkSearchMutation.mutate()}
          isSearching={bulk.bulkSearchMutation.isPending}
          onSetStatus={(status, label) => bulk.bulkSetStatusMutation.mutate({ status, label })}
          isSettingStatus={bulk.bulkSetStatusMutation.isPending}
          hasPath={anySelectedHasPath}
          fileCount={bulkFileCount}
        />
      )}

      {displayBooks.length === 0 ? (
        <NoMatchState onClearFilters={filters.actions.clearAllFilters} />
      ) : viewMode === 'table' ? (
        <LibraryTableView
          books={displayBooks}
          selectedIds={bulk.selectedIds}
          onSelectionChange={bulk.setSelectedIds}
          sortField={filters.state.sortField}
          sortDirection={filters.state.sortDirection}
          onSortFieldChange={filters.actions.setSortField}
          onSortDirectionChange={filters.actions.setSortDirection}
        />
      ) : (
        <div key={settledGridKey} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {displayBooks.map((book: DisplayBook, index) => (
            <LibraryBookCard
              key={book.id}
              book={book}
              index={index}
              collapsedCount={book.collapsedCount}
              isMenuOpen={openMenuId === book.id}
              onMenuToggle={handleCardMenuToggle}
              onMenuClose={closeMenu}
              onClick={handleCardClick}
              onSearchReleases={handleCardSearchReleases}
              onRemove={handleCardRemove}
            />
          ))}
        </div>
      )}

      <Pagination
        page={filters.params.pagination.page}
        totalPages={filters.params.pagination.totalPages(totalBooks)}
        total={totalBooks}
        limit={filters.params.pagination.limit}
        onPageChange={filters.params.pagination.setPage}
      />

      <LibraryModals
        deleteTarget={deleteConfirm.target}
        isDeleteOpen={deleteConfirm.isOpen}
        onDeleteConfirm={(df) => { const item = deleteConfirm.confirm(); if (item) deleteMutation.mutate({ id: item.id, deleteFiles: df }); }}
        onDeleteCancel={() => { deleteConfirm.cancel(); }}
        showRemoveMissingModal={showRemoveMissingModal}
        missingCount={missingCount}
        onRemoveMissingConfirm={() => { setShowRemoveMissingModal(false); deleteMissingMutation.mutate(); }}
        onRemoveMissingCancel={() => setShowRemoveMissingModal(false)}
        showSearchAllWantedModal={showSearchAllWantedModal}
        searchAllWantedMessage={searchAllWantedMessage}
        onSearchAllWantedConfirm={() => { setShowSearchAllWantedModal(false); searchAllWantedMutation.mutate(); }}
        onSearchAllWantedCancel={() => setShowSearchAllWantedModal(false)}
        searchBook={searchBook}
        onSearchBookClose={() => setSearchBook(null)}
      />
    </div>
  );
}
