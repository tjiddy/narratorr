import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BookWithAuthor, UpdateBookPayload, BookMetadata } from '@/lib/api';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { XIcon, SearchIcon, LoadingSpinner, HeadphonesIcon, AlertCircleIcon, ArrowLeftIcon } from '@/components/icons';

type SearchView = 'edit' | 'search';

interface BookMetadataModalProps {
  book: BookWithAuthor;
  onSave: (data: UpdateBookPayload, renameFiles: boolean) => void;
  onClose: () => void;
  isSaving: boolean;
}

// eslint-disable-next-line max-lines-per-function, complexity -- metadata edit modal with search integration
export function BookMetadataModal({ book, onSave, onClose, isSaving }: BookMetadataModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(book.title);
  const [seriesName, setSeriesName] = useState(book.seriesName ?? '');
  const [seriesPosition, setSeriesPosition] = useState(book.seriesPosition?.toString() ?? '');
  const [narrator, setNarrator] = useState(book.narrator ?? '');
  const [renameFiles, setRenameFiles] = useState(false);

  const [view, setView] = useState<SearchView>('edit');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<BookMetadata[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEscapeKey(true, onClose, modalRef);

  const canSave = title.trim().length > 0 && !isSaving;
  const hasPath = !!book.path;
  const positionError = seriesPosition.trim() !== '' && isNaN(Number(seriesPosition.trim()))
    ? 'Must be a number'
    : null;

  const searchMutation = useMutation({
    mutationFn: (query: string) => api.searchMetadata(query),
    onSuccess: (result) => {
      setSearchResults(result.books);
      setHasSearched(true);
      setSearchError(null);
    },
    onError: () => {
      setSearchError('Search failed. Please try again.');
      setSearchResults([]);
      setHasSearched(true);
    },
  });

  const handleOpenSearch = () => {
    const prefill = [book.title, book.author?.name ?? ''].filter(Boolean).join(' ').trim();
    setSearchQuery(prefill);
    setView('search');
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      searchMutation.mutate(searchQuery.trim());
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSearch();
    }
  };

  const applyMetadata = (meta: BookMetadata) => {
    setTitle(meta.title);
    setNarrator(meta.narrators?.join(', ') ?? '');
    setSeriesName(meta.series?.[0]?.name ?? '');
    setSeriesPosition(meta.series?.[0]?.position?.toString() ?? '');
    setView('edit');
  };

  const handleDismissSearch = () => {
    setView('edit');
  };

  const handleSave = () => {
    if (!canSave) return;

    const data: UpdateBookPayload = {};

    if (title.trim() !== book.title) data.title = title.trim();
    if (seriesName.trim() !== (book.seriesName ?? '')) {
      data.seriesName = seriesName.trim() || null;
    }

    const trimmedPos = seriesPosition.trim();
    const newPos = trimmedPos ? Number(trimmedPos) : null;
    if (newPos !== null && isNaN(newPos)) {
      // Invalid input — exclude seriesPosition from payload
    } else if (newPos !== (book.seriesPosition ?? null)) {
      data.seriesPosition = newPos;
    }

    if (narrator.trim() !== (book.narrator ?? '')) {
      data.narrator = narrator.trim() || undefined;
    }

    onSave(data, renameFiles);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit book metadata"
        className="relative w-full max-w-lg flex flex-col glass-card rounded-2xl shadow-2xl animate-fade-in-up max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {view === 'search' && (
              <button
                onClick={handleDismissSearch}
                className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
                aria-label="Back to edit"
              >
                <ArrowLeftIcon className="w-4 h-4" />
              </button>
            )}
            <h2 className="font-display text-lg font-semibold tracking-tight">
              {view === 'search' ? 'Search Audnexus' : 'Edit Metadata'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="border-t border-white/5" />

        {view === 'edit' ? (
          /* Edit fields view */
          <div className="p-6 space-y-4 overflow-y-auto">
            <div>
              <label htmlFor="edit-title" className="block text-xs font-medium text-muted-foreground mb-1.5">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                id="edit-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-series" className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Series
                </label>
                <input
                  id="edit-series"
                  type="text"
                  value={seriesName}
                  onChange={(e) => setSeriesName(e.target.value)}
                  placeholder="e.g. Harry Potter"
                  className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                />
              </div>
              <div>
                <label htmlFor="edit-series-position" className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Position
                </label>
                <input
                  id="edit-series-position"
                  type="text"
                  inputMode="decimal"
                  value={seriesPosition}
                  onChange={(e) => setSeriesPosition(e.target.value)}
                  placeholder="e.g. 1"
                  className={`w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring${positionError ? ' border-red-400/50' : ''}`}
                />
                {positionError && (
                  <p className="text-xs text-red-400 mt-1">{positionError}</p>
                )}
              </div>
            </div>

            <div>
              <label htmlFor="edit-narrator" className="block text-xs font-medium text-muted-foreground mb-1.5">
                Narrator
              </label>
              <input
                id="edit-narrator"
                type="text"
                value={narrator}
                onChange={(e) => setNarrator(e.target.value)}
                className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
              />
            </div>

            {/* Divider + Search Audnexus */}
            <div className="pt-1">
              <div className="border-t border-white/5 mb-3" />
              <button
                type="button"
                onClick={handleOpenSearch}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
              >
                <SearchIcon className="w-3.5 h-3.5" />
                Search Audnexus for metadata
              </button>
            </div>

            {/* Rename files checkbox */}
            {hasPath && (
              <div className="pt-1">
                <div className="border-t border-white/5 mb-4" />
                <label className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={renameFiles}
                    onChange={(e) => setRenameFiles(e.target.checked)}
                    className="w-4 h-4 rounded border-white/20 bg-transparent text-primary focus:ring-primary/30 focus:ring-offset-0"
                  />
                  <div>
                    <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                      Rename files after saving
                    </span>
                    <p className="text-xs text-muted-foreground/50 mt-0.5">
                      Reorganize folder and filenames to match format templates
                    </p>
                  </div>
                </label>
              </div>
            )}
          </div>
        ) : (
          /* Search view */
          <div className="p-6 space-y-4 overflow-y-auto">
            {/* Search input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search by title and author..."
                className="flex-1 px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                aria-label="Search query"
                autoFocus
              />
              <button
                type="button"
                onClick={handleSearch}
                disabled={!searchQuery.trim() || searchMutation.isPending}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
              >
                {searchMutation.isPending ? (
                  <LoadingSpinner className="w-3.5 h-3.5" />
                ) : (
                  <SearchIcon className="w-3.5 h-3.5" />
                )}
                Search
              </button>
            </div>

            {/* Search error */}
            {searchError && (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <AlertCircleIcon className="w-3.5 h-3.5 shrink-0" />
                {searchError}
              </div>
            )}

            {/* Search results */}
            {searchResults.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground/70">Select a match</p>
                <div className="max-h-72 overflow-y-auto space-y-1 -mx-1 px-1">
                  {searchResults.slice(0, 8).map((meta, i) => (
                    <button
                      key={meta.asin || meta.providerId || i}
                      onClick={() => applyMetadata(meta)}
                      className="w-full flex items-center gap-3 px-2.5 py-2 text-left rounded-xl hover:bg-muted/40 border border-transparent hover:border-border/30 transition-all group"
                    >
                      <div className="w-9 h-12 shrink-0 rounded-md overflow-hidden bg-muted/30 relative">
                        {meta.coverUrl ? (
                          <img src={meta.coverUrl} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <SearchIcon className="w-3 h-3 text-muted-foreground/20" />
                          </div>
                        )}
                        <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-md" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate group-hover:text-primary transition-colors">{meta.title}</p>
                        <p className="text-xs text-muted-foreground/60 truncate">
                          {meta.authors?.map(a => a.name).join(', ')}
                        </p>
                        {meta.narrators && meta.narrators.length > 0 && (
                          <p className="text-[10px] text-muted-foreground/40 truncate flex items-center gap-1">
                            <HeadphonesIcon className="w-2.5 h-2.5 shrink-0" />
                            {meta.narrators.join(', ')}
                          </p>
                        )}
                        {meta.series && meta.series.length > 0 && (
                          <p className="text-[10px] text-muted-foreground/40 truncate">
                            {meta.series[0].name}{meta.series[0].position != null ? ` #${meta.series[0].position}` : ''}
                          </p>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* No results */}
            {hasSearched && searchResults.length === 0 && !searchError && (
              <p className="text-xs text-muted-foreground/50 text-center py-2">
                No results found. Try a different search query.
              </p>
            )}

            {/* Initial state — before first search */}
            {!hasSearched && !searchMutation.isPending && !searchError && (
              <p className="text-xs text-muted-foreground/40 text-center py-4">
                Search to find metadata and auto-fill fields.
              </p>
            )}
          </div>
        )}

        {/* Footer — only in edit view */}
        {view === 'edit' && (
          <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3 shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
