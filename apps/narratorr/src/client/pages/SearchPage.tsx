import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, formatBytes, type SearchResult, type BookMetadata, type AuthorMetadata, type BookWithAuthor } from '@/lib/api';
import { useMetadataSearch } from '@/hooks/useMetadata';
import { toast } from 'sonner';
import { formatDuration, mapBookMetadataToPayload, isBookInLibrary } from '@/lib/helpers';
import { queryKeys } from '@/lib/queryKeys';
import {
  SearchIcon,
  LoadingSpinner,
  DownloadIcon,
  BookOpenIcon,
  UsersIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  PlusIcon,
  ArrowRightIcon,
  ClockIcon,
} from '@/components/icons';
import { EmptyState } from '@/components/EmptyState';

type SearchMode = 'discover' | 'indexer';

// ============================================================================
// Main Component
// ============================================================================

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [mode, setMode] = useState<SearchMode>('discover');
  const queryClient = useQueryClient();

  // Indexer search
  const {
    data: indexerResults,
    isLoading: indexerLoading,
    error: indexerError,
  } = useQuery({
    queryKey: queryKeys.search(searchTerm),
    queryFn: () => api.search(searchTerm),
    enabled: mode === 'indexer' && searchTerm.length >= 2,
  });

  // Metadata search
  const {
    data: metadataResults,
    isLoading: metadataLoading,
    error: metadataError,
  } = useMetadataSearch(mode === 'discover' ? searchTerm : '');

  const isLoading = mode === 'discover' ? metadataLoading : indexerLoading;
  const error = mode === 'discover' ? metadataError : indexerError;

  const grabMutation = useMutation({
    mutationFn: api.grab,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchTerm(query);
  };

  const handleGrab = (result: SearchResult) => {
    if (!result.downloadUrl) {
      toast.error('No download link available for this result');
      return;
    }
    grabMutation.mutate({
      downloadUrl: result.downloadUrl,
      title: result.title,
      protocol: result.protocol,
      size: result.size,
      seeders: result.seeders,
    });
  };

  const handleModeChange = (newMode: SearchMode) => {
    setMode(newMode);
    // Keep query and searchTerm so user doesn't have to retype
  };

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4 animate-fade-in-up">
        <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
          Discover <span className="text-gradient">Audiobooks</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          {mode === 'discover'
            ? 'Search metadata providers to find books and authors'
            : 'Search across your configured indexers to find your next listen'}
        </p>
      </div>

      {/* Mode Toggle */}
      <div className="flex justify-center animate-fade-in-up stagger-1">
        <div className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            onClick={() => handleModeChange('discover')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${mode === 'discover'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <SearchIcon className="w-4 h-4" />
            Discover Books
          </button>
          <button
            onClick={() => handleModeChange('indexer')}
            className={`
              flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
              ${mode === 'indexer'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'}
            `}
          >
            <DownloadIcon className="w-4 h-4" />
            Search Indexers
          </button>
        </div>
      </div>

      {/* Search Form */}
      <form
        onSubmit={handleSearch}
        className="max-w-3xl mx-auto animate-fade-in-up stagger-2"
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
              placeholder={
                mode === 'discover'
                  ? 'Search by title, author, or series...'
                  : 'Search audiobooks...'
              }
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

      {/* Notifications */}
      <div className="max-w-3xl mx-auto space-y-3">
        {error && (
          <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl animate-fade-in">
            <AlertCircleIcon className="w-5 h-5 shrink-0" />
            <p>{error.message}</p>
          </div>
        )}

        {grabMutation.isSuccess && (
          <div className="flex items-center gap-3 px-4 py-3 bg-success/10 text-success rounded-xl animate-fade-in">
            <CheckCircleIcon className="w-5 h-5 shrink-0" />
            <p>Download started! Check the Activity page.</p>
          </div>
        )}

        {grabMutation.isError && (
          <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl animate-fade-in">
            <AlertCircleIcon className="w-5 h-5 shrink-0" />
            <p>Failed to start download: {grabMutation.error.message}</p>
          </div>
        )}
      </div>

      {/* Results */}
      {mode === 'discover' ? (
        <DiscoverResults
          results={metadataResults}
          searchTerm={searchTerm}
          isLoading={metadataLoading}
          queryClient={queryClient}
        />
      ) : (
        <IndexerResults
          results={indexerResults}
          searchTerm={searchTerm}
          isLoading={indexerLoading}
          onGrab={handleGrab}
          isGrabbing={grabMutation.isPending}
        />
      )}
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
  const [imageError, setImageError] = useState(false);

  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-center gap-4">
        {/* Author Image */}
        <div className="shrink-0">
          {author.imageUrl && !imageError ? (
            <div className="relative w-14 h-14 sm:w-16 sm:h-16 rounded-full overflow-hidden shadow-lg">
              <img
                src={author.imageUrl}
                alt={author.name}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setImageError(true)}
              />
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-full" />
            </div>
          ) : (
            <div className="w-14 h-14 sm:w-16 sm:h-16 bg-muted rounded-full flex items-center justify-center">
              <UsersIcon className="w-6 h-6 text-muted-foreground" />
            </div>
          )}
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
  const [imageError, setImageError] = useState(false);
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
          {book.coverUrl && !imageError ? (
            <div className="relative w-20 h-28 sm:w-24 sm:h-32 rounded-xl overflow-hidden shadow-lg">
              <img
                src={book.coverUrl}
                alt={book.title}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setImageError(true)}
              />
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-xl" />
            </div>
          ) : (
            <div className="w-20 h-28 sm:w-24 sm:h-32 bg-muted rounded-xl flex items-center justify-center">
              <BookOpenIcon className="w-8 h-8 text-muted-foreground" />
            </div>
          )}
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
            {book.genres && book.genres.length > 0 && (
              <span className="text-xs px-2 py-1 bg-muted rounded-lg font-medium text-muted-foreground">
                {book.genres[0]}
              </span>
            )}
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

// ============================================================================
// Indexer Results (existing behavior)
// ============================================================================

function IndexerResults({
  results,
  searchTerm,
  isLoading,
  onGrab,
  isGrabbing,
}: {
  results: SearchResult[] | undefined;
  searchTerm: string;
  isLoading: boolean;
  onGrab: (result: SearchResult) => void;
  isGrabbing: boolean;
}) {
  if (results && results.length > 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground animate-fade-in">
          Found {results.length} result{results.length !== 1 ? 's' : ''} for "{searchTerm}"
        </p>
        <div className="grid gap-4">
          {results.map((result, index) => (
            <IndexerResultCard
              key={result.infoHash || index}
              result={result}
              onGrab={() => onGrab(result)}
              isGrabbing={isGrabbing}
              index={index}
            />
          ))}
        </div>
      </div>
    );
  }

  if (searchTerm && !isLoading && results?.length === 0) {
    return (
      <EmptyState
        icon={<SearchIcon className="w-12 h-12" />}
        title={`No results for "${searchTerm}"`}
        description="Try different keywords or check your indexer settings"
      />
    );
  }

  if (!searchTerm) {
    return (
      <EmptyState
        icon={<DownloadIcon className="w-16 h-16" />}
        title="Search indexers"
        description="Enter a title, author, or narrator to find audiobooks from your configured indexers"
      />
    );
  }

  return null;
}

