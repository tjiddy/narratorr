import { useState } from 'react';
import { CoverImage } from '@/components/CoverImage';
import { AddBookPopover } from '@/components/AddBookPopover';
import { InLibraryBadge } from '@/components/InLibraryBadge';
import { Badge } from '@/components/Badge';
import { useMutation, type useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type BookMetadata, type BookWithAuthor } from '@/lib/api';
import { toast } from 'sonner';
import { mapBookMetadataToPayload, findLibraryMatch, type LibraryMatch } from '@/lib/helpers';
import { formatDurationMinutes } from '@/lib/format';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { pickPrimarySeries } from '../../../shared/pick-primary-series.js';
import {
  BookOpenIcon,
  HeadphonesIcon,
  ClockIcon,
} from '@/components/icons';

// Derived ownership read-out (#1907), extracted so the card component stays under
// the complexity cap. `inLibraryBookId` is the linked-"In Library" id: a completed
// add/409 (`justAddedBookId`) always wins; otherwise only an exact-ASIN match
// contributes a pre-existing id (derived-state-over-copied). A title-identity match
// links to nothing until an add/409 completes, so it keeps its Add control and shows
// the related-edition badge instead of ever linking to the incumbent edition (AC5).
function deriveOwnership(
  libraryMatch: LibraryMatch<BookWithAuthor> | null,
  justAddedBookId: number | null,
): { inLibraryBookId: number | null; showRelatedEditionBadge: boolean } {
  const inLibraryBookId = justAddedBookId ?? (libraryMatch?.kind === 'exact-asin' ? libraryMatch.entry.id : null);
  return {
    inLibraryBookId,
    showRelatedEditionBadge: inLibraryBookId === null && libraryMatch?.kind === 'title-identity',
  };
}

export function SearchBookCard({
  book,
  index,
  libraryBooks,
  queryClient,
}: {
  book: BookMetadata;
  index: number;
  libraryBooks?: BookWithAuthor[] | undefined;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [justAddedBookId, setJustAddedBookId] = useState<number | null>(null);
  const authorNames = book.authors.map((a) => a.name).join(', ');
  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) — `series[0]`
  // on Audible can be a broader universe entry rather than the real book series.
  const seriesInfo = pickPrimarySeries(book);
  const libraryMatch = findLibraryMatch(book, libraryBooks);
  const { inLibraryBookId, showRelatedEditionBadge } = deriveOwnership(libraryMatch, justAddedBookId);

  const addMutation = useMutation({
    mutationFn: (overrides?: { searchImmediately: boolean }) =>
      api.addBook(mapBookMetadataToPayload(book, overrides)),
    onSuccess: (created) => {
      setJustAddedBookId(created.id);
      toast.success(`Added '${book.title}' to library`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: Error) => {
      if (error instanceof ApiError && error.status === 409) {
        // 409 body is the existing book row (see src/server/routes/books.ts:141)
        const existingId = typeof error.body === 'object' && error.body !== null && 'id' in error.body && typeof (error.body as { id: unknown }).id === 'number'
          ? (error.body as { id: number }).id
          : null;
        setJustAddedBookId(existingId);
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

          {/* Related-edition indicator (#1907). Lives in the content column — not
              the action column — so it wraps with the title/metadata on narrow
              screens instead of competing with the Add control for the fixed
              `shrink-0` action width. Shown only in the related-edition state
              (title-identity match, no completed add/409 yet); an exact-ASIN
              match or a completed add flips to the linked InLibraryBadge instead. */}
          {showRelatedEditionBadge && (
            <div className="mt-1.5">
              <Badge variant="muted">Edition in library</Badge>
            </div>
          )}

          {book.narrators && book.narrators.length > 0 && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <HeadphonesIcon className="w-3.5 h-3.5" />
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

        {/* Add Button */}
        {/* Ownership read-out (#1907): an exact-ASIN match (or a completed
            add/409) links to the owned book with no Add control; otherwise Add
            stays available. The related-edition (title-identity) case keeps Add
            here AND surfaces the "Edition in library" badge in the content column
            above — the server's recording-verdict decides create-vs-409. */}
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
