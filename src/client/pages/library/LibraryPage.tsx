import { PageLoading } from '@/components/PageLoading';
import { LibraryModals } from './LibraryModals.js';
import { LibraryToolbar } from './LibraryToolbar.js';
import { LibraryTableView } from './LibraryTableView.js';
import { LibraryGridView } from './LibraryGridView.js';
import { BulkActionToolbar } from './BulkActionToolbar.js';
import { EmptyLibraryState } from './EmptyLibraryState.js';
import { LibraryErrorState } from './LibraryErrorState.js';
import { NoMatchState } from './NoMatchState.js';
import { LibraryHeader } from './LibraryHeader.js';
import { Pagination } from '@/components/Pagination';
import { useLibraryPageState } from './useLibraryPageState.js';

export function LibraryPage() {
  const s = useLibraryPageState();

  if (s.isLoading) return <PageLoading header={<LibraryHeader />} />;
  if (s.booksError) return (
    <div className="space-y-6">
      <LibraryHeader />
      <LibraryErrorState />
    </div>
  );
  if (s.totalAll === 0 && s.totalBooks === 0 && !s.filters.state.isSearching && s.filters.state.statusFilter === 'all') return (
    <div className="space-y-6">
      <LibraryHeader />
      <EmptyLibraryState hasLibraryPath={Boolean(s.settings?.library.path)} />
    </div>
  );

  const filterProps = {
    authorFilter: s.filters.state.authorFilter, onAuthorFilterChange: s.filters.actions.setAuthorFilter, uniqueAuthors: s.uniqueAuthors,
    seriesFilter: s.filters.state.seriesFilter, onSeriesFilterChange: s.filters.actions.setSeriesFilter, uniqueSeries: s.uniqueSeries,
    narratorFilter: s.filters.state.narratorFilter, onNarratorFilterChange: s.filters.actions.setNarratorFilter, uniqueNarrators: s.uniqueNarrators,
  };
  const sortProps = {
    sortField: s.filters.state.sortField, onSortFieldChange: s.filters.actions.setSortField,
    sortDirection: s.filters.state.sortDirection, onSortDirectionChange: s.filters.actions.setSortDirection,
  };

  return (
    <div className="space-y-5">
      <LibraryHeader subtitle={s.subtitle} />

      <LibraryToolbar
        searchQuery={s.filters.state.searchQuery}
        onSearchChange={s.filters.actions.setSearchQuery}
        onSearchClear={s.filters.actions.clearSearch}
        statusFilter={s.filters.state.statusFilter}
        onStatusFilterChange={s.filters.actions.setStatusFilter}
        statusCounts={s.statusCounts}
        filtersOpen={s.filters.state.filtersOpen}
        onFiltersToggle={() => s.filters.actions.setFiltersOpen(!s.filters.state.filtersOpen)}
        activeFilterCount={s.filters.counts.activeFilterCount}
        filterProps={filterProps}
        sortProps={sortProps}
        collapseSeriesEnabled={s.filters.state.collapseSeriesEnabled}
        onCollapseSeriesToggle={() => s.filters.actions.setCollapseSeriesEnabled(!s.filters.state.collapseSeriesEnabled)}
        viewMode={s.viewMode}
        onViewModeChange={s.handleViewModeChange}
        onRescan={() => s.rescanMutation.mutate()}
        isRescanning={s.rescanMutation.isPending}
        missingCount={s.missingCount}
        onRemoveMissing={() => s.setShowRemoveMissingModal(true)}
        onSearchAllWanted={() => s.setShowSearchAllWantedModal(true)}
        isSearchingAllWanted={s.searchAllWantedMutation.isPending}
      />

      {s.viewMode === 'table' && s.bulk.selectedIds.size > 0 && (
        <BulkActionToolbar
          selectedCount={s.bulk.selectedIds.size}
          onDelete={(df) => s.bulk.bulkDeleteMutation.mutate({ deleteFiles: df })}
          isDeleting={s.bulk.bulkDeleteMutation.isPending}
          onSearch={() => s.bulk.bulkSearchMutation.mutate()}
          isSearching={s.bulk.bulkSearchMutation.isPending}
          onSetStatus={(status, label) => s.bulk.bulkSetStatusMutation.mutate({ status, label })}
          isSettingStatus={s.bulk.bulkSetStatusMutation.isPending}
          hasPath={s.anySelectedHasPath}
          fileCount={s.bulkFileCount}
        />
      )}

      {s.displayBooks.length === 0 ? (
        <NoMatchState onClearFilters={s.filters.actions.clearAllFilters} searchQuery={s.filters.state.searchQuery} />
      ) : s.viewMode === 'table' ? (
        <LibraryTableView
          books={s.displayBooks}
          selectedIds={s.bulk.selectedIds}
          onSelectionChange={s.bulk.setSelectedIds}
          sortField={s.filters.state.sortField}
          sortDirection={s.filters.state.sortDirection}
          onSortFieldChange={s.filters.actions.setSortField}
          onSortDirectionChange={s.filters.actions.setSortDirection}
        />
      ) : (
        <LibraryGridView
          displayBooks={s.displayBooks}
          settledGridKey={s.settledGridKey}
          openMenuId={s.openMenuId}
          onMenuToggle={s.handleCardMenuToggle}
          onMenuClose={s.closeMenu}
          onClick={s.handleCardClick}
          onSearchReleases={s.handleCardSearchReleases}
          onRemove={s.handleCardRemove}
          onRetryImport={s.handleRetryImport}
        />
      )}

      <Pagination
        page={s.filters.params.pagination.page}
        totalPages={s.filters.params.pagination.totalPages(s.totalBooks)}
        total={s.totalBooks}
        limit={s.filters.params.pagination.limit}
        onPageChange={s.filters.params.pagination.setPage}
      />

      <LibraryModals
        deleteTarget={s.deleteConfirm.target}
        isDeleteOpen={s.deleteConfirm.isOpen}
        onDeleteConfirm={(df) => { const item = s.deleteConfirm.confirm(); if (item) s.deleteMutation.mutate({ id: item.id, deleteFiles: df }); }}
        onDeleteCancel={() => { s.deleteConfirm.cancel(); }}
        showRemoveMissingModal={s.showRemoveMissingModal}
        missingCount={s.missingCount}
        onRemoveMissingConfirm={() => { s.setShowRemoveMissingModal(false); s.deleteMissingMutation.mutate(); }}
        onRemoveMissingCancel={() => s.setShowRemoveMissingModal(false)}
        showSearchAllWantedModal={s.showSearchAllWantedModal}
        searchAllWantedMessage={s.searchAllWantedMessage}
        onSearchAllWantedConfirm={() => { s.setShowSearchAllWantedModal(false); s.searchAllWantedMutation.mutate(); }}
        onSearchAllWantedCancel={() => s.setShowSearchAllWantedModal(false)}
        searchBook={s.searchBook}
        onSearchBookClose={() => s.setSearchBook(null)}
      />
    </div>
  );
}
