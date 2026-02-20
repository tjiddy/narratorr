import { type BookMetadata } from '@/lib/api';
import { formatDuration } from '@/lib/helpers';
import { BookOpenIcon, PlusIcon, CheckIcon, LoadingSpinner } from '@/components/icons';

export function BookRow({
  book,
  inLibrary,
  onAdd,
  isAdding,
}: {
  book: BookMetadata;
  inLibrary: boolean;
  onAdd: () => void;
  isAdding: boolean;
}) {
  const seriesPos = book.series?.[0]?.position;
  const duration = formatDuration(book.duration);
  const narratorNames = book.narrators?.join(', ');

  return (
    <div className="flex items-center gap-3 sm:gap-4 py-3 group">
      {/* Cover thumbnail */}
      <div className="shrink-0">
        <div className="relative w-10 sm:w-12 aspect-square rounded-lg overflow-hidden ring-1 ring-black/10 transition-transform duration-200 group-hover:scale-105">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
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

      {/* Book info */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium line-clamp-1">
          {seriesPos != null && (
            <span className="text-muted-foreground font-normal">#{seriesPos} </span>
          )}
          {book.title}
        </span>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5 line-clamp-1">
          {narratorNames && <span>{narratorNames}</span>}
          {narratorNames && duration && <span>&middot;</span>}
          {duration && <span>{duration}</span>}
        </div>
      </div>

      {/* Add button */}
      <div className="shrink-0">
        {inLibrary ? (
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-success/10 text-success">
            <CheckIcon className="w-4 h-4" />
          </span>
        ) : (
          <button
            onClick={onAdd}
            disabled={isAdding}
            className="inline-flex items-center justify-center w-9 h-9 rounded-xl glass-card hover:border-primary/30 hover:text-primary transition-all focus-ring disabled:opacity-50"
            title={`Add "${book.title}" to library`}
          >
            {isAdding ? (
              <LoadingSpinner className="w-4 h-4" />
            ) : (
              <PlusIcon className="w-4 h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
