import { useQuery } from '@tanstack/react-query';
import { AudioInfo } from '@/components/AudioInfo';
import { SeriesCard } from '@/components/SeriesCard';
import { api, type BookWithAuthor } from '@/lib/api';
import { BookDescription } from './BookDescription.js';
import { BookLocationSection } from './BookLocationSection.js';
import { FileList } from './FileList.js';

interface MergedData {
  description?: string | undefined;
  genres?: string[] | undefined;
}

function useSidebarSignals(libraryBook: BookWithAuthor, merged: MergedData) {
  // Fire the series query at the page level so a book with no scalar
  // seriesName but a DB-cache link (via member ASIN) still surfaces the
  // Series card. (F9) The query is also issued inside SeriesCard, but
  // TanStack Query dedupes on the same key.
  const seriesQuery = useQuery({
    queryKey: ['book', libraryBook.id, 'series'] as const,
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
            <SeriesCard
              bookId={libraryBook.id}
              fallbackSeriesName={libraryBook.seriesName}
              fallbackSeriesPosition={libraryBook.seriesPosition}
            />
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

          {hasPath && <BookLocationSection path={libraryBook.path!} />}

          {hasPath && <FileList bookId={libraryBook.id} />}
        </div>
      )}
    </div>
  );
}
