import { memo, useRef } from 'react';
import { useImageError } from '@/hooks/useImageError';
import { useClickOutside } from '@/hooks/useClickOutside';
import type { BookWithAuthor } from '@/lib/api';
import { bookStatusConfig } from '@/lib/status';
import { resolveCoverUrl } from '@/lib/url-utils';
import { BookOpenIcon, MoreVerticalIcon, BrokenLinkIcon } from '@/components/icons';
import { useRetryImportAvailable } from '@/hooks/useRetryImportAvailable.js';
import { BookContextMenu } from './BookContextMenu.js';

// eslint-disable-next-line complexity -- card has inherent conditional rendering: cover, missing chip, collapsed badge, status bar, menu, hover expand
export const LibraryBookCard = memo(function LibraryBookCard({
  book,
  index,
  collapsedCount,
  isMenuOpen,
  onMenuToggle,
  onMenuClose,
  onClick,
  onSearchReleases,
  onRemove,
  onRetryImport,
}: {
  book: BookWithAuthor;
  index: number;
  collapsedCount?: number;
  isMenuOpen: boolean;
  onMenuToggle: (bookId: number, e: React.MouseEvent) => void;
  onMenuClose: () => void;
  onClick: (bookId: number) => void;
  onSearchReleases: (book: BookWithAuthor) => void;
  onRemove: (book: BookWithAuthor) => void;
  onRetryImport?: (book: BookWithAuthor) => void;
}) {
  const { hasError: imageError, onError: onImageError } = useImageError();
  const menuAreaRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuAreaRef, onMenuClose, isMenuOpen);
  const canRetryImport = useRetryImportAvailable(book.id, book.status);
  const isMissing = book.status === 'missing' || book.status === 'failed';
  const isCollapsed = (collapsedCount ?? 0) > 0;

  return (
    <div
      role="link"
      tabIndex={0}
      onClick={() => onClick(book.id)}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick(book.id); }}
      className="group relative rounded-2xl overflow-hidden cursor-pointer shadow-card hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${Math.min(index, 9) * 50}ms` }}
    >
      {/* Cover — square */}
      <div className="relative aspect-square bg-muted overflow-hidden">
        {book.coverUrl && !imageError ? (
          <img
            src={resolveCoverUrl(book.coverUrl, book.updatedAt)}
            alt={book.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105 origin-bottom"
            loading="lazy"
            onError={onImageError}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-muted to-muted/40">
            <BookOpenIcon className="w-12 h-12 text-muted-foreground/20" />
          </div>
        )}

        {/* Top-left chip stack — missing indicator + collapsed badge */}
        {(isMissing || (collapsedCount != null && collapsedCount > 0)) && (
          <div className="absolute top-2 left-2 z-10 flex flex-col gap-1.5">
            {isMissing && (
              <div
                className="w-7 h-7 flex items-center justify-center rounded-lg backdrop-blur-md bg-black/40 ring-1 ring-red-500/20 shadow-[0_0_8px_-2px_rgba(239,68,68,0.3)]"
                title="Files missing from disk"
              >
                <BrokenLinkIcon className="w-3.5 h-3.5 text-red-400 drop-shadow-[0_0_3px_rgba(239,68,68,0.4)]" />
              </div>
            )}
            {collapsedCount != null && collapsedCount > 0 && (
              <div
                className="bg-amber-500 text-black rounded-full font-bold text-[11px] px-2.5 py-0.5 shadow-lg shadow-amber-500/30 tracking-wide"
                data-testid="collapsed-badge"
              >
                {collapsedCount + 1} books
              </div>
            )}
          </div>
        )}

        {/* Vignette + gradient fade toward overlay */}
        <div className="absolute inset-0 ring-1 ring-inset ring-white/5" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 via-black/20 to-transparent pointer-events-none" />

        {/* Context menu — hover-reveal only */}
        <div ref={menuAreaRef} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 no-hover:opacity-100 transition-opacity duration-200">
          <button
            onClick={(e) => { e.stopPropagation(); onMenuToggle(book.id, e); }}
            className={`p-1.5 rounded-lg backdrop-blur-md text-white/80 hover:text-white transition-all focus-ring ${isMenuOpen ? 'bg-black/70 text-white opacity-100' : 'bg-black/40 hover:bg-black/60'}`}
            aria-label="Book options"
            aria-expanded={isMenuOpen}
            aria-haspopup="true"
          >
            <MoreVerticalIcon className="w-3.5 h-3.5" />
          </button>

          {isMenuOpen && (
            <BookContextMenu
              onSearchReleases={() => onSearchReleases(book)}
              onRemove={() => onRemove(book)}
              onClose={onMenuClose}
              onRetryImport={onRetryImport && canRetryImport ? () => onRetryImport(book) : undefined}
            />
          )}
        </div>

        {/* Frosted info strip — always visible at bottom */}
        <div className="absolute inset-x-0 bottom-0 backdrop-blur-md bg-black/30 border-t border-white/5 transition-all duration-300 ease-out">
          {/* Status bar */}
          <div className={`h-0.5 ${(bookStatusConfig[book.status] ?? bookStatusConfig.wanted)!.barClass}`} data-testid="status-bar" />
          {/* Default: title + author */}
          <div className="px-3 py-2">
            <h3 className="text-sm font-semibold text-white leading-tight truncate drop-shadow-sm">{isCollapsed ? (book.seriesName || book.title) : book.title}</h3>
            <p className="text-xs text-white/70 truncate mt-0.5">{book.authors[0]?.name}</p>
          </div>

          {/* Hover expand: narrator + series */}
          {!isCollapsed && (book.narrators.length > 0 || book.seriesName) && (
            <div className="max-h-0 opacity-0 group-hover:max-h-16 group-hover:opacity-100 no-hover:max-h-16 no-hover:opacity-100 overflow-hidden transition-all duration-300 ease-out">
              <div className="px-3 pb-2 flex flex-wrap gap-x-3 gap-y-0.5">
                {book.narrators.length > 0 && (
                  <p className="text-[11px] text-white/50 truncate">{book.narrators[0]!.name}</p>
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
});
