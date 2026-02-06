import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, type SearchResult } from '@/lib/api';

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function DownloadIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}

function BookOpenIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

function UsersIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function CheckCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}

export function SearchPage() {
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const queryClient = useQueryClient();

  const {
    data: results,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['search', searchTerm],
    queryFn: () => api.search(searchTerm),
    enabled: searchTerm.length >= 2,
  });

  const grabMutation = useMutation({
    mutationFn: api.grab,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchTerm(query);
  };

  const handleGrab = (result: SearchResult) => {
    if (!result.magnetUri) {
      alert('No magnet link available for this result');
      return;
    }
    grabMutation.mutate({
      magnetUri: result.magnetUri,
      title: result.title,
      size: result.size,
      seeders: result.seeders,
    });
  };

  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="text-center space-y-4 animate-fade-in-up">
        <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight">
          Discover <span className="text-gradient">Audiobooks</span>
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Search across your configured indexers to find your next listen
        </p>
      </div>

      {/* Search Form */}
      <form
        onSubmit={handleSearch}
        className="max-w-3xl mx-auto animate-fade-in-up stagger-1"
      >
        <div className="relative group">
          {/* Glow effect */}
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
              placeholder="Search audiobooks..."
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
            <p>
              Failed to start download: {grabMutation.error.message}
            </p>
          </div>
        )}
      </div>

      {/* Results */}
      {results && results.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground animate-fade-in">
            Found {results.length} result{results.length !== 1 ? 's' : ''} for "{searchTerm}"
          </p>
          <div className="grid gap-4">
            {results.map((result, index) => (
              <SearchResultCard
                key={result.infoHash || index}
                result={result}
                onGrab={() => handleGrab(result)}
                isGrabbing={grabMutation.isPending}
                index={index}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty States */}
      {searchTerm && !isLoading && results?.length === 0 && (
        <EmptyState
          icon={<SearchIcon className="w-12 h-12" />}
          title={`No results for "${searchTerm}"`}
          description="Try different keywords or check your indexer settings"
        />
      )}

      {!searchTerm && (
        <EmptyState
          icon={<BookOpenIcon className="w-16 h-16" />}
          title="Start your search"
          description="Enter a title, author, or narrator to find audiobooks from your configured indexers"
        />
      )}
    </div>
  );
}

function SearchResultCard({
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
      className={`
        group glass-card rounded-2xl p-4 sm:p-5
        hover:shadow-card-hover hover:border-primary/30
        transition-all duration-300 ease-out
        animate-fade-in-up
      `}
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
            disabled={!result.magnetUri || isGrabbing}
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

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 sm:py-24 animate-fade-in-up stagger-2">
      <div className="text-muted-foreground/40 mb-6">{icon}</div>
      <h3 className="font-display text-xl sm:text-2xl font-semibold text-center mb-2">
        {title}
      </h3>
      <p className="text-muted-foreground text-center max-w-md">{description}</p>
    </div>
  );
}
