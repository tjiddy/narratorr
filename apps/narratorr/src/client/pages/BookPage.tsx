import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useBook } from '@/hooks/useMetadata';
import { useLibrary } from '@/hooks/useLibrary';
import { api, type BookMetadata, type CreateBookPayload, type BookWithAuthor } from '@/lib/api';

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(minutes?: number): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function mapBookMetadataToPayload(book: BookMetadata): CreateBookPayload {
  const author = book.authors[0];
  return {
    title: book.title,
    authorName: author?.name,
    authorAsin: author?.asin,
    narrator: book.narrators?.join(', '),
    description: book.description,
    coverUrl: book.coverUrl,
    asin: book.asin,
    seriesName: book.series?.[0]?.name,
    seriesPosition: book.series?.[0]?.position,
    duration: book.duration,
    genres: book.genres,
  };
}

function isBookInLibrary(book: BookMetadata, libraryBooks?: BookWithAuthor[]): boolean {
  if (!libraryBooks?.length) return false;
  return libraryBooks.some((lb) => {
    if (book.asin && lb.asin && book.asin === lb.asin) return true;
    const titleMatch = lb.title.toLowerCase() === book.title.toLowerCase();
    const authorMatch = book.authors[0]?.name
      && lb.author?.name?.toLowerCase() === book.authors[0].name.toLowerCase();
    return titleMatch && authorMatch;
  });
}

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

function PlusIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M20 6 9 17l-5-5" />
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

function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
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
  const { asin } = useParams<{ asin: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: book, isLoading, isError } = useBook(asin);
  const { data: libraryBooks } = useLibrary();

  const [justAdded, setJustAdded] = useState(false);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  const inLibrary = justAdded || (book ? isBookInLibrary(book, libraryBooks) : false);

  const addMutation = useMutation({
    mutationFn: () => api.addBook(mapBookMetadataToPayload(book!)),
    onSuccess: () => {
      setJustAdded(true);
      toast.success(`Added '${book!.title}' to library`);
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
    onError: (error: Error) => {
      toast.error(`Failed to add book: ${error.message}`);
    },
  });

  if (isLoading) return <BookPageSkeleton />;
  if (isError || !book) return <BookNotFound />;

  const authorNames = book.authors.map((a) => a.name).join(', ');
  const narratorNames = book.narrators?.join(', ');
  const seriesInfo = book.series?.[0];
  const duration = formatDuration(book.duration);
  const descriptionLong = (book.description?.length ?? 0) > DESCRIPTION_COLLAPSE_LENGTH;
  const metaDots: string[] = [];
  if (seriesInfo) {
    metaDots.push(`${seriesInfo.name}${seriesInfo.position != null ? ` #${seriesInfo.position}` : ''}`);
  }
  if (duration) metaDots.push(duration);

  return (
    <div className="space-y-8">
      {/* Hero section with blurred backdrop */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-8 overflow-hidden">
        {/* Blurred backdrop */}
        {book.coverUrl && (
          <div className="absolute inset-0 -z-10">
            <img
              src={book.coverUrl}
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
              {book.coverUrl ? (
                <img
                  src={book.coverUrl}
                  alt={`Cover of ${book.title}`}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
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
              {book.title}
            </h1>

            {book.subtitle && (
              <p className="text-muted-foreground italic mt-1 text-lg animate-fade-in-up stagger-2">
                {book.subtitle}
              </p>
            )}

            {/* Authors */}
            <div className="mt-3 animate-fade-in-up stagger-3">
              <span className="text-muted-foreground text-sm">by </span>
              {book.authors.map((author, i) => (
                <span key={author.asin ?? author.name}>
                  {i > 0 && <span className="text-muted-foreground"> &middot; </span>}
                  {author.asin ? (
                    <Link
                      to={`/authors/${author.asin}`}
                      className="text-primary hover:underline font-medium"
                    >
                      {author.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{author.name}</span>
                  )}
                </span>
              ))}
            </div>

            {/* Narrators */}
            {narratorNames && (
              <p className="text-muted-foreground text-sm mt-1 animate-fade-in-up stagger-3">
                Narrated by {narratorNames}
              </p>
            )}

            {/* Meta dots: series · duration */}
            {metaDots.length > 0 && (
              <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">
                {metaDots.join(' \u00B7 ')}
              </p>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-3 mt-6 justify-center sm:justify-start animate-fade-in-up stagger-4">
              {inLibrary ? (
                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-success/10 text-success border border-success/20">
                  <CheckIcon className="w-4 h-4" />
                  In Library
                </span>
              ) : (
                <button
                  onClick={() => addMutation.mutate()}
                  disabled={addMutation.isPending}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 hover:shadow-glow transition-all duration-200 focus-ring disabled:opacity-50"
                >
                  {addMutation.isPending ? (
                    <LoadingSpinner className="w-4 h-4" />
                  ) : (
                    <PlusIcon className="w-4 h-4" />
                  )}
                  Add to Library
                </button>
              )}
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
      {book.description && (
        <div className="animate-fade-in-up stagger-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            About This Book
          </h2>
          <div className="glass-card rounded-2xl p-6">
            <div
              className={`prose prose-sm dark:prose-invert max-w-none ${!descriptionExpanded && descriptionLong ? 'line-clamp-4' : ''}`}
              dangerouslySetInnerHTML={{ __html: book.description }}
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
      {book.genres && book.genres.length > 0 && (
        <div className="animate-fade-in-up stagger-6">
          <div className="flex flex-wrap gap-2">
            {book.genres.map((genre) => (
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
