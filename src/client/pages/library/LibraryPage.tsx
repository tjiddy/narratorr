import { useState, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useLibrary } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import type { DisplayBook } from './helpers.js';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { LibraryModals } from './LibraryModals.js';
import { LoadingSpinner } from '@/components/icons';
import { useImportPolling } from './useImportPolling.js';
import { useLibraryFilters } from './useLibraryFilters.js';
import { useLibraryMutations } from './useLibraryMutations.js';
import { useLibraryBulkActions } from './useLibraryBulkActions.js';
import { LibraryToolbar, type ViewMode } from './LibraryToolbar.js';
import { LibraryBookCard } from './LibraryBookCard.js';
import { LibraryTableView } from './LibraryTableView.js';
import { BulkActionToolbar } from './BulkActionToolbar.js';
import { EmptyLibraryState } from './EmptyLibraryState.js';
import { NoMatchState } from './NoMatchState.js';
import { LibraryHeader } from './LibraryHeader.js';

const VIEW_STORAGE_KEY = 'narratorr:library-view';

function getInitialViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === 'grid' || stored === 'table') return stored;
  } catch { /* localStorage unavailable */ }
  return 'grid';
}

export function LibraryPage() {
  const navigate = useNavigate();
  const { data: books = [], isLoading } = useLibrary();

  useImportPolling(books);
  const filters = useLibraryFilters(books);
  const { rescanMutation, deleteMutation, deleteMissingMutation, searchAllWantedMutation } = useLibraryMutations();
  const bulk = useLibraryBulkActions(filters.filteredBooks);
  const { data: indexers = [] } = useQuery({ queryKey: queryKeys.indexers(), queryFn: api.getIndexers });
  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [showRemoveMissingModal, setShowRemoveMissingModal] = useState(false);
  const [showSearchAllWantedModal, setShowSearchAllWantedModal] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(getInitialViewMode);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_STORAGE_KEY, mode); } catch { /* noop */ }
    if (mode === 'grid') bulk.clearSelection();
  }, [bulk]);

  const missingCount = books.filter((b) => b.status === 'missing').length;
  const wantedCount = useMemo(() => books.filter((b) => b.status === 'wanted').length, [books]);
  const enabledIndexerCount = useMemo(() => indexers.filter((i) => i.enabled).length, [indexers]);
  const bp = books.length !== 1 ? 's' : '';
  const subtitle = filters.isSearching
    ? `${filters.filteredBooks.length} of ${books.length} book${bp}` : `${books.length} book${bp} in your collection`;
  const searchAllWantedMessage = `Search ${wantedCount} wanted book${wantedCount !== 1 ? 's' : ''} across ${enabledIndexerCount} enabled indexer${enabledIndexerCount !== 1 ? 's' : ''} (~${wantedCount * enabledIndexerCount} API calls)?`;
  const closeMenu = useCallback(() => setOpenMenuId(null), []);
  useEffect(() => {
    if (openMenuId !== null) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
  }, [openMenuId, closeMenu]);

  const anySelectedHasPath = bulk.selectedBooks.some((b) => b.path);

  if (isLoading) return (
    <div className="space-y-6">
      <LibraryHeader />
      <div className="flex items-center justify-center py-24">
        <LoadingSpinner className="w-8 h-8 text-primary" />
      </div>
    </div>
  );
  if (books.length === 0) return (
    <div className="space-y-6">
      <LibraryHeader />
      <EmptyLibraryState />
    </div>
  );

  const filterProps = {
    authorFilter: filters.authorFilter, onAuthorFilterChange: filters.setAuthorFilter, uniqueAuthors: filters.uniqueAuthors,
    seriesFilter: filters.seriesFilter, onSeriesFilterChange: filters.setSeriesFilter, uniqueSeries: filters.uniqueSeries,
    narratorFilter: filters.narratorFilter, onNarratorFilterChange: filters.setNarratorFilter, uniqueNarrators: filters.uniqueNarrators,
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
        statusCounts={filters.statusCounts}
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

      {filters.filteredBooks.length === 0 ? (
        <NoMatchState onClearFilters={filters.clearAllFilters} />
      ) : viewMode === 'table' ? (
        <LibraryTableView
          books={filters.filteredBooks}
          selectedIds={bulk.selectedIds}
          onSelectionChange={bulk.setSelectedIds}
          sortField={filters.sortField}
          sortDirection={filters.sortDirection}
          onSortFieldChange={filters.setSortField}
          onSortDirectionChange={filters.setSortDirection}
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {filters.filteredBooks.map((book: DisplayBook, index) => (
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
