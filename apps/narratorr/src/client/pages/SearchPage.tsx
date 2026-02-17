import { useState } from 'react';
import { CoverImage } from '@/components/CoverImage';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type BookMetadata, type AuthorMetadata, type BookWithAuthor } from '@/lib/api';
import { useMetadataSearch } from '@/hooks/useMetadata';
import { toast } from 'sonner';
import { formatDuration, mapBookMetadataToPayload, isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';
import {
  SearchIcon,
  LoadingSpinner,
  BookOpenIcon,
  UsersIcon,
  CheckCircleIcon,
  PlusIcon,
  ArrowRightIcon,
  ClockIcon,
} from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';

// ============================================================================
// Main Component
// ============================================================================

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const queryClient = useQueryClient();

  // Metadata search
  const {
    data: metadataResults,
    isLoading,
    error,
  } = useMetadataSearch(searchTerm);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchTerm(query);
  };

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4 animate-fade-in-up">
        <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
          Discover <span className="text-gradient">Audiobooks</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Search metadata providers to find books and authors
        </p>
      </div>

      {/* Search Form */}
      <form
        onSubmit={handleSearch}
        className="max-w-3xl mx-auto animate-fade-in-up stagger-1"
      >
        <div className="relative group">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-primary to-amber-500 rounded-2xl opacity-20 blur-lg group-hover:opacity-30 transition-opacity" />
          <div className="relative flex items-center glass-card rounded-2xl overflow-hidden">
            <div className="flex items-center justify-center pl-3 sm:pl-5 pr-1 sm:pr-2 text-muted-foreground">
              {isLoading ? (
                <LoadingSpinner className="w-5 h-5" />
              ) : (
                <SearchIcon className="w-5 h-5" />
              )}
            </div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, author, or series..."
              className="flex-1 bg-transparent px-2 sm:px-4 py-4 text-base sm:text-lg placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
            />
            <button
              type="submit"
              disabled={isLoading || query.length < 2}
              className="shrink-0 m-1.5 sm:m-2 px-3 sm:px-6 py-2 sm:py-2.5 bg-primary text-primary-foreground text-sm sm:text-base font-medium rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 focus-ring"
            >
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>
      </form>

      {/* Error */}
      {error && (
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl animate-fade-in">
            <p>{error.message}</p>
          </div>
        </div>
      )}

      {/* Results */}
      <DiscoverResults
        results={metadataResults}
        searchTerm={searchTerm}
        isLoading={isLoading}
        queryClient={queryClient}
      />
    </div>
  );
}

// ============================================================================
// Discover Results
// ============================================================================

type DiscoverTab = 'books' | 'authors';

function DiscoverResults({
  results,
  searchTerm,
  isLoading,
  queryClient,
}: {
  results: { books: BookMetadata[]; authors: AuthorMetadata[] } | undefined;
  searchTerm: string;
  isLoading: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [tab, setTab] = useState<DiscoverTab>('books');
  const hasResults = results && (results.authors.length > 0 || results.books.length > 0);

  // Fetch library books to check "already in library"
  const { data: libraryBooks } = useQuery({
    queryKey: queryKeys.books(),
    queryFn: () => api.getBooks(),
  });

  if (searchTerm && !isLoading && !hasResults) {
    return (
      <EmptyState
        icon={<SearchIcon className="w-12 h-12" />}
        title={`No results for "${searchTerm}"`}
        description="Try different keywords or check the spelling"
      />
    );
  }

  if (!searchTerm) {
    return (
      <EmptyState
        icon={<BookOpenIcon className="w-16 h-16" />}
        title="Start your search"
        description="Enter a title, author, or series to discover audiobooks"
      />
    );
  }

  if (!results) return null;

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex justify-center animate-fade-in">
        <div className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            onClick={() => setTab('books')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${tab === 'books'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <BookOpenIcon className="w-4 h-4" />
            Books
            {results.books.length > 0 && (
              <span className="text-xs opacity-75">({results.books.length})</span>
            )}
          </button>
          <button
            onClick={() => setTab('authors')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${tab === 'authors'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <UsersIcon className="w-4 h-4" />
            Authors
            {results.authors.length > 0 && (
              <span className="text-xs opacity-75">({results.authors.length})</span>
            )}
          </button>
        </div>
      </div>

      {/* Tab Content */}
      {tab === 'books' && results.books.length > 0 && (
        <div className="grid gap-4">
          {results.books.map((book, index) => (
            <DiscoverBookCard
              key={book.asin || index}
              book={book}
              index={index}
              libraryBooks={libraryBooks}
              queryClient={queryClient}
            />
          ))}
        </div>
      )}

      {tab === 'books' && results.books.length === 0 && (
        <p className="text-center text-muted-foreground py-8">No books found</p>
      )}

      {tab === 'authors' && results.authors.length > 0 && (
        <div className="grid gap-3">
          {results.authors.map((author, index) => (
            <AuthorCard key={author.asin || index} author={author} index={index} />
          ))}
        </div>
      )}

      {tab === 'authors' && results.authors.length === 0 && (
        <p className="text-center text-muted-foreground py-8">No authors found</p>
      )}
    </div>
  );
}

// ============================================================================
// Author Card
// ============================================================================

function AuthorCard({ author, index }: { author: AuthorMetadata; index: number }) {
  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-center gap-4">
        {/* Author Image */}
        <div className="shrink-0">
          <CoverImage
            src={author.imageUrl}
            alt={author.name}
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-full"
            fallback={<UsersIcon className="w-6 h-6 text-muted-foreground" />}
          />
        </div>

        {/* Author Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-lg font-semibold group-hover:text-primary transition-colors truncate">
            {author.name}
          </h3>
          {author.genres && author.genres.length > 0 && (
            <p className="text-sm text-muted-foreground truncate">
              {author.genres.join(', ')}
            </p>
          )}
        </div>

        {/* View Button */}
        {author.asin && (
          <button
            onClick={() => toast.info('Author pages coming soon!')}
            className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10 rounded-lg transition-colors focus-ring"
          >
            View
            <ArrowRightIcon className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Discover Book Card
// ============================================================================

function DiscoverBookCard({
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
