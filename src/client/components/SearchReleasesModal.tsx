import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, formatBytes, type BookWithAuthor, type SearchResult } from '@/lib/api';
import { searchResultKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { calculateQuality, compareQuality, resolveBookQualityInputs, qualityTierBg } from '@core/utils/index.js';
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
  AlertTriangleIcon,
  ChevronDownIcon,
} from '@/components/icons';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Modal } from '@/components/Modal';
import { CoverImage } from '@/components/CoverImage';
import { ProtocolBadge } from '@/components/ProtocolBadge';
import { ConfirmModal } from '@/components/ConfirmModal';

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

interface PendingGrabParams {
  downloadUrl: string;
  title: string;
  protocol: 'torrent' | 'usenet';
  bookId?: number;
  indexerId?: number;
  size?: number;
  seeders?: number;
}

// eslint-disable-next-line max-lines-per-function, complexity -- modal orchestrates query + mutations + 5 conditional states
export function SearchReleasesModal({ isOpen, book, onClose }: SearchReleasesModalProps) {
  const queryClient = useQueryClient();
  const searchQuery = `${book.title} ${book.authors[0]?.name ?? ''}`.trim();

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: queryKeys.searchReleases(book.id, searchQuery),
    queryFn: () => {
      const { durationSeconds } = resolveBookQualityInputs(book);
      return api.searchBooks(searchQuery, {
        title: book.title,
        author: book.authors[0]?.name,
        bookDuration: durationSeconds ?? undefined,
      });
    },
    enabled: isOpen && searchQuery.length >= 2,
  });
  const results = data?.results;
  const unsupportedResults = data?.unsupportedResults;
  const resultKeys = useMemo(() => deduplicateKeys((results ?? []).map(searchResultKey)), [results]);

  const blacklistMutation = useMutation({
    mutationFn: api.addToBlacklist,
    onSuccess: () => {
      toast.success('Release blacklisted');
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      queryClient.invalidateQueries({ queryKey: ['search-releases'] as const });
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
      reason: 'other',
    });
  };

  const grabMutation = useMutation({
    mutationFn: api.searchGrab,
    onSuccess: () => {
      toast.success('Download started! Check the Activity page.');
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
      setPendingReplace(null);
      onClose();
    },
    onError: (err: Error, variables) => {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: string })?.code === 'ACTIVE_DOWNLOAD_EXISTS') {
        setPendingReplace({
          downloadUrl: variables.downloadUrl,
          title: variables.title,
          protocol: variables.protocol ?? 'torrent',
          bookId: variables.bookId,
          indexerId: variables.indexerId,
          size: variables.size,
          seeders: variables.seeders,
        });
        return;
      }
      setPendingReplace(null);
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
      indexerId: result.indexerId,
      size: result.size,
      seeders: result.seeders,
    });
  };

  const [pendingReplace, setPendingReplace] = useState<PendingGrabParams | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

  if (!isOpen) return null;

  return (
    <>
    <Modal onClose={onClose} className="w-full max-w-3xl max-h-[85vh] flex flex-col">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-semibold truncate">
              Releases for: {book.title}
            </h3>
            {book.authors[0]?.name && (
              <p className="text-sm text-muted-foreground truncate">by {book.authors[0].name}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring"
              aria-label="Refresh results"
            >
              <RefreshIcon className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring"
              aria-label="Close modal"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 space-y-4">
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

          {/* Duration unknown banner */}
          {!isLoading && data?.durationUnknown && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-300">
              <AlertTriangleIcon className="w-4 h-4 shrink-0" />
              Duration unknown — quality filtering is disabled for this book
            </div>
          )}

          {/* Results */}
          {!isLoading && results && results.length > 0 && (
            <>
              <p className="text-sm text-muted-foreground">
                Found {results.length} release{results.length !== 1 ? 's' : ''}
              </p>
              <div className="grid gap-3">
                {results.map((result, index) => {
                  const { sizeBytes: bookSize, durationSeconds: bookDuration } = resolveBookQualityInputs(book);
                  return (
                    <ReleaseCard
                      key={resultKeys[index]}
                      result={result}
                      bookDurationSeconds={bookDuration ?? undefined}
                      existingBookSizeBytes={book.status === 'imported' ? (bookSize ?? undefined) : undefined}
                      onGrab={() => handleGrab(result)}
                      onBlacklist={() => handleBlacklist(result)}
                      isGrabbing={grabMutation.isPending}
                      isBlacklisting={blacklistMutation.isPending}
                    />
                  );
                })}
              </div>
            </>
          )}

          {/* Unsupported results */}
          {!isLoading && unsupportedResults && unsupportedResults.count > 0 && (
            <UnsupportedSection titles={unsupportedResults.titles} count={unsupportedResults.count} />
          )}
        </div>
      </div>
    </Modal>
    <ConfirmModal
      isOpen={pendingReplace !== null}
      title="Replace active download?"
      message={`"${pendingReplace?.title ?? ''}" already has an active download. Replace it with this release?`}
      confirmLabel="Replace"
      cancelLabel="Cancel"
      onConfirm={() => {
        if (pendingReplace) {
          grabMutation.mutate({ ...pendingReplace, replaceExisting: true });
        }
      }}
      onCancel={() => setPendingReplace(null)}
    />
    </>
  );
}

