import { useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, formatBytes, type BookWithAuthor, type SearchResult } from '@/lib/api';
import { calculateQuality, qualityTierBg } from '@narratorr/core/utils';
import { queryKeys } from '@/lib/queryKeys';
import {
  SearchIcon,
  LoadingSpinner,
  DownloadIcon,
  BookOpenIcon,
  UsersIcon,
  XIcon,
  RefreshIcon,
  ShieldBanIcon,
} from '@/components/icons';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { CoverImage } from '@/components/CoverImage';
import { ProtocolBadge } from '@/components/ProtocolBadge';

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

  const blacklistMutation = useMutation({
    mutationFn: api.addToBlacklist,
    onSuccess: () => {
      toast.success('Release blacklisted');
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      queryClient.invalidateQueries({ queryKey: ['search-releases'] });
    },
    onError: (err: Error) => {
      toast.error(`Failed to blacklist: ${err.message}`);
    },
  });

  const handleBlacklist = (result: SearchResult) => {
    if (!result.infoHash) {
      toast.error('Cannot blacklist: no info hash available');
      return;
    }
    blacklistMutation.mutate({
      infoHash: result.infoHash,
      title: result.title,
      bookId: book.id,
    });
  };

  const grabMutation = useMutation({
    mutationFn: api.grab,
    onSuccess: () => {
      toast.success('Download started! Check the Activity page.');
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
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

  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

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
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col glass-card rounded-2xl shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
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
                    bookDurationSeconds={book.audioDuration ?? (book.duration ? book.duration * 60 : undefined)}
                    onGrab={() => handleGrab(result)}
                    onBlacklist={() => handleBlacklist(result)}
                    isGrabbing={grabMutation.isPending}
                    isBlacklisting={blacklistMutation.isPending}
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
  bookDurationSeconds,
  onGrab,
  onBlacklist,
  isGrabbing,
  isBlacklisting,
}: {
  result: SearchResult;
  bookDurationSeconds?: number;
  onGrab: () => void;
  onBlacklist: () => void;
  isGrabbing: boolean;
  isBlacklisting: boolean;
}) {
  const quality = result.size && bookDurationSeconds
    ? calculateQuality(result.size, bookDurationSeconds)
    : null;
  return (
    <div className="glass-card rounded-xl p-4 hover:border-primary/30 transition-all duration-200">
      <div className="flex gap-4">
        {/* Cover */}
        <div className="shrink-0">
          <CoverImage
            src={result.coverUrl}
            alt={result.title}
            className="w-14 h-20 rounded-lg"
            fallback={<BookOpenIcon className="w-6 h-6 text-muted-foreground/40" />}
          />
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
            <ProtocolBadge protocol={result.protocol} />
            <span className="text-xs px-1.5 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
              {result.indexer}
            </span>
            {quality && (
              <span className={`text-xs px-1.5 py-0.5 rounded-md font-medium ${qualityTierBg(quality.tier)}`}>
                {quality.tier} · {quality.mbPerHour} MB/hr
              </span>
            )}
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
            onClick={onBlacklist}
            disabled={!result.infoHash || isBlacklisting}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-ring rounded px-1.5 py-1"
            title={result.infoHash ? 'Blacklist this release' : 'No info hash available'}
          >
            {isBlacklisting ? (
              <LoadingSpinner className="w-3 h-3" />
            ) : (
              <ShieldBanIcon className="w-3 h-3" />
            )}
            Blacklist
          </button>
        </div>
      </div>
    </div>
  );
}
