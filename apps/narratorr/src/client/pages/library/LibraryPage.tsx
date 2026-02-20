import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLibrary } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner } from '@/components/icons';
import { useImportPolling } from './useImportPolling.js';
import { useLibraryFilters } from './useLibraryFilters.js';
import { LibraryToolbar } from './LibraryToolbar.js';
import { LibraryBookCard } from './LibraryBookCard.js';
import { EmptyLibraryState } from './EmptyLibraryState.js';
import { NoMatchState } from './NoMatchState.js';

export function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: books = [], isLoading } = useLibrary();

  useImportPolling(books);
  const filters = useLibraryFilters(books);

  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  const deleteMutation = useMutation({
    mutationFn: api.deleteBook,
    onSuccess: () => {
      toast.success('Removed book from library');
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      toast.error(`Failed to remove book: ${error.message}`);
    },
  });

  const closeMenu = useCallback(() => setOpenMenuId(null), []);
  useEffect(() => {
    if (openMenuId !== null) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
  }, [openMenuId, closeMenu]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">Your audiobook collection</p>
        </div>
        <div className="flex items-center justify-center py-24">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      </div>
    );
  }

  if (books.length === 0) {
    return (
      <div className="space-y-6">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">Your audiobook collection</p>
        </div>
        <EmptyLibraryState />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
        <p className="text-muted-foreground mt-1">
          {filters.isSearching
            ? `${filters.filteredBooks.length} of ${books.length} book${books.length !== 1 ? 's' : ''}`
            : `${books.length} book${books.length !== 1 ? 's' : ''} in your collection`}
        </p>
      </div>

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
        authorFilter={filters.authorFilter}
        onAuthorFilterChange={filters.setAuthorFilter}
        uniqueAuthors={filters.uniqueAuthors}
        seriesFilter={filters.seriesFilter}
        onSeriesFilterChange={filters.setSeriesFilter}
        uniqueSeries={filters.uniqueSeries}
        sortField={filters.sortField}
        onSortFieldChange={filters.setSortField}
        sortDirection={filters.sortDirection}
        onSortDirectionChange={filters.setSortDirection}
      />

      {filters.filteredBooks.length === 0 ? (
        <NoMatchState onClearFilters={filters.clearAllFilters} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {filters.filteredBooks.map((book, index) => (
            <LibraryBookCard
              key={book.id}
              book={book}
              index={index}
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

      <ConfirmModal
        isOpen={deleteConfirm.isOpen}
        title="Remove from Library"
        message={`Are you sure you want to remove "${deleteConfirm.target?.title}" from your library? This will cancel any active downloads.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={() => { const item = deleteConfirm.confirm(); if (item) deleteMutation.mutate(item.id); }}
        onCancel={deleteConfirm.cancel}
      />

      {searchBook && (
        <SearchReleasesModal
          isOpen={searchBook !== null}
          book={searchBook}
          onClose={() => setSearchBook(null)}
        />
      )}
    </div>
  );
}
