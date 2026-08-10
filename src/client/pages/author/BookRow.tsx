import { Link } from 'react-router';
import { type BookMetadata } from '@/lib/api';
import { formatDurationMinutes } from '@/lib/format';
import { resolveUrl } from '@/lib/url-utils';
import { AddBookPopover } from '@/components/AddBookPopover';
import { BookOpenIcon, CheckIcon } from '@/components/icons';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

export function BookRow({
  book,
  libraryBookId,
  onAdd,
  isAdding,
}: {
  book: BookMetadata;
  /** The owned book's id, or null when this edition is not in the library. Null also drives the Add affordance. */
  libraryBookId: number | null;
  onAdd: (overrides: { searchImmediately: boolean }) => void;
  isAdding: boolean;
}) {
  // Audible series[0] may be a broader universe; use canonical seriesPrimary.
  const seriesPos = pickPrimarySeries(book)?.position;
  const duration = formatDurationMinutes(book.duration);
  const narratorNames = book.narrators?.join(', ');

  return (
    <div className="flex items-center gap-3 sm:gap-4 py-3 group">
      <div className="shrink-0">
        <div className="relative w-10 sm:w-12 aspect-square rounded-lg overflow-hidden ring-1 ring-black/10 transition-transform duration-200 group-hover:scale-105">
          {book.coverUrl ? (
            <img
              src={resolveUrl(book.coverUrl)}
              alt={`Cover of ${book.title}`}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-muted">
              <BookOpenIcon className="w-4 h-4 text-muted-foreground/30" />
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium line-clamp-1">
          {seriesPos != null && (
            <span className="text-muted-foreground font-normal">#{seriesPos} </span>
          )}
          {libraryBookId !== null ? (
            <Link to={`/books/${libraryBookId}`} className="hover:underline focus-ring rounded" data-testid="author-book-title-link">
              {book.title}
            </Link>
          ) : (
            book.title
          )}
        </span>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 line-clamp-1">
          {narratorNames && <span>{narratorNames}</span>}
          {narratorNames && duration && <span>&middot;</span>}
          {duration && <span>{duration}</span>}
        </div>
      </div>

      <div className="shrink-0">
        {libraryBookId !== null ? (
          <Link
            to={`/books/${libraryBookId}`}
            className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-success/10 text-success hover:bg-success/20 transition-colors focus-ring"
            aria-label="View this book in your library"
          >
            <CheckIcon className="w-4 h-4" />
          </Link>
        ) : (
          <AddBookPopover onAdd={onAdd} isPending={isAdding} />
        )}
      </div>
    </div>
  );
}
