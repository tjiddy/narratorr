import { useQuery } from '@tanstack/react-query';
import { AudioInfo } from '@/components/AudioInfo';
import { SeriesCard } from '@/components/SeriesCard';
import { api, type BookWithAuthor } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { BookDescription } from './BookDescription.js';
import { CompanionEbookSection } from './CompanionEbookSection.js';
import { BookLocationSection } from './BookLocationSection.js';
import { FileList } from './FileList.js';

interface MergedData {
  description?: string | undefined;
  genres?: string[] | undefined;
}

function useSidebarSignals(libraryBook: BookWithAuthor, merged: MergedData) {
  // Query here and in SeriesCard so cache-only links open the sidebar; TanStack dedupes the shared key.
  const seriesQuery = useQuery({
    queryKey: queryKeys.bookSeries(libraryBook.id),
    queryFn: () => api.getBookSeries(libraryBook.id),
  });
  const hasGenres = !!merged.genres && merged.genres.length > 0;
  const hasPath = !!libraryBook.path;
  const hasSeries = !!libraryBook.seriesName || seriesQuery.data?.series != null;
  const hasAudio = !!libraryBook.audioCodec;
  return { hasGenres, hasPath, hasSeries, hasAudio, hasSidebar: hasAudio || hasGenres || hasPath || hasSeries };
}

export function BookDetailsContent({ libraryBook, merged }: {
  libraryBook: BookWithAuthor;
  merged: MergedData;
}) {
  const hasDescription = !!merged.description;
  const { hasGenres, hasPath, hasSeries, hasSidebar } = useSidebarSignals(libraryBook, merged);

  if (!hasDescription && !hasSidebar) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in-up stagger-5">
      {hasDescription && (
        <div className={hasSidebar ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <BookDescription description={merged.description!} />
        </div>
      )}

      {hasSidebar && (
        <div className={`space-y-6 ${hasDescription ? '' : 'lg:col-span-3 lg:max-w-sm'}`}>
          {hasSeries && (
            <SeriesCard bookId={libraryBook.id} />
          )}

          <AudioInfo book={libraryBook} compact />

          {hasGenres && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Genres
              </h2>
              <div className="glass-card rounded-2xl p-4">
                <div className="flex flex-wrap gap-2">
                  {merged.genres!.map((genre) => (
                    <span
                      key={genre}
                      className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Keep immediately before Location: the empty-state copy says “Location below.” */}
          {hasPath && <CompanionEbookSection bookId={libraryBook.id} />}

          {hasPath && <BookLocationSection path={libraryBook.path!} />}

          {hasPath && <FileList bookId={libraryBook.id} />}
        </div>
      )}
    </div>
  );
}
