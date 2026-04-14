import { useState, useRef } from 'react';
import type { BookWithAuthor, UpdateBookPayload, BookMetadata } from '@/lib/api';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useAudnexusSearch } from '@/hooks/useAudnexusSearch';
import { XIcon, SearchIcon, ArrowLeftIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { MetadataSearchView } from '@/components/book/MetadataSearchView';

type SearchView = 'edit' | 'search';

interface BookMetadataModalProps {
  book: BookWithAuthor;
  onSave: (data: UpdateBookPayload, renameFiles: boolean) => void;
  onClose: () => void;
  isSaving: boolean;
  isOpen?: boolean;
}

// eslint-disable-next-line max-lines-per-function, complexity -- metadata edit modal with search integration
export function BookMetadataModal({ book, onSave, onClose, isSaving, isOpen = true }: BookMetadataModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(book.title);
  const [seriesName, setSeriesName] = useState(book.seriesName ?? '');
  const [seriesPosition, setSeriesPosition] = useState(book.seriesPosition?.toString() ?? '');
  const [narrator, setNarrator] = useState(book.narrators.map((n) => n.name).join(', '));
  const [renameFiles, setRenameFiles] = useState(false);

  const [view, setView] = useState<SearchView>('edit');
  const [searchQuery, setSearchQuery] = useState('');
  const { searchResults, hasSearched, searchError, isPending, search } = useAudnexusSearch();

  useEscapeKey(isOpen, onClose, modalRef);

  if (!isOpen) return null;

  const canSave = title.trim().length > 0 && !isSaving;
  const hasPath = !!book.path;
  const positionError = seriesPosition.trim() !== '' && isNaN(Number(seriesPosition.trim()))
    ? 'Must be a number'
    : null;

  const handleOpenSearch = () => {
    const prefill = [book.title, book.authors[0]?.name ?? ''].filter(Boolean).join(' ').trim();
    setSearchQuery(prefill);
    setView('search');
    if (prefill) search(prefill);
  };

  const handleSearch = () => {
    search(searchQuery);
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

    const existingNarrator = book.narrators.map((n) => n.name).join(', ');
    if (narrator.trim() !== existingNarrator) {
      data.narrators = narrator.trim() ? narrator.trim().split(',').map((n) => n.trim()).filter(Boolean) : [];
    }

    onSave(data, renameFiles);
  };

  return (
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-lg flex flex-col max-h-[85vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-metadata-modal-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            {view === 'search' && (
              <button
                type="button"
                onClick={handleDismissSearch}
                className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
                aria-label="Back to edit"
              >
                <ArrowLeftIcon className="w-4 h-4" />
              </button>
            )}
            <h2 id="book-metadata-modal-title" className="font-display text-lg font-semibold tracking-tight">
              {view === 'search' ? 'Search Metadata' : 'Edit Metadata'}
            </h2>
          </div>
          <button
            type="button"
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

            {/* Divider + Search metadata */}
            <div className="pt-1">
              <div className="border-t border-white/5 mb-3" />
              <button
                type="button"
                onClick={handleOpenSearch}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
              >
                <SearchIcon className="w-3.5 h-3.5" />
                Search for metadata
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
          <MetadataSearchView
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            isPending={isPending}
            searchResults={searchResults}
            hasSearched={hasSearched}
            searchError={searchError}
            onSearch={handleSearch}
            onApplyMetadata={applyMetadata}
          />
        )}

        {/* Footer — only in edit view */}
        {view === 'edit' && (
          <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
