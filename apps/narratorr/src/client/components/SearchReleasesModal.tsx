import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, formatBytes, type BookWithAuthor, type SearchResult } from '@/lib/api';

// ============================================================================
// Icons
// ============================================================================

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
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

function DownloadIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
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

function UsersIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function XIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function RefreshIcon({ className = '' }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

// ============================================================================
// Props
// ============================================================================

interface SearchReleasesModalProps {
  isOpen: boolean;
  book: BookWithAuthor;
  onClose: () => void;
}

// ============================================================================
// Component
// ============================================================================

export function SearchReleasesModal({ isOpen, book, onClose }: SearchReleasesModalProps) {
  const queryClient = useQueryClient();
  const searchQuery = `${book.title} ${book.author?.name ?? ''}`.trim();

  const {
    data: results,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search-releases', book.id, searchQuery],
    queryFn: () => api.search(searchQuery),
    enabled: isOpen && searchQuery.length >= 2,
  });

  const grabMutation = useMutation({
    mutationFn: api.grab,
    onSuccess: () => {
      toast.success('Download started! Check the Activity page.');
      queryClient.invalidateQueries({ queryKey: ['books'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error(`Failed to grab: ${err.message}`);
    },
  });

  const handleGrab = (result: SearchResult) => {
    if (!result.downloadUrl) {
      toast.error('No download link available for this result');
      return;
    }
    grabMutation.mutate({
      downloadUrl: result.downloadUrl,
      title: result.title,
      protocol: result.protocol,
      bookId: book.id,
      size: result.size,
      seeders: result.seeders,
    });
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col glass-card rounded-2xl shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold truncate">
              Releases for: {book.title}
            </h3>
            {book.author?.name && (
              <p className="text-sm text-muted-foreground truncate">by {book.author.name}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button
              onClick={() => refetch()}
              disabled={isLoading}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring"
              aria-label="Refresh results"
            >
              <RefreshIcon className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring"
              aria-label="Close modal"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Loading */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-12">
              <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
              <p className="text-muted-foreground">Searching indexers...</p>
            </div>
          )}

          {/* Error */}
          {error && !isLoading && (
            <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl">
              <p>Search failed: {error.message}</p>
            </div>
          )}

          {/* Empty */}
          {!isLoading && !error && results?.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12">
              <SearchIcon className="w-10 h-10 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground">No releases found</p>
            </div>
          )}

          {/* Results */}
          {!isLoading && results && results.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Found {results.length} release{results.length !== 1 ? 's' : ''}
              </p>
              <div className="grid gap-3">
                {results.map((result, index) => (
                  <ReleaseCard
                    key={result.infoHash || index}
                    result={result}
                    onGrab={() => handleGrab(result)}
                    isGrabbing={grabMutation.isPending}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Release Card
// ============================================================================

function ReleaseCard({
  result,
  onGrab,
  isGrabbing,
}: {
  result: SearchResult;
  onGrab: () => void;
  isGrabbing: boolean;
}) {
  const [imageError, setImageError] = useState(false);

  return (
    <div className="glass-card rounded-xl p-4 hover:border-primary/30 transition-all duration-200">
      <div className="flex gap-4">
        {/* Cover */}
        <div className="shrink-0">
          {result.coverUrl && !imageError ? (
            <div className="relative w-14 h-20 rounded-lg overflow-hidden shadow-md">
              <img
                src={result.coverUrl}
                alt={result.title}
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
              />
              <div className="absolute inset-0 ring-1 ring-inset ring-black/10 rounded-lg" />
            </div>
          ) : (
            <div className="w-14 h-20 bg-muted rounded-lg flex items-center justify-center">
              <BookOpenIcon className="w-6 h-6 text-muted-foreground/40" />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <h4 className="font-medium text-sm leading-tight line-clamp-2">
            {result.title}
          </h4>
          {result.narrator && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
              <UsersIcon className="w-3 h-3" />
              {result.narrator}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2.5 mt-auto pt-2">
            {result.size != null && (
              <span className="text-xs text-muted-foreground">{formatBytes(result.size)}</span>
            )}
            {result.seeders !== undefined && (
              <span className="flex items-center gap-1 text-xs text-success">
                <span className="w-1.5 h-1.5 bg-success rounded-full animate-pulse" />
                {result.seeders} seeders
              </span>
            )}
            <span className="text-xs px-1.5 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
              {result.indexer}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="shrink-0 flex flex-col items-end gap-2">
          <button
            onClick={onGrab}
            disabled={!result.downloadUrl || isGrabbing}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary text-primary-foreground font-medium rounded-lg hover:opacity-90 hover:shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 focus-ring"
          >
            {isGrabbing ? (
              <LoadingSpinner className="w-3.5 h-3.5" />
            ) : (
              <DownloadIcon className="w-3.5 h-3.5" />
            )}
            Grab
          </button>
          <button
            disabled
            className="text-xs text-muted-foreground/50 cursor-not-allowed"
            title="Blacklisting coming soon (Issue #12)"
          >
            Blacklist
          </button>
        </div>
      </div>
    </div>
  );
}