// ============================================================================
// Unsupported Section
// ============================================================================

function UnsupportedSection({ titles, count }: { titles: string[]; count: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-dashed border-border/40 rounded-xl bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-xs text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/30 transition-colors duration-200"
      >
        <ChevronDownIcon className={`w-3 h-3 shrink-0 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`} />
        <span>Found, but unsupported format ({count})</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-0 space-y-0.5 border-t border-border/20">
          {titles.map((title, i) => (
            <p key={`${title}-${i}`} className="text-xs text-muted-foreground/50 font-mono truncate" title={title}>
              {title}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Release Card
// ============================================================================

// eslint-disable-next-line complexity -- conditional quality display + action buttons
function ReleaseCard({
  result,
  bookDurationSeconds,
  existingBookSizeBytes,
  onGrab,
  onBlacklist,
  isGrabbing,
  isBlacklisting,
}: {
  result: SearchResult;
  bookDurationSeconds?: number;
  existingBookSizeBytes?: number;
  onGrab: () => void;
  onBlacklist: () => void;
  isGrabbing: boolean;
  isBlacklisting: boolean;
}) {
  const quality = result.size && bookDurationSeconds
    ? calculateQuality(result.size, bookDurationSeconds)
    : null;
  const comparison = existingBookSizeBytes
    ? compareQuality(existingBookSizeBytes, result.size, bookDurationSeconds)
    : null;
  return (
    <div className="glass-card rounded-xl p-4 hover:border-primary/30 transition-all duration-200 overflow-hidden">
      <div className="flex gap-4 overflow-hidden">
        {/* Cover */}
        <div className="shrink-0">
          <CoverImage
            src={result.coverUrl}
            alt={result.title}
            className="w-14 h-14 rounded-lg"
            fallback={<BookOpenIcon className="w-6 h-6 text-muted-foreground/40" />}
          />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          <h4 className="font-medium text-sm leading-tight truncate">
            {result.author && <span className="text-muted-foreground">{result.author} — </span>}
            {result.title}
          </h4>
          {result.rawTitle && (
            <p className="text-xs text-muted-foreground/60 truncate mt-0.5" title={result.rawTitle}>
              {result.rawTitle}
            </p>
          )}
          {result.narrator && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1 truncate">
              <UsersIcon className="w-3 h-3 shrink-0" />
              <span className="truncate">{result.narrator}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2.5 mt-auto pt-2">
            {result.size != null && result.size > 0 && (
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
            {comparison === 'lower' && (
              <span
                className="flex items-center gap-1 text-xs text-yellow-400"
                title="Your copy is likely better quality"
              >
                <AlertTriangleIcon className="w-3 h-3" />
                Lower quality
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
