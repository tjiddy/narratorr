import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuthor, useAuthorBooks } from '@/hooks/useMetadata';
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
    providerId: book.providerId,
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

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

interface SeriesGroup {
  name: string;
  books: BookMetadata[];
}

function groupBooksBySeries(books: BookMetadata[]): { series: SeriesGroup[]; standalone: BookMetadata[] } {
  const seriesMap = new Map<string, BookMetadata[]>();
  const standalone: BookMetadata[] = [];

  for (const book of books) {
    const s = book.series?.[0];
    if (s?.name) {
      const existing = seriesMap.get(s.name) ?? [];
      existing.push(book);
      seriesMap.set(s.name, existing);
    } else {
      standalone.push(book);
    }
  }

  const series = Array.from(seriesMap.entries())
    .map(([name, seriesBooks]) => ({
      name,
      books: seriesBooks.sort((a, b) => {
        const posA = a.series?.[0]?.position ?? Infinity;
        const posB = b.series?.[0]?.position ?? Infinity;
        return posA - posB;
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { series, standalone };
}

const BIO_COLLAPSE_LENGTH = 300;

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

function LibraryIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
    </svg>
  );
}

// ============================================================================
// Loading Skeleton
// ============================================================================

function AuthorPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-5 w-24 skeleton rounded" />
      <div className="flex flex-col sm:flex-row gap-8 items-center sm:items-start">
        <div className="w-32 h-32 sm:w-40 sm:h-40 skeleton rounded-full shrink-0" />
        <div className="flex-1 space-y-4 text-center sm:text-left w-full">
          <div className="h-10 w-3/4 skeleton rounded mx-auto sm:mx-0" />
          <div className="h-5 w-1/3 skeleton rounded mx-auto sm:mx-0" />
          <div className="flex gap-2 justify-center sm:justify-start">
            <div className="h-7 w-20 skeleton rounded-xl" />
            <div className="h-7 w-24 skeleton rounded-xl" />
          </div>
          <div className="h-20 w-full skeleton rounded-2xl" />
        </div>
      </div>
      {/* Series skeleton */}
      <div className="space-y-4">
        <div className="h-6 w-48 skeleton rounded" />
        <div className="glass-card rounded-2xl p-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex gap-4 items-center">
              <div className="w-12 aspect-[2/3] skeleton rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-3/4 skeleton rounded" />
                <div className="h-3 w-1/2 skeleton rounded" />
              </div>
              <div className="w-9 h-9 skeleton rounded-xl shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Not Found
// ============================================================================

function AuthorNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 animate-fade-in-up">
      <div className="relative mb-8">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-2xl" />
        <div className="relative p-6 bg-gradient-to-br from-primary/10 to-amber-500/10 rounded-full">
          <BookOpenIcon className="w-16 h-16 text-muted-foreground/50" />
        </div>
      </div>
      <h2 className="font-display text-2xl font-semibold mb-2">Author not found</h2>
      <p className="text-muted-foreground mb-6">The author you&apos;re looking for doesn&apos;t exist or couldn&apos;t be loaded.</p>
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
// Book Row
// ============================================================================

function BookRow({
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
      <Link
        to="#"
        className="shrink-0 focus-ring rounded-lg"
      >
        <div className="relative w-10 sm:w-12 aspect-[2/3] rounded-lg overflow-hidden ring-1 ring-black/10 transition-transform duration-200 group-hover:scale-105">
          {book.coverUrl ? (
            <img
              src={book.coverUrl}
              alt={`Cover of ${book.title}`}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-muted">
              <BookOpenIcon className="w-4 h-4 text-muted-foreground/30" />
            </div>
          )}
        </div>
      </Link>

      {/* Book info */}
      <div className="flex-1 min-w-0">
        <Link
          to="#"
          className="text-sm font-medium hover:text-primary transition-colors line-clamp-1 focus-ring rounded"
        >
          {seriesPos != null && (
            <span className="text-muted-foreground font-normal">#{seriesPos} </span>
          )}
          {book.title}
        </Link>
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

// ============================================================================
// Series Section
// ============================================================================

function SeriesSection({
  name,
  books,
  libraryBooks,
  onAddBook,
  onAddAll,
  addingAsins,
  isAddingAll,
}: {
  name: string;
  books: BookMetadata[];
  libraryBooks?: BookWithAuthor[];
  onAddBook: (book: BookMetadata) => void;
  onAddAll: () => void;
  addingAsins: Set<string>;
  isAddingAll: boolean;
}) {
  const allInLibrary = books.every((b) => isBookInLibrary(b, libraryBooks));
  const booksNotInLibrary = books.filter((b) => !isBookInLibrary(b, libraryBooks));

  return (
    <div>
      {/* Series header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <LibraryIcon className="w-4 h-4 text-primary/70" />
          <h3 className="font-display text-lg font-semibold">{name}</h3>
          <span className="text-xs text-muted-foreground">
            {books.length} {books.length === 1 ? 'book' : 'books'}
          </span>
        </div>
        {!allInLibrary && (
          <button
            onClick={onAddAll}
            disabled={isAddingAll}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring disabled:opacity-50"
          >
            {isAddingAll ? (
              <LoadingSpinner className="w-3 h-3" />
            ) : (
              <PlusIcon className="w-3 h-3" />
            )}
            Add All ({booksNotInLibrary.length})
          </button>
        )}
      </div>

      {/* Book list */}
      <div className="glass-card rounded-2xl px-4 sm:px-5 divide-y divide-border/50">
        {books.map((book) => (
          <BookRow
            key={book.asin ?? book.title}
            book={book}
            inLibrary={isBookInLibrary(book, libraryBooks)}
            onAdd={() => onAddBook(book)}
            isAdding={addingAsins.has(book.asin ?? book.title)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function AuthorPage() {
  const { asin } = useParams<{ asin: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: author, isLoading: authorLoading, isError: authorError } = useAuthor(asin);
  const { data: books, isLoading: booksLoading } = useAuthorBooks(asin);
  const { data: libraryBooks } = useLibrary();

  const [bioExpanded, setBioExpanded] = useState(false);
  const [addingAsins, setAddingAsins] = useState<Set<string>>(new Set());
  const [addedAsins, setAddedAsins] = useState<Set<string>>(new Set());

  const addBookMutation = useMutation({
    mutationFn: (book: BookMetadata) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => new Set(prev).add(key));
      return api.addBook(mapBookMetadataToPayload(book));
    },
    onSuccess: (_data, book) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setAddedAsins((prev) => new Set(prev).add(key));
      toast.success(`Added '${book.title}' to library`);
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
    onError: (error: Error, book) => {
      const key = book.asin ?? book.title;
      setAddingAsins((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      toast.error(`Failed to add '${book.title}': ${error.message}`);
    },
  });

  const isLoading = authorLoading || booksLoading;
  if (isLoading) return <AuthorPageSkeleton />;
  if (authorError || !author) return <AuthorNotFound />;

  const totalBooks = books?.length ?? 0;
  const { series, standalone } = groupBooksBySeries(books ?? []);
  const bioLong = (author.description?.length ?? 0) > BIO_COLLAPSE_LENGTH;

  function isBookAdded(book: BookMetadata): boolean {
    const key = book.asin ?? book.title;
    return addedAsins.has(key) || isBookInLibrary(book, libraryBooks);
  }

  function handleAddBook(book: BookMetadata) {
    if (!isBookAdded(book)) {
      addBookMutation.mutate(book);
    }
  }

  function handleAddAllInSeries(seriesBooks: BookMetadata[]) {
    const toAdd = seriesBooks.filter((b) => !isBookAdded(b));
    for (const book of toAdd) {
      addBookMutation.mutate(book);
    }
  }

  return (
    <div className="space-y-8">
      {/* Hero section with blurred backdrop */}
      <div className="relative -mx-4 sm:-mx-6 lg:-mx-8 -mt-4 sm:-mt-6 px-4 sm:px-6 lg:px-8 pt-6 pb-8 overflow-hidden">
        {/* Blurred backdrop */}
        {author.imageUrl && (
          <div className="absolute inset-0 -z-10">
            <img
              src={author.imageUrl}
              alt=""
              aria-hidden="true"
              className="w-full h-full object-cover blur-3xl opacity-20 scale-110"
            />
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
                <img
                  src={author.imageUrl}
                  alt={author.name}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-primary/20 to-amber-500/20">
                  <span className="font-display text-4xl sm:text-5xl font-bold text-primary/70">
                    {getInitials(author.name)}
                  </span>
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

            {/* Stats line */}
            <p className="text-muted-foreground text-sm mt-2 animate-fade-in-up stagger-3">
              {totalBooks} {totalBooks === 1 ? 'audiobook' : 'audiobooks'}
              {series.length > 0 && (
                <> &middot; {series.length} {series.length === 1 ? 'series' : 'series'}</>
              )}
            </p>

            {/* Genre chips */}
            {author.genres && author.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 justify-center sm:justify-start animate-fade-in-up stagger-3">
                {author.genres.map((genre) => (
                  <span
                    key={genre}
                    className="glass-card rounded-xl px-2.5 py-1 text-xs font-medium"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bio */}
      {author.description && (
        <div className="animate-fade-in-up stagger-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            About
          </h2>
          <div className="glass-card rounded-2xl p-6">
            <div
              className={`prose prose-sm dark:prose-invert max-w-none ${!bioExpanded && bioLong ? 'line-clamp-4' : ''}`}
              dangerouslySetInnerHTML={{ __html: author.description }}
            />
            {bioLong && (
              <button
                onClick={() => setBioExpanded(!bioExpanded)}
                className="text-primary text-sm font-medium hover:underline mt-2 focus-ring rounded"
              >
                {bioExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Catalog */}
      {totalBooks > 0 && (
        <div className="space-y-6 animate-fade-in-up stagger-5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Catalog
          </h2>

          {/* Series sections */}
          {series.map((s) => (
            <SeriesSection
              key={s.name}
              name={s.name}
              books={s.books}
              libraryBooks={libraryBooks}
              onAddBook={handleAddBook}
              onAddAll={() => handleAddAllInSeries(s.books)}
              addingAsins={addingAsins}
              isAddingAll={s.books.some((b) => addingAsins.has(b.asin ?? b.title))}
            />
          ))}

          {/* Standalone books */}
          {standalone.length > 0 && (
            <SeriesSection
              name="Standalone"
              books={standalone}
              libraryBooks={libraryBooks}
              onAddBook={handleAddBook}
              onAddAll={() => handleAddAllInSeries(standalone)}
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
