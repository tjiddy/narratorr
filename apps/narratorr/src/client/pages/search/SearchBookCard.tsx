import { useState } from 'react';
import { CoverImage } from '@/components/CoverImage';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type BookMetadata, type BookWithAuthor } from '@/lib/api';
import { toast } from 'sonner';
import { formatDuration, mapBookMetadataToPayload, isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';
import {
  BookOpenIcon,
  UsersIcon,
  CheckCircleIcon,
  PlusIcon,
  LoadingSpinner,
  ClockIcon,
} from '@/components/icons';

export function SearchBookCard({
  book,
  index,
  libraryBooks,
  queryClient,
}: {
  book: BookMetadata;
  index: number;
  libraryBooks?: BookWithAuthor[];
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [justAdded, setJustAdded] = useState(false);
  const authorNames = book.authors.map((a) => a.name).join(', ');
  const seriesInfo = book.series?.[0];
  const inLibrary = justAdded || isBookInLibrary(book, libraryBooks);

  const addMutation = useMutation({
    mutationFn: () => api.addBook(mapBookMetadataToPayload(book)),
    onSuccess: () => {
      setJustAdded(true);
      toast.success(`Added '${book.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) {
        setJustAdded(true);
        toast.info('Already in library');
        queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      } else {
        toast.error(`Failed to add book: ${error.message}`);
      }
    },
  });

  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex gap-4 sm:gap-5">
        {/* Cover Image */}
        <div className="shrink-0">
          <CoverImage
            src={book.coverUrl}
            alt={book.title}
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl"
            fallback={<BookOpenIcon className="w-8 h-8 text-muted-foreground" />}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="font-display text-lg sm:text-xl font-semibold line-clamp-2 group-hover:text-primary transition-colors">
            {book.title}
          </h3>

          {authorNames && (
            <p className="text-muted-foreground mt-1">
              by <span className="text-foreground font-medium">{authorNames}</span>
            </p>
          )}

          {book.narrators && book.narrators.length > 0 && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <UsersIcon className="w-3.5 h-3.5" />
              Narrated by {book.narrators.join(', ')}
            </p>
          )}

          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-3 mt-auto pt-3">
            {seriesInfo && (
              <span className="text-sm text-muted-foreground">
                {seriesInfo.name}
                {seriesInfo.position != null && ` #${seriesInfo.position}`}
              </span>
            )}
            {book.duration && (
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <ClockIcon className="w-3.5 h-3.5" />
                {formatDuration(book.duration)}
              </span>
            )}
            {book.genres && book.genres.length > 0 && book.genres.slice(0, 3).map((genre) => (
              <span key={genre} className="text-xs px-2 py-1 bg-muted rounded-lg font-medium text-muted-foreground">
                {genre}
              </span>
            ))}
          </div>
        </div>

        {/* Add Button */}
        <div className="shrink-0 flex items-center">
          {inLibrary ? (
            <span className="flex items-center gap-2 px-4 py-2.5 text-success font-medium">
              <CheckCircleIcon className="w-4 h-4" />
              <span className="hidden sm:inline">In Library</span>
            </span>
          ) : (
            <button
              onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending}
              className="
                flex items-center gap-2 px-4 py-2.5
                bg-primary text-primary-foreground font-medium rounded-xl
                hover:opacity-90 hover:shadow-glow
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-all duration-200 focus-ring
              "
            >
              {addMutation.isPending ? (
                <>
                  <LoadingSpinner className="w-4 h-4" />
                  <span className="hidden sm:inline">Adding...</span>
                </>
              ) : (
                <>
                  <PlusIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">Add</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
