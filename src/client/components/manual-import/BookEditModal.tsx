import { useState, useRef } from 'react';
import { type BookMetadata, type DiscoveredBook } from '@/lib/api';
import { formatBytes } from '@/lib/api';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useAudnexusSearch } from '@/hooks/useAudnexusSearch';
import { resolveUrl } from '@/lib/url-utils';
import { isBookInLibrary } from '@/lib/helpers';
import { useBookIdentifiers } from '@/hooks/useLibrary';
import {
  XIcon,
  SearchIcon,
  LoadingSpinner,
  BookOpenIcon,
  HeadphonesIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from '@/components/icons';
import { Badge } from '@/components/Badge';
import { Modal } from '@/components/Modal';
import { MetadataResultList } from '@/components/book/MetadataResultList';
import type { BookEditState } from './types.js';
export type { BookEditState } from './types.js';

interface BookEditModalProps {
  book: DiscoveredBook;
  initial: BookEditState;
  confidence?: 'high' | 'medium' | 'none' | undefined;
  alternatives?: BookMetadata[] | undefined;
  onSave: (state: BookEditState) => void;
  onClose: () => void;
  isOpen?: boolean | undefined;
}

// eslint-disable-next-line max-lines-per-function, complexity -- metadata edit form with preview, search, and multi-field validation
export function BookEditModal({ book, initial, confidence, alternatives, onSave, onClose, isOpen = true }: BookEditModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const { data: libraryBooks } = useBookIdentifiers();
  const [title, setTitle] = useState(initial.title);
  const [author, setAuthor] = useState(initial.author);
  const [series, setSeries] = useState(initial.series);
  const [narrators, setNarrators] = useState<string>(initial.narrators?.join(', ') ?? '');
  const [seriesPosition, setSeriesPosition] = useState<string>(
    initial.seriesPosition !== undefined ? String(initial.seriesPosition) : '',
  );
  const [selectedMetadata, setSelectedMetadata] = useState<BookMetadata | null>(initial.metadata ?? null);

  const initialResults = (() => {
    if (initial.metadata && alternatives?.length) {
      return [initial.metadata, ...alternatives];
    }
    if (initial.metadata) return [initial.metadata];
    if (alternatives?.length) return alternatives;
    return [];
  })();

  const { searchResults, hasSearched, isPending, search } = useAudnexusSearch({ initialResults });

  useEscapeKey(isOpen, onClose, modalRef);

  if (!isOpen) return null;

  const applyMetadata = (meta: BookMetadata) => {
    setSelectedMetadata({ ...meta });
    setTitle(meta.title);
    if (meta.authors?.[0]?.name) {
      setAuthor(meta.authors[0].name);
    }
    setSeries(meta.series?.[0]?.name ?? '');
    setNarrators(meta.narrators?.join(', ') ?? '');
    setSeriesPosition(meta.series?.[0]?.position !== undefined ? String(meta.series[0].position) : '');
  };

  const handleSearch = () => {
    const query = [title, author].filter(Boolean).join(' ');
    search(query);
  };

  const handleSave = () => {
    const parsedNarrators = narrators
      .split(',')
      .map(n => n.trim())
      .filter(Boolean);

    const trimmedSeries = series.trim();
    const numericPosition = seriesPosition.trim() ? Number(seriesPosition.trim()) : undefined;
    // Number.isFinite (not !Number.isNaN) — rejects Infinity too, since `Number('1e999') === Infinity`
    // would JSON-serialize to `null` and be rejected by the route's `z.number()` schema.
    const parsedPosition = (trimmedSeries && numericPosition !== undefined && Number.isFinite(numericPosition))
      ? numericPosition
      : undefined;

    onSave({
      title: title.trim(),
      author: author.trim(),
      series: trimmedSeries,
      ...(parsedNarrators.length > 0 && { narrators: parsedNarrators }),
      ...(parsedPosition !== undefined && { seriesPosition: parsedPosition }),
      coverUrl: selectedMetadata?.coverUrl,
      asin: selectedMetadata?.asin,
      metadata: selectedMetadata ?? undefined,
    });
  };

  return (
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-lg flex flex-col max-h-[85vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-edit-modal-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 id="book-edit-modal-title" className="font-display text-lg font-semibold tracking-tight">Edit Book</h2>
            <p className="text-xs text-muted-foreground/50 truncate mt-0.5">{book.path}</p>
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

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Metadata preview */}
          <div className="flex gap-4">
            <div className="w-[80px] h-[80px] shrink-0 rounded-lg overflow-hidden bg-muted/50 relative">
              {selectedMetadata?.coverUrl ? (
                <img src={resolveUrl(selectedMetadata.coverUrl)} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted/80 to-muted/30">
                  <BookOpenIcon className="w-6 h-6 text-muted-foreground/20" />
                </div>
              )}
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-lg" />
            </div>
            <div className="flex-1 min-w-0 py-0.5">
              {selectedMetadata ? (
                <div className="space-y-1">
                  <div className="flex items-start gap-2">
                    <p className="text-sm font-semibold leading-tight line-clamp-2 flex-1">{selectedMetadata.title}</p>
                    {isBookInLibrary(selectedMetadata, libraryBooks) && (
                      <Badge variant="success" icon={CheckCircleIcon} className="shrink-0">
                        In library
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {selectedMetadata.authors?.map(a => a.name).join(', ')}
                  </p>
                  {selectedMetadata.narrators && selectedMetadata.narrators.length > 0 && (
                    <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                      <HeadphonesIcon className="w-3 h-3 shrink-0" />
                      {selectedMetadata.narrators.join(', ')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2 text-sm text-muted-foreground py-1">
                  <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-400/80" />
                  <span className="text-xs leading-relaxed">No metadata match. Edit fields and search.</span>
                </div>
              )}
            </div>
          </div>

          {/* Editable fields */}
          <div className="space-y-3">
            <div>
              <label htmlFor="edit-title" className="block text-xs font-medium text-muted-foreground mb-1.5">Title</label>
              <input
                id="edit-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="edit-author" className="block text-xs font-medium text-muted-foreground mb-1.5">Author</label>
                <input
                  id="edit-author"
                  type="text"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                  className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                />
              </div>
              <div>
                <label htmlFor="edit-series" className="block text-xs font-medium text-muted-foreground mb-1.5">Series</label>
                <input
                  id="edit-series"
                  type="text"
                  value={series}
                  onChange={(e) => setSeries(e.target.value)}
                  className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label htmlFor="edit-narrators" className="block text-xs font-medium text-muted-foreground mb-1.5">Narrators</label>
                <input
                  id="edit-narrators"
                  type="text"
                  value={narrators}
                  onChange={(e) => setNarrators(e.target.value)}
                  className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring"
                />
              </div>
              <div>
                <label htmlFor="edit-series-position" className="block text-xs font-medium text-muted-foreground mb-1.5">Series Position</label>
                <input
                  id="edit-series-position"
                  type="number"
                  value={seriesPosition}
                  onChange={(e) => setSeriesPosition(e.target.value)}
                  disabled={!series.trim()}
                  className="w-full px-3 py-2 glass-card rounded-xl text-sm focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* File info + search */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground/50">
              {book.fileCount} file{book.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(book.totalSize)}
            </span>
            <button
              type="button"
              onClick={handleSearch}
              disabled={isPending || (!title.trim() && !author.trim())}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all disabled:opacity-40 focus-ring ${
                confidence === 'none'
                  ? 'bg-primary text-primary-foreground hover:opacity-90'
                  : 'glass-card hover:border-primary/30 hover:text-primary'
              }`}
            >
              {isPending ? (
                <LoadingSpinner className="w-3 h-3" />
              ) : (
                <SearchIcon className="w-3 h-3" />
              )}
              Search Providers
            </button>
          </div>

          {/* Alternative search results */}
          {searchResults.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground/70">
                {confidence === 'medium' ? 'Pick the correct match' : confidence === 'none' ? 'Possible matches' : 'Other matches'}
              </p>
              <MetadataResultList
                results={searchResults}
                limit={6}
                maxHeight="max-h-36"
                onSelect={applyMetadata}
                showDuration
                showLibraryBadge
                libraryBooks={libraryBooks}
                placeholderIcon={<BookOpenIcon className="w-3 h-3 text-muted-foreground/20" />}
              />
            </div>
          )}

          {/* No results message */}
          {hasSearched && searchResults.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-2">
              No results found. Try a different title or author.
            </p>
          )}
        </div>

        {/* Footer */}
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
            disabled={!title.trim()}
            className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
