import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useImageError } from '@/hooks/useImageError';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useLibrary } from '@/hooks/useLibrary';
import { api, type BookWithAuthor } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import { useDeleteConfirmation } from '@/hooks/useDeleteConfirmation';
import { useLibrarySearch } from '@/hooks/useLibrarySearch';
import { queryKeys } from '@/lib/queryKeys';
import {
  LibraryIcon as BookShelfIcon,
  BookOpenIcon,
  SearchIcon,
  XIcon,
  MoreVerticalIcon,
  ChevronDownIcon,
  ArrowUpDownIcon,
  ArrowRightIcon,
  TrashIcon,
  PlusIcon,
  LoadingSpinner,
} from '@/components/icons';
import { QuickAddWizard } from '@/components/QuickAddWizard';

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

// Status border classes for card left-accent
const statusBorderClass: Record<string, string> = {
  wanted: 'border-l-[3px] border-l-amber-500',
  searching: 'border-l-[3px] border-l-blue-500 animate-border-pulse',
  downloading: 'border-l-[3px] border-l-blue-500 animate-border-pulse',
};

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const deleteConfirm = useDeleteConfirmation<BookWithAuthor>();
  const [searchBook, setSearchBook] = useState<BookWithAuthor | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { query: searchQuery, setQuery: setSearchQuery, clearQuery: clearSearch, results: searchResults, isSearching } = useLibrarySearch(books);

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

  // Empty library
  if (books.length === 0) {
    return (
      <div className="space-y-6">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
          <p className="text-muted-foreground mt-1">Your audiobook collection</p>
        </div>
        <EmptyLibraryState onImport={() => setImportOpen(true)} />
        <QuickAddWizard isOpen={importOpen} onClose={() => setImportOpen(false)} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header — just title + count */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">Library</h1>
        <p className="text-muted-foreground mt-1">
          {isSearching
            ? `${filteredBooks.length} of ${books.length} book${books.length !== 1 ? 's' : ''}`
            : `${books.length} book${books.length !== 1 ? 's' : ''} in your collection`}
        </p>
      </div>

      {/* Toolbar */}
      <LibraryToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchClear={clearSearch}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        statusCounts={statusCounts}
        filtersOpen={filtersOpen}
        onFiltersToggle={() => setFiltersOpen(!filtersOpen)}
        activeFilterCount={activeFilterCount}
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
        <NoMatchState onClearFilters={() => { setStatusFilter('all'); setAuthorFilter(''); setSeriesFilter(''); clearSearch(); }} />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
          {filteredBooks.map((book, index) => (
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

          {/* Ghost "Quick Add" card */}
          <button
            onClick={() => setImportOpen(true)}
            className="group aspect-square rounded-2xl border-2 border-dashed border-border/40 hover:border-primary/50 flex flex-col items-center justify-center gap-3 transition-all duration-300 hover:bg-primary/5 hover:shadow-glow animate-fade-in-up"
            style={{ animationDelay: `${Math.min(filteredBooks.length, 9) * 50}ms` }}
          >
            <div className="w-12 h-12 rounded-full bg-muted/40 group-hover:bg-primary/15 flex items-center justify-center transition-all duration-300 group-hover:scale-110">
              <PlusIcon className="w-5 h-5 text-muted-foreground/60 group-hover:text-primary transition-colors" />
            </div>
            <span className="text-xs font-medium text-muted-foreground/60 group-hover:text-primary transition-colors">Quick Add</span>
          </button>
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

      {/* Quick Add Wizard */}
      <QuickAddWizard isOpen={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

// ============================================================================
// Toolbar — single row default, collapsible filters
// ============================================================================

function LibraryToolbar({
  searchQuery,
  onSearchChange,
  onSearchClear,
  statusFilter,
  onStatusFilterChange,
  statusCounts,
  filtersOpen,
  onFiltersToggle,
  activeFilterCount,
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
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearchClear: () => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  statusCounts: Record<StatusFilter, number>;
  filtersOpen: boolean;
  onFiltersToggle: () => void;
  activeFilterCount: number;
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
    <div className="space-y-3 animate-fade-in-up stagger-1">
      {/* Row 1: Search + status pills + filters toggle */}
      <div className="flex items-center gap-3">
        {/* Search input */}
        <div className="relative flex-1 max-w-xs">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search library..."
            className="w-full glass-card rounded-xl pl-9 pr-9 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-ring"
          />
          {searchQuery && (
            <button
              onClick={onSearchClear}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear search"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Status pills */}
        <div className="flex items-center gap-1.5">
          {filterTabs.map((tab) => {
            const isActive = statusFilter === tab.key;
            const count = statusCounts[tab.key];
            return (
              <button
                key={tab.key}
                onClick={() => onStatusFilterChange(tab.key)}
                className={`
                  flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium
                  transition-all duration-200 focus-ring whitespace-nowrap
                  ${isActive
                    ? 'bg-primary text-primary-foreground shadow-glow'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  }
                `}
              >
                {tab.label}
                <span className={`text-[10px] ${isActive ? 'opacity-75' : 'opacity-50'}`}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Filters toggle */}
        <button
          onClick={onFiltersToggle}
          aria-label="Toggle filters"
          className={`
            relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 focus-ring
            ${filtersOpen
              ? 'bg-muted/80 text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }
          `}
        >
          <ChevronDownIcon className={`w-3 h-3 transition-transform duration-200 ${filtersOpen ? 'rotate-180' : ''}`} />
          Filters
          {activeFilterCount > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* Row 2: Collapsible filters + sort */}
      {filtersOpen && (
        <div className="flex flex-wrap items-center gap-3 animate-fade-in">
          {/* Author filter */}
          {uniqueAuthors.length > 1 && (
            <div className="relative">
              <select
                value={authorFilter}
                onChange={(e) => onAuthorFilterChange(e.target.value)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                <option value="">All Authors</option>
                {uniqueAuthors.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          )}

          {/* Series filter */}
          {uniqueSeries.length > 0 && (
            <div className="relative">
              <select
                value={seriesFilter}
                onChange={(e) => onSeriesFilterChange(e.target.value)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                <option value="">All Series</option>
                {uniqueSeries.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Sort control */}
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <select
                value={sortField}
                onChange={(e) => onSortFieldChange(e.target.value as SortField)}
                className="appearance-none glass-card rounded-lg pl-3 pr-7 py-1.5 text-xs font-medium text-foreground focus-ring cursor-pointer"
              >
                {Object.entries(sortLabels).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <ChevronDownIcon className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
            </div>
            <button
              onClick={() => onSortDirectionChange(sortDirection === 'asc' ? 'desc' : 'asc')}
              className="glass-card rounded-lg p-1.5 text-muted-foreground hover:text-foreground transition-colors focus-ring"
              title={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
            >
              <ArrowUpDownIcon className={`w-3.5 h-3.5 transition-transform ${sortDirection === 'asc' ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Book Card — square cover, frosted overlay, clickable, border-based status
// ============================================================================

function LibraryBookCard({
  book,
  index,
  isMenuOpen,
  onMenuToggle,
  onMenuClose,
  onClick,
  onSearchReleases,
  onRemove,
}: {
  book: BookWithAuthor;
  index: number;
  isMenuOpen: boolean;
  onMenuToggle: (e: React.MouseEvent) => void;
  onMenuClose: () => void;
  onClick: () => void;
  onSearchReleases: () => void;
  onRemove: () => void;
}) {
  const { hasError: imageError, onError: onImageError } = useImageError();
  const borderClass = statusBorderClass[book.status] ?? '';

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      className={`group relative rounded-2xl overflow-hidden cursor-pointer shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 ease-out animate-fade-in-up ${borderClass}`}
      style={{ animationDelay: `${Math.min(index, 9) * 50}ms` }}
    >
      {/* Cover — square */}
      <div className="relative aspect-square bg-muted overflow-hidden">
        {book.coverUrl && !imageError ? (
          <img
            src={book.coverUrl}
            alt={book.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            loading="lazy"
            onError={onImageError}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/40">
            <BookOpenIcon className="w-12 h-12 text-muted-foreground/20" />
          </div>
        )}

        {/* Vignette + gradient fade toward overlay */}
        <div className="absolute inset-0 ring-1 ring-inset ring-white/5" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 via-black/20 to-transparent pointer-events-none" />

        {/* Context menu — hover-reveal only */}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={(e) => { e.stopPropagation(); onMenuToggle(e); }}
            className={`p-1.5 rounded-lg backdrop-blur-md text-white/80 hover:text-white transition-all focus-ring ${isMenuOpen ? 'bg-black/70 text-white opacity-100' : 'bg-black/40 hover:bg-black/60'}`}
            aria-label="Book options"
            aria-expanded={isMenuOpen}
            aria-haspopup="true"
          >
            <MoreVerticalIcon className="w-3.5 h-3.5" />
          </button>

          {isMenuOpen && (
            <BookContextMenu
              onSearchReleases={() => { onSearchReleases(); }}
              onRemove={() => { onRemove(); }}
              onClose={onMenuClose}
            />
          )}
        </div>

        {/* Frosted info strip — always visible at bottom */}
        <div className="absolute inset-x-0 bottom-0 backdrop-blur-md bg-black/30 border-t border-white/5 transition-all duration-300 ease-out">
          {/* Default: title + author */}
          <div className="px-3 py-2">
            <h3 className="text-sm font-semibold text-white leading-tight truncate drop-shadow-sm">{book.title}</h3>
            <p className="text-xs text-white/70 truncate mt-0.5">{book.author?.name}</p>
          </div>

          {/* Hover expand: narrator + series */}
          {(book.narrator || book.seriesName) && (
            <div className="max-h-0 opacity-0 group-hover:max-h-16 group-hover:opacity-100 overflow-hidden transition-all duration-300 ease-out">
              <div className="px-3 pb-2 flex flex-wrap gap-x-3 gap-y-0.5">
                {book.narrator && (
                  <p className="text-[11px] text-white/50 truncate">{book.narrator}</p>
                )}
                {book.seriesName && (
                  <p className="text-[11px] text-amber-400/80 truncate">
                    {book.seriesName}{book.seriesPosition != null && ` #${book.seriesPosition}`}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Context Menu — removed "View Details" (card click handles it)
// ============================================================================

function BookContextMenu({
  onSearchReleases,
  onRemove,
  onClose,
}: {
  onSearchReleases: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const actions = [onSearchReleases, onRemove];

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
  }, [onClose, actions, focusIndex]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="absolute right-0 top-full mt-1 w-44 glass-card rounded-xl overflow-hidden shadow-lg z-10 animate-fade-in"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
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

function EmptyLibraryState({ onImport }: { onImport: () => void }) {
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
      <div className="flex flex-wrap items-center gap-3">
        <a
          href="/search"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring"
        >
          <SearchIcon className="w-4 h-4" />
          Discover Books
          <ArrowRightIcon className="w-4 h-4" />
        </a>
        <button
          onClick={onImport}
          className="inline-flex items-center gap-2 px-6 py-3 glass-card font-medium rounded-xl hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
        >
          <PlusIcon className="w-4 h-4" />
          Quick Add
        </button>
      </div>
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
