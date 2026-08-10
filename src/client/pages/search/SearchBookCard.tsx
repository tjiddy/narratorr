import { useState } from 'react';
import { Link } from 'react-router';
import { CoverImage } from '@/components/CoverImage';
import { AddBookPopover } from '@/components/AddBookPopover';
import { InLibraryBadge } from '@/components/InLibraryBadge';
import { Badge } from '@/components/Badge';
import { useMutation, type useQueryClient } from '@tanstack/react-query';
import { api, ApiError, parseAddBookConflict, type BookMetadata, type LibraryEntry } from '@/lib/api';
import { toast } from 'sonner';
import { mapBookMetadataToPayload, findLibraryMatch, type LibraryMatch } from '@/lib/helpers';
import { formatDurationMinutes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import {
  BookOpenIcon,
  HeadphonesIcon,
  ClockIcon,
} from '@/components/icons';

// A completed add/409 wins; exact-ASIN matches link, while title-only matches keep Add and show the related-edition badge.
function deriveOwnership(
  libraryMatch: LibraryMatch<LibraryEntry> | null,
  justAddedBookId: number | null,
): { inLibraryBookId: number | null; showRelatedEditionBadge: boolean } {
  const inLibraryBookId = justAddedBookId ?? (libraryMatch?.kind === 'exact-asin' ? libraryMatch.entry.id : null);
  return {
    inLibraryBookId,
    showRelatedEditionBadge: inLibraryBookId === null && libraryMatch?.kind === 'title-identity',
  };
}

/** The overrides the popover collects, plus the operator's explicit review override. */
type AddOverrides = { searchImmediately: boolean; overrideRecordingReview?: boolean };

/** Held so the operator can accept the risk; `overrides` replays the popover's search choice. */
type ReviewConflict = { incumbentTitle: string | null; overrides: AddOverrides | undefined };

export function SearchBookCard({
  book,
  index,
  libraryBooks,
  queryClient,
}: {
  book: BookMetadata;
  index: number;
  libraryBooks?: LibraryEntry[] | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [justAddedBookId, setJustAddedBookId] = useState<number | null>(null);
  const [reviewConflict, setReviewConflict] = useState<ReviewConflict | null>(null);
  const authorNames = book.authors.map((a) => a.name).join(', ');
  // Audible series[0] may be a broader universe; use canonical seriesPrimary.
  const seriesInfo = pickPrimarySeries(book);
  const libraryMatch = findLibraryMatch(book, libraryBooks);
  const { inLibraryBookId, showRelatedEditionBadge } = deriveOwnership(libraryMatch, justAddedBookId);

  const addMutation = useMutation({
    mutationFn: (overrides?: AddOverrides) =>
      api.addBook(mapBookMetadataToPayload(book, overrides)),
    onSuccess: (created) => {
      setReviewConflict(null);
      setJustAddedBookId(created.id);
      toast.success(`Added '${book.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error, overrides) => {
      if (error instanceof ApiError && error.status === 409) {
        // The 409 body is the incumbent row plus the conflict discriminator.
        const { conflict, incumbentId, incumbentTitle } = parseAddBookConflict(error.body);
        // `review` is an abstention, not an ownership claim, so the card must stay addable.
        if (conflict === 'review') {
          setReviewConflict({ incumbentTitle, overrides });
          return;
        }
        setJustAddedBookId(incumbentId);
        toast.info('Already in library');
        queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      } else {
        toast.error(`Failed to add book: ${getErrorMessage(error)}`);
      }
    },
  });

  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex gap-4 sm:gap-5">
        <div className="shrink-0">
          <CoverImage
            src={book.coverUrl}
            alt={book.title}
            className="w-20 h-20 sm:w-24 sm:h-24 rounded-xl"
            fallback={<BookOpenIcon className="w-8 h-8 text-muted-foreground" />}
          />
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="font-display text-lg sm:text-xl font-semibold line-clamp-2 group-hover:text-primary transition-colors">
            {inLibraryBookId !== null ? (
              <Link to={`/books/${inLibraryBookId}`} className="hover:underline focus-ring rounded" data-testid="search-card-title-link">
                {book.title}
              </Link>
            ) : (
              book.title
            )}
          </h3>

          {authorNames && (
            <p className="text-muted-foreground mt-1">
              by <span className="text-foreground font-medium">{authorNames}</span>
            </p>
          )}

          {/* Keep this badge in the flexible content column so it cannot crowd the Add control. */}
          {showRelatedEditionBadge && (
            <div className="mt-1.5">
              <Badge variant="muted">Edition in library</Badge>
            </div>
          )}

          {reviewConflict && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2" role="status">
              <Badge variant="warning">Possible duplicate (review)</Badge>
              <span className="text-sm text-muted-foreground">
                {reviewConflict.incumbentTitle
                  ? `May be the same recording as '${reviewConflict.incumbentTitle}'.`
                  : 'May be the same recording as a book already in your library.'}
              </span>
              <button
                type="button"
                onClick={() => addMutation.mutate({
                  searchImmediately: reviewConflict.overrides?.searchImmediately ?? false,
                  overrideRecordingReview: true,
                })}
                disabled={addMutation.isPending}
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50 focus-ring rounded"
              >
                Add anyway
              </button>
            </div>
          )}

          {book.narrators && book.narrators.length > 0 && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <HeadphonesIcon className="w-3.5 h-3.5" />
              Narrated by {book.narrators.join(', ')}
            </p>
          )}

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
                {formatDurationMinutes(book.duration)}
              </span>
            )}
            {book.genres && book.genres.length > 0 && book.genres.slice(0, 3).map((genre) => (
              <span key={genre} className="text-xs px-2 py-1 bg-muted rounded-lg font-medium text-muted-foreground">
                {genre}
              </span>
            ))}
          </div>
        </div>

        <div className="shrink-0 flex items-center">
          {inLibraryBookId !== null ? (
            <InLibraryBadge bookId={inLibraryBookId} />
          ) : (
            <AddBookPopover
              onAdd={(overrides) => addMutation.mutate(overrides)}
              isPending={addMutation.isPending}
            />
          )}
        </div>
      </div>
    </div>
  );
}
