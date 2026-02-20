import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { useAuthor, useAuthorBooks } from '@/hooks/useMetadata';
import { useLibrary } from '@/hooks/useLibrary';
import { useAddBooksToLibrary } from '@/hooks/useAddBooksToLibrary';
import { BookOpenIcon, ArrowLeftIcon } from '@/components/icons';
import { AuthorPageSkeleton } from './AuthorPageSkeleton.js';
import { AuthorNotFound } from './AuthorNotFound.js';
import { SeriesSection } from './SeriesSection.js';
import { getInitials, groupBooksBySeries, BIO_COLLAPSE_LENGTH } from './helpers.js';

// eslint-disable-next-line complexity -- 3 data fetches with loading/error early returns + 4 conditional sections
export function AuthorPage() {
  const { asin } = useParams<{ asin: string }>();
  const navigate = useNavigate();

  const { data: author, isLoading: authorLoading, isError: authorError } = useAuthor(asin);
  const { data: books, isLoading: booksLoading } = useAuthorBooks(asin);
  const { data: libraryBooks } = useLibrary();
  const { addingAsins, addBook, addAllInSeries } = useAddBooksToLibrary(libraryBooks);

  const [bioExpanded, setBioExpanded] = useState(false);

  const isLoading = authorLoading || booksLoading;
  if (isLoading) return <AuthorPageSkeleton />;
  if (authorError || !author) return <AuthorNotFound />;

  const totalBooks = books?.length ?? 0;
  const { series, standalone } = groupBooksBySeries(books ?? []);
  const bioLong = (author.description?.length ?? 0) > BIO_COLLAPSE_LENGTH;

  return (
    <div className="space-y-8">
      {/* Hero section with blurred backdrop */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-8 overflow-hidden">
        {/* Blurred backdrop */}
        {author.imageUrl && (
          <div className="absolute inset-0 -z-10">
            <img src={author.imageUrl} alt="" aria-hidden="true" className="w-full h-full object-cover blur-3xl opacity-20 scale-110" />
            <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
          </div>
        )}

        {/* Back link */}
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 focus-ring rounded-lg px-1 -ml-1 animate-fade-in-up"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Back
        </button>

        {/* Author profile */}
        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8 items-center sm:items-start">
          {/* Avatar */}
          <div className="shrink-0 animate-fade-in-up stagger-1">
            <div className="relative w-32 h-32 sm:w-40 sm:h-40 rounded-full overflow-hidden shadow-card-hover ring-2 ring-primary/20 group">
              {author.imageUrl ? (
                <img src={author.imageUrl} alt={author.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-amber-500/20">
                  <span className="font-display text-4xl sm:text-5xl font-bold text-primary/70">{getInitials(author.name)}</span>
                </div>
              )}
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-full" />
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0 text-center sm:text-left">
            <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight animate-fade-in-up stagger-2">
              {author.name}
            </h1>
            <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">
              {totalBooks} {totalBooks === 1 ? 'audiobook' : 'audiobooks'}
              {series.length > 0 && (
                <> &middot; {series.length} {series.length === 1 ? 'series' : 'series'}</>
              )}
            </p>
            {author.genres && author.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 justify-center sm:justify-start animate-fade-in-up stagger-3">
                {author.genres.map((genre) => (
                  <span key={genre} className="glass-card rounded-xl px-2.5 py-1 text-xs font-medium">{genre}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bio */}
      {author.description && (
        <div className="animate-fade-in-up stagger-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">About</h2>
          <div className="glass-card rounded-2xl p-6">
            <div
              className={`prose prose-sm dark:prose-invert max-w-none ${!bioExpanded && bioLong ? 'line-clamp-4' : ''}`}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(author.description) }}
            />
            {bioLong && (
              <button onClick={() => setBioExpanded(!bioExpanded)} className="text-primary text-sm font-medium hover:underline mt-2 focus-ring rounded">
                {bioExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Catalog */}
      {totalBooks > 0 && (
        <div className="space-y-6 animate-fade-in-up stagger-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Catalog</h2>
          {series.map((s) => (
            <SeriesSection
              key={s.name}
              name={s.name}
              books={s.books}
              libraryBooks={libraryBooks}
              onAddBook={addBook}
              onAddAll={() => addAllInSeries(s.books)}
              addingAsins={addingAsins}
              isAddingAll={s.books.some((b) => addingAsins.has(b.asin ?? b.title))}
            />
          ))}
          {standalone.length > 0 && (
            <SeriesSection
              name="Standalone"
              books={standalone}
              libraryBooks={libraryBooks}
              onAddBook={addBook}
              onAddAll={() => addAllInSeries(standalone)}
              addingAsins={addingAsins}
              isAddingAll={standalone.some((b) => addingAsins.has(b.asin ?? b.title))}
            />
          )}
        </div>
      )}

      {/* Empty catalog */}
      {totalBooks === 0 && !booksLoading && (
        <div className="text-center py-12 animate-fade-in-up stagger-5">
          <BookOpenIcon className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground">No audiobooks found for this author.</p>
        </div>
      )}
    </div>
  );
}
