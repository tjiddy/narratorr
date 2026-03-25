import { useState, useCallback, useEffect, useMemo } from 'react';
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
  const { data: libraryResponse, isLoading } = useLibrary(filters.apiParams);
  const { data: stats } = useBookStats();

  const books = useMemo(() => libraryResponse?.data ?? [], [libraryResponse]);
  const totalBooks = libraryResponse?.total ?? 0;

  // Clamp page when total shrinks (e.g., after deleting last item on a page)
  useEffect(() => {
    filters.pagination.clampToTotal(totalBooks);
  }, [totalBooks, filters.pagination]);

  useImportPolling(books);

  // Apply client-side filters (author/series/narrator/collapse) to page data
  const displayBooks = useMemo((): DisplayBook[] =>
    applyClientFilters(books, {
      authorFilter: filters.authorFilter,
      seriesFilter: filters.seriesFilter,
      narratorFilter: filters.narratorFilter,
      collapseSeriesEnabled: filters.collapseSeriesEnabled,
      sortField: filters.sortField,
      sortDirection: filters.sortDirection,
    }),
  [books, filters.authorFilter, filters.seriesFilter, filters.narratorFilter, filters.collapseSeriesEnabled, filters.sortField, filters.sortDirection]);

  const bulk = useLibraryBulkActions(displayBooks);
  const { rescanMutation, deleteMutation, deleteMissingMutation, searchAllWantedMutation } = useLibraryMutations();
  const { data: indexers = [] } = useQuery({ queryKey: queryKeys.indexers(), queryFn: api.getIndexers });
  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [showRemoveMissingModal, setShowRemoveMissingModal] = useState(false);
  const [showSearchAllWantedModal, setShowSearchAllWantedModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    if (mode === 'grid' && TABLE_ONLY_SORTS.includes(filters.sortField)) {
      filters.setSortField('createdAt');
      filters.setSortDirection('desc');
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
  const subtitle = filters.isSearching
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

  const anySelectedHasPath = bulk.selectedBooks.some((b) => b.path);

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
  if (totalAll === 0 && !filters.isSearching && filters.statusFilter === 'all') return (
    <div className="space-y-6">
      <LibraryHeader />
      <EmptyLibraryState />
    </div>
  );

  const filterProps = {
    authorFilter: filters.authorFilter, onAuthorFilterChange: filters.setAuthorFilter, uniqueAuthors,
    seriesFilter: filters.seriesFilter, onSeriesFilterChange: filters.setSeriesFilter, uniqueSeries,
    narratorFilter: filters.narratorFilter, onNarratorFilterChange: filters.setNarratorFilter, uniqueNarrators,
  };
  const sortProps = {
    sortField: filters.sortField, onSortFieldChange: filters.setSortField,
    sortDirection: filters.sortDirection, onSortDirectionChange: filters.setSortDirection,
  };

  return (
    <div className="space-y-5">
      <LibraryHeader subtitle={subtitle} />

      <LibraryToolbar
        searchQuery={filters.searchQuery}
        onSearchChange={filters.setSearchQuery}
        onSearchClear={filters.clearSearch}
        statusFilter={filters.statusFilter}
        onStatusFilterChange={filters.setStatusFilter}
        statusCounts={statusCounts}
        filtersOpen={filters.filtersOpen}
        onFiltersToggle={() => filters.setFiltersOpen(!filters.filtersOpen)}
        activeFilterCount={filters.activeFilterCount}
        filterProps={filterProps}
        sortProps={sortProps}
        collapseSeriesEnabled={filters.collapseSeriesEnabled}
        onCollapseSeriesToggle={() => filters.setCollapseSeriesEnabled(!filters.collapseSeriesEnabled)}
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
        />
      )}

      {displayBooks.length === 0 ? (
        <NoMatchState onClearFilters={filters.clearAllFilters} />
      ) : viewMode === 'table' ? (
        <LibraryTableView
          books={displayBooks}
          selectedIds={bulk.selectedIds}
          onSelectionChange={bulk.setSelectedIds}
          sortField={filters.sortField}
          sortDirection={filters.sortDirection}
          onSortFieldChange={filters.setSortField}
          onSortDirectionChange={filters.setSortDirection}
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {displayBooks.map((book: DisplayBook, index) => (
            <LibraryBookCard
              key={book.id}
              book={book}
              index={index}
              collapsedCount={book.collapsedCount}
              isMenuOpen={openMenuId === book.id}
              onMenuToggle={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === book.id ? null : book.id); }}
              onMenuClose={() => setOpenMenuId(null)}
              onClick={() => navigate(`/books/${book.id}`)}
              onSearchReleases={() => { setSearchBook(book); setOpenMenuId(null); }}
              onRemove={() => { deleteConfirm.requestDelete(book); setOpenMenuId(null); }}
            />
          ))}
        </div>
      )}

      <Pagination
        page={filters.pagination.page}
        totalPages={filters.pagination.totalPages(totalBooks)}
        total={totalBooks}
        limit={filters.pagination.limit}
        onPageChange={filters.pagination.setPage}
      />

      <LibraryModals
        deleteTarget={deleteConfirm.target}
        isDeleteOpen={deleteConfirm.isOpen}
        deleteFiles={deleteFiles}
        onDeleteFilesChange={setDeleteFiles}
        onDeleteConfirm={() => { const item = deleteConfirm.confirm(); if (item) deleteMutation.mutate({ id: item.id, deleteFiles }); setDeleteFiles(false); }}
        onDeleteCancel={() => { deleteConfirm.cancel(); setDeleteFiles(false); }}
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
