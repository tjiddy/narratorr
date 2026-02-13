import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useBook } from '@/hooks/useMetadata';
import { useLibraryBook } from '@/hooks/useLibrary';
import { formatDuration } from '@/lib/helpers';
import { bookStatusConfig } from '@/lib/status';

const DESCRIPTION_COLLAPSE_LENGTH = 300;

// ============================================================================
// Icons
// ============================================================================

function ArrowLeftIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function BookOpenIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function BookPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-5 w-24 skeleton rounded" />
      <div className="flex flex-col sm:flex-row gap-8">
        <div className="w-48 sm:w-56 lg:w-72 aspect-[2/3] skeleton rounded-2xl shrink-0 mx-auto sm:mx-0" />
        <div className="flex-1 space-y-4">
          <div className="h-10 w-3/4 skeleton rounded" />
          <div className="h-5 w-1/2 skeleton rounded" />
          <div className="h-4 w-1/3 skeleton rounded" />
          <div className="h-4 w-1/4 skeleton rounded" />
          <div className="h-4 w-2/5 skeleton rounded" />
          <div className="flex gap-3 mt-6">
            <div className="h-11 w-40 skeleton rounded-xl" />
            <div className="h-11 w-40 skeleton rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Not Found
// ============================================================================

function BookNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 animate-fade-in-up">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <BookOpenIcon className="w-16 h-16 text-muted-foreground/50" />
        </div>
      </div>
      <h2 className="font-display text-2xl font-semibold mb-2">Book not found</h2>
      <p className="text-muted-foreground mb-6">The book you're looking for doesn't exist or couldn't be loaded.</p>
      <Link
        to="/library"
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
      >
        <ArrowLeftIcon className="w-4 h-4" />
        Back to Library
      </Link>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function BookPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const numericId = id ? parseInt(id, 10) : undefined;
  const { data: libraryBook, isLoading: libraryLoading, isError: libraryError } = useLibraryBook(numericId);

  // Optionally enrich with metadata if the library book has an ASIN
  const { data: metadataBook } = useBook(libraryBook?.asin ?? undefined);

  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  if (libraryLoading) return <BookPageSkeleton />;
  if (libraryError || !libraryBook) return <BookNotFound />;

  // Merge: library data is primary, metadata supplements
  const title = libraryBook.title;
  const authorName = libraryBook.author?.name;
  const subtitle = metadataBook?.subtitle;
  const narratorNames = libraryBook.narrator || metadataBook?.narrators?.join(', ');
  const description = libraryBook.description || metadataBook?.description;
  const coverUrl = libraryBook.coverUrl || metadataBook?.coverUrl;
  const duration = formatDuration(libraryBook.duration ?? metadataBook?.duration);
  const genres = libraryBook.genres ?? metadataBook?.genres;
  const seriesName = libraryBook.seriesName || metadataBook?.series?.[0]?.name;
  const seriesPosition = libraryBook.seriesPosition ?? metadataBook?.series?.[0]?.position;
  const publisher = metadataBook?.publisher;
  const status = bookStatusConfig[libraryBook.status] ?? bookStatusConfig.wanted;

  const descriptionLong = (description?.length ?? 0) > DESCRIPTION_COLLAPSE_LENGTH;
  const metaDots: string[] = [];
  if (seriesName) {
    metaDots.push(`${seriesName}${seriesPosition != null ? ` #${seriesPosition}` : ''}`);
  }
  if (duration) metaDots.push(duration);
  if (publisher) metaDots.push(publisher);

  return (
    <div className="space-y-8">
      {/* Hero section with blurred backdrop */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-8 overflow-hidden">
        {/* Blurred backdrop */}
        {coverUrl && (
          <div className="absolute inset-0 -z-10">
            <img
              src={coverUrl}
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover blur-3xl opacity-20 scale-110"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/80 to-background" />
          </div>
        )}

        {/* Back link */}
        <button
          onClick={() => navigate('/library')}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6 focus-ring rounded-lg px-1 -ml-1 animate-fade-in-up"
        >
          <ArrowLeftIcon className="w-4 h-4" />
          Library
        </button>

        {/* Content */}
        <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
          {/* Cover */}
          <div className="shrink-0 mx-auto sm:mx-0 animate-fade-in-up stagger-1">
            <div className="relative w-48 sm:w-56 lg:w-72 aspect-[2/3] rounded-2xl overflow-hidden shadow-card-hover ring-1 ring-black/10 group">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={`Cover of ${title}`}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-muted">
                  <BookOpenIcon className="w-16 h-16 text-muted-foreground/30" />
                </div>
              )}
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-2xl" />
            </div>
          </div>

          {/* Metadata */}
          <div className="flex-1 min-w-0 text-center sm:text-left">
            <h1 className="font-display text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight animate-fade-in-up stagger-2">
              {title}
            </h1>

            {subtitle && (
              <p className="text-muted-foreground italic mt-1 text-lg animate-fade-in-up stagger-2">
                {subtitle}
              </p>
            )}

            {/* Author */}
            {authorName && (
              <div className="mt-3 animate-fade-in-up stagger-3">
                <span className="text-muted-foreground text-sm">by </span>
                {libraryBook.author?.asin ? (
                  <Link
                    to={`/authors/${libraryBook.author.asin}`}
                    className="text-primary hover:underline font-medium"
                  >
                    {authorName}
                  </Link>
                ) : (
                  <span className="font-medium">{authorName}</span>
                )}
              </div>
            )}

            {/* Narrators */}
            {narratorNames && (
              <p className="text-muted-foreground text-sm mt-1 animate-fade-in-up stagger-3">
                Narrated by {narratorNames}
              </p>
            )}

            {/* Meta dots: series · duration · publisher */}
            {metaDots.length > 0 && (
              <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">
                {metaDots.join(' \u00B7 ')}
              </p>
            )}

            {/* Status + Actions */}
            <div className="flex flex-wrap items-center gap-3 mt-6 justify-center sm:justify-start animate-fade-in-up stagger-4">
              <span className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium glass-card`}>
                <span className={`w-2 h-2 rounded-full ${status.dotClass}`} />
                {status.label}
              </span>
              <button
                onClick={() => navigate('/search')}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium glass-card hover:border-primary/30 hover:text-primary transition-all duration-200 focus-ring"
              >
                <SearchIcon className="w-4 h-4" />
                Search Releases
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      {description && (
        <div className="animate-fade-in-up stagger-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            About This Book
          </h2>
          <div className="glass-card rounded-2xl p-6">
            <div
              className={`prose prose-sm dark:prose-invert max-w-none ${!descriptionExpanded && descriptionLong ? 'line-clamp-4' : ''}`}
              dangerouslySetInnerHTML={{ __html: description }}
            />
            {descriptionLong && (
              <button
                onClick={() => setDescriptionExpanded(!descriptionExpanded)}
                className="text-primary text-sm font-medium hover:underline mt-2 focus-ring rounded"
              >
                {descriptionExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Genre chips */}
      {genres && genres.length > 0 && (
        <div className="animate-fade-in-up stagger-6">
          <div className="flex flex-wrap gap-2">
            {genres.map((genre) => (
              <span
                key={genre}
                className="glass-card rounded-xl px-3 py-1.5 text-xs font-medium"
              >
                {genre}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
