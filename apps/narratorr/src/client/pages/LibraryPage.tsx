import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLibrary } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { bookStatusConfig } from '@/lib/status';
import { queryKeys } from '@/lib/queryKeys';
import {
  LibraryIcon as BookShelfIcon,
  BookOpenIcon,
  SearchIcon,
  MoreVerticalIcon,
  ChevronDownIcon,
  ArrowUpDownIcon,
  ArrowRightIcon,
  EyeIcon,
  TrashIcon,
  LoadingSpinner,
} from '@/components/icons';

// ============================================================================
// Types
// ============================================================================

type StatusFilter = 'all' | 'wanted' | 'downloading' | 'imported';
type SortField = 'createdAt' | 'title' | 'author';
type SortDirection = 'asc' | 'desc';

const filterTabs: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'wanted', label: 'Wanted' },
  { key: 'downloading', label: 'Downloading' },
  { key: 'imported', label: 'Imported' },
];

// ============================================================================
// Helpers
// ============================================================================

function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'wanted') return status === 'wanted';
  if (filter === 'downloading') return status === 'searching' || status === 'downloading';
  if (filter === 'imported') return status === 'imported';
  return false;
}

function getStatusCount(books: BookWithAuthor[], filter: StatusFilter): number {
  return books.filter((b) => matchesStatusFilter(b.status, filter)).length;
}

function sortBooks(books: BookWithAuthor[], field: SortField, direction: SortDirection): BookWithAuthor[] {
  return [...books].sort((a, b) => {
    let cmp = 0;
    if (field === 'title') {
      cmp = a.title.localeCompare(b.title);
    } else if (field === 'author') {
      cmp = (a.author?.name ?? '').localeCompare(b.author?.name ?? '');
    } else {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    }
    return direction === 'asc' ? cmp : -cmp;
  });
}

// ============================================================================
// Main Component
// ============================================================================