// ============================================================================
// Indexer Result Card (preserved from original)
// ============================================================================

function IndexerResultCard({
  result,
  onGrab,
  isGrabbing,
  index,
}: {
  result: SearchResult;
  onGrab: () => void;
  isGrabbing: boolean;
  index: number;
}) {
  const [imageError, setImageError] = useState(false);

  return (
    <div
      className="group glass-card rounded-2xl p-4 sm:p-5 hover:shadow-card-hover hover:border-primary/30 transition-all duration-300 ease-out animate-fade-in-up"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex gap-4 sm:gap-5">
        {/* Cover Image */}
        <div className="shrink-0">
          {result.coverUrl && !imageError ? (
            <div className="relative w-20 h-28 sm:w-24 sm:h-32 rounded-xl overflow-hidden shadow-lg">
              <img
                src={result.coverUrl}
                alt={result.title}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={() => setImageError(true)}
              />
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-xl" />
            </div>
          ) : (
            <div className="w-20 h-28 sm:w-24 sm:h-32 bg-muted rounded-xl flex items-center justify-center">
              <BookOpenIcon className="w-8 h-8 text-muted-foreground" />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <h3 className="font-display text-lg sm:text-xl font-semibold line-clamp-2 group-hover:text-primary transition-colors">
            {result.title}
          </h3>

          {result.author && (
            <p className="text-muted-foreground mt-1">
              by <span className="text-foreground font-medium">{result.author}</span>
            </p>
          )}

          {result.narrator && (
            <p className="text-sm text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <UsersIcon className="w-3.5 h-3.5" />
              Narrated by {result.narrator}
            </p>
          )}

          {/* Metadata */}
          <div className="flex flex-wrap items-center gap-3 mt-auto pt-3">
            {result.size && (
              <span className="text-sm text-muted-foreground">
                {formatBytes(result.size)}
              </span>
            )}
            {result.seeders !== undefined && (
              <span className="flex items-center gap-1 text-sm text-success">
                <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
                {result.seeders} seeders
              </span>
            )}
            <span className="text-xs px-2 py-1 bg-muted rounded-lg font-medium text-muted-foreground">
              {result.indexer}
            </span>
          </div>
        </div>

        {/* Action */}
        <div className="shrink-0 flex items-center">
          <button
            onClick={onGrab}
            disabled={!result.downloadUrl || isGrabbing}
            className="
              flex items-center gap-2 px-4 py-2.5
              bg-primary text-primary-foreground font-medium rounded-xl
              hover:opacity-90 hover:shadow-glow
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-all duration-200 focus-ring
            "
          >
            {isGrabbing ? (
              <>
                <LoadingSpinner className="w-4 h-4" />
                <span className="hidden sm:inline">Grabbing...</span>
              </>
            ) : (
              <>
                <DownloadIcon className="w-4 h-4" />
                <span className="hidden sm:inline">Grab</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

