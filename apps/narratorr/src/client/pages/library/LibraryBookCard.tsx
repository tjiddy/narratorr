import { useImageError } from '@/hooks/useImageError';
import type { BookWithAuthor } from '@/lib/api';
import { bookStatusConfig } from '@/lib/status';
import { BookOpenIcon, MoreVerticalIcon, BrokenLinkIcon } from '@/components/icons';
import { BookContextMenu } from './BookContextMenu.js';

export function LibraryBookCard({
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
  const isMissing = book.status === 'missing' || book.status === 'failed';

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      className="group relative rounded-2xl overflow-hidden cursor-pointer shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 ease-out animate-fade-in-up"
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

        {/* Missing/failed indicator chip */}
        {isMissing && (
          <div
            className="absolute top-2 left-2 z-10 w-7 h-7 flex items-center justify-center rounded-lg backdrop-blur-md bg-black/40 ring-1 ring-red-500/20 shadow-[0_0_8px_-2px_rgba(239,68,68,0.3)]"
            title="Files missing from disk"
          >
            <BrokenLinkIcon className="w-3.5 h-3.5 text-red-400 drop-shadow-[0_0_3px_rgba(239,68,68,0.4)]" />
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
          {/* Status bar */}
          <div className={`h-0.5 ${(bookStatusConfig[book.status] ?? bookStatusConfig.wanted).barClass}`} data-testid="status-bar" />
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