export function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: books = [], isLoading } = useLibrary();

  // State
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [authorFilter, setAuthorFilter] = useState('');
  const [seriesFilter, setSeriesFilter] = useState('');
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);

  // Delete mutation
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

  // Derived data
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
    let result = books.filter((b) => matchesStatusFilter(b.status, statusFilter));
    if (authorFilter) {
      result = result.filter((b) => b.author?.name === authorFilter);
    }
    if (seriesFilter) {
      result = result.filter((b) => b.seriesName === seriesFilter);
    }
    return sortBooks(result, sortField, sortDirection);
  }, [books, statusFilter, authorFilter, seriesFilter, sortField, sortDirection]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = { all: books.length, wanted: 0, downloading: 0, imported: 0 };
    for (const tab of filterTabs) {
      if (tab.key !== 'all') counts[tab.key] = getStatusCount(books, tab.key);
    }
    return counts;
  }, [books]);

  // Close context menu on outside click
  const closeMenu = useCallback(() => setOpenMenuId(null), []);

  useEffect(() => {
    if (openMenuId !== null) {
      document.addEventListener('click', closeMenu);
      return () => document.removeEventListener('click', closeMenu);
    }
  }, [openMenuId, closeMenu]);

  // Loading
  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-2">Your audiobook collection</p>
        </div>
        <div className="flex items-center justify-center py-24">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      </div>
    );
  }

  // Empty library
  if (books.length === 0) {
    return (
      <div className="space-y-8">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-2">Your audiobook collection</p>
        </div>
        <EmptyLibraryState />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
        <p className="text-muted-foreground mt-2">
          {books.length} book{books.length !== 1 ? 's' : ''} in your collection
        </p>
      </div>

      {/* Toolbar */}
      <LibraryToolbar
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        statusCounts={statusCounts}
        authorFilter={authorFilter}
        onAuthorFilterChange={setAuthorFilter}
        uniqueAuthors={uniqueAuthors}
        seriesFilter={seriesFilter}
        onSeriesFilterChange={setSeriesFilter}
        uniqueSeries={uniqueSeries}
        sortField={sortField}
        onSortFieldChange={setSortField}
        sortDirection={sortDirection}
        onSortDirectionChange={setSortDirection}
      />

      {/* Book Grid */}
      {filteredBooks.length === 0 ? (
        <NoMatchState onClearFilters={() => { setStatusFilter('all'); setAuthorFilter(''); setSeriesFilter(''); }} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5">
          {filteredBooks.map((book, index) => (
            <LibraryBookCard
              key={book.id}
              book={book}
              index={index}
              isMenuOpen={openMenuId === book.id}
              onMenuToggle={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === book.id ? null : book.id); }}
              onMenuClose={() => setOpenMenuId(null)}
              onViewDetails={() => { navigate(`/books/${book.id}`); setOpenMenuId(null); }}
              onSearchReleases={() => { setSearchBook(book); setOpenMenuId(null); }}
              onRemove={() => { deleteConfirm.requestDelete(book); setOpenMenuId(null); }}
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={deleteConfirm.isOpen}
        title="Remove from Library"
        message={`Are you sure you want to remove "${deleteConfirm.target?.title}" from your library? This will cancel any active downloads.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={() => { const item = deleteConfirm.confirm(); if (item) deleteMutation.mutate(item.id); }}
        onCancel={deleteConfirm.cancel}
      />

      {/* Search Releases Modal */}
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

// ============================================================================
// Toolbar
// ============================================================================

function LibraryToolbar({
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  authorFilter,
  onAuthorFilterChange,
  uniqueAuthors,
  seriesFilter,
  onSeriesFilterChange,
  uniqueSeries,
  sortField,
  onSortFieldChange,
  sortDirection,
  onSortDirectionChange,
}: {
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
  authorFilter: string;
  onAuthorFilterChange: (f: string) => void;
  uniqueAuthors: string[];
  seriesFilter: string;
  onSeriesFilterChange: (f: string) => void;
  uniqueSeries: string[];
  sortField: SortField;
  onSortFieldChange: (f: SortField) => void;
  sortDirection: SortDirection;
  onSortDirectionChange: (d: SortDirection) => void;
}) {
  const sortLabels: Record<SortField, string> = {
    createdAt: 'Date Added',
    title: 'Title',
    author: 'Author',
  };

  return (
    <div className="space-y-4 animate-fade-in-up stagger-1">
      {/* Status tabs */}
      <div className="flex flex-wrap gap-2">
        {filterTabs.map((tab) => {
          const isActive = statusFilter === tab.key;
          const count = statusCounts[tab.key];
          return (
            <button
              key={tab.key}
              onClick={() => onStatusFilterChange(tab.key)}
              className={`
                flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium
                transition-all duration-200 focus-ring
                ${isActive
                  ? 'bg-primary text-primary-foreground shadow-glow'
                  : 'glass-card text-muted-foreground hover:text-foreground hover:border-primary/30'
                }
              `}
            >
              {tab.label}
              <span className={`text-xs ${isActive ? 'opacity-75' : 'opacity-60'}`}>
                ({count})
              </span>
            </button>
          );
        })}
      </div>

      {/* Filters & Sort row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Author filter */}
        {uniqueAuthors.length > 1 && (
          <div className="relative">
            <select
              value={authorFilter}
              onChange={(e) => onAuthorFilterChange(e.target.value)}
              className="appearance-none glass-card rounded-xl pl-3 pr-8 py-2 text-sm font-medium text-foreground focus-ring cursor-pointer"
            >
              <option value="">All Authors</option>
              {uniqueAuthors.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <ChevronDownIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {/* Series filter */}
        {uniqueSeries.length > 0 && (
          <div className="relative">
            <select
              value={seriesFilter}
              onChange={(e) => onSeriesFilterChange(e.target.value)}
              className="appearance-none glass-card rounded-xl pl-3 pr-8 py-2 text-sm font-medium text-foreground focus-ring cursor-pointer"
            >
              <option value="">All Series</option>
              {uniqueSeries.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <ChevronDownIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sort control */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={sortField}
              onChange={(e) => onSortFieldChange(e.target.value as SortField)}
              className="appearance-none glass-card rounded-xl pl-3 pr-8 py-2 text-sm font-medium text-foreground focus-ring cursor-pointer"
            >
              {Object.entries(sortLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <ChevronDownIcon className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          </div>
          <button
            onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
            className="glass-card rounded-xl p-2 text-muted-foreground hover:text-foreground transition-colors focus-ring"
            title={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
          >
            <ArrowUpDownIcon className={`w-4 h-4 transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Book Card
// ============================================================================

function LibraryBookCard({
  book,
  index,
  isMenuOpen,
  onMenuToggle,
  onMenuClose,
  onViewDetails,
  onSearchReleases,
  onRemove,
}: {
  book: BookWithAuthor;
  index: number;
  isMenuOpen: boolean;
  onMenuToggle: (e: React.MouseEvent) => void;
  onMenuClose: () => void;
  onViewDetails: () => void;
  onSearchReleases: () => void;
  onRemove: () => void;
}) {
  const [imageError, setImageError] = useState(false);
  const config = bookStatusConfig[book.status] ?? bookStatusConfig.wanted;

  return (
    <div
      className="group glass-card rounded-2xl overflow-hidden hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${Math.min(index, 9) * 50}ms` }}
    >
      {/* Cover */}
      <div className="relative aspect-[3/4] bg-muted overflow-hidden">
        {book.coverUrl && !imageError ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <BookOpenIcon className="w-12 h-12 text-muted-foreground/30" />
          </div>
        )}

        {/* Cover overlay gradient */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute inset-0 ring-1 ring-inset ring-black/10" />

        {/* Status badge */}
        <div className="absolute top-3 left-3">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold backdrop-blur-md bg-black/40 text-white`}>
            <span className={`w-1.5 h-1.5 rounded-full ${config.dotClass}`} />
            {config.label}
          </span>
        </div>

        {/* Context menu button */}
        <div className="absolute top-3 right-3">
          <button
            onClick={onMenuToggle}
            className={`p-2 rounded-lg backdrop-blur-md text-white/80 hover:text-white transition-all focus-ring ${isMenuOpen ? 'bg-black/70 text-white' : 'bg-black/40 hover:bg-black/60'}`}
            aria-label="Book options"
            aria-expanded={isMenuOpen}
            aria-haspopup="true"
          >
            <MoreVerticalIcon className="w-4 h-4" />
          </button>

          {isMenuOpen && (
            <BookContextMenu
              onViewDetails={onViewDetails}
              onSearchReleases={onSearchReleases}
              onRemove={onRemove}
              onClose={onMenuClose}
            />
          )}
        </div>

        {/* Series badge */}
        {book.seriesName && (
          <div className="absolute bottom-3 left-3 right-3">
            <span
              className="inline-block max-w-full truncate px-2.5 py-1 rounded-lg text-xs font-medium backdrop-blur-md bg-black/40 text-white/90"
              title={`${book.seriesName}${book.seriesPosition != null ? ` #${book.seriesPosition}` : ''}`}
            >
              {book.seriesName}
              {book.seriesPosition != null && ` #${book.seriesPosition}`}
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4">
        <h3 className="font-display text-base font-semibold leading-tight line-clamp-2 group-hover:text-primary transition-colors">
          {book.title}
        </h3>
        {book.author?.name && (
          <p className="text-sm text-muted-foreground mt-1 truncate">
            {book.author.name}
          </p>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Context Menu
// ============================================================================

function BookContextMenu({
  onViewDetails,
  onSearchReleases,
  onRemove,
  onClose,
}: {
  onViewDetails: () => void;
  onSearchReleases: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const actions = [onViewDetails, onSearchReleases, onRemove];

  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[focusIndex]?.focus();
  }, [focusIndex]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % actions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + actions.length) % actions.length);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        actions[focusIndex]();
        break;
    }
  }, [onClose, actions.length]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full mt-1 w-48 glass-card rounded-xl overflow-hidden shadow-lg z-10 animate-fade-in"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <button
        role="menuitem"
        onClick={onViewDetails}
        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left hover:bg-muted/80 transition-colors focus:bg-muted/80 focus:outline-none"
      >
        <EyeIcon className="w-4 h-4 text-muted-foreground" />
        View Details
      </button>
      <button
        role="menuitem"
        onClick={onSearchReleases}
        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left hover:bg-muted/80 transition-colors focus:bg-muted/80 focus:outline-none"
      >
        <SearchIcon className="w-4 h-4 text-muted-foreground" />
        Search Releases
      </button>
      <div className="border-t border-border/50" />
      <button
        role="menuitem"
        onClick={onRemove}
        className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-left text-destructive hover:bg-destructive/10 transition-colors focus:bg-destructive/10 focus:outline-none"
      >
        <TrashIcon className="w-4 h-4" />
        Remove from Library
      </button>
    </div>
  );
}

// ============================================================================
// Empty States
// ============================================================================

function EmptyLibraryState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <BookShelfIcon className="w-16 h-16 text-primary" />
        </div>
      </div>
      <h3 className="font-display text-2xl sm:text-3xl font-semibold text-center mb-3">
        Your library is empty
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-8">
        Start building your audiobook collection by discovering and adding books
      </p>
      <a
        href="/search"
        className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
      >
        <SearchIcon className="w-4 h-4" />
        Discover Books
        <ArrowRightIcon className="w-4 h-4" />
      </a>
    </div>
  );
}

function NoMatchState({ onClearFilters }: { onClearFilters: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up">
      <div className="text-muted-foreground/40 mb-6">
        <SearchIcon className="w-12 h-12" />
      </div>
      <h3 className="font-display text-xl sm:text-2xl font-semibold text-center mb-2">
        No books match your filters
      </h3>
      <p className="text-muted-foreground text-center max-w-md mb-6">
        Try adjusting your filters to see more results
      </p>
      <button
        onClick={onClearFilters}
        className="px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
      >
        Clear Filters
      </button>
    </div>
  );
}
