import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type BookWithAuthor, type SearchResult } from '@/lib/api';
import { searchResultKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { resolveBookQualityInputs } from '@core/utils/index.js';
import { queryKeys } from '@/lib/queryKeys';
import {
  SearchIcon,
  LoadingSpinner,
  XIcon,
  RefreshIcon,
  AlertTriangleIcon,
  CheckIcon,
  AlertCircleIcon,
} from '@/components/icons';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { UnsupportedSection } from '@/components/UnsupportedSection';
import { ReleaseCard } from '@/components/ReleaseCard';
import { useSearchStream, type IndexerState } from '@/hooks/useSearchStream';

// ============================================================================
// Props
// ============================================================================

interface SearchReleasesModalProps {
  isOpen: boolean;
  book: BookWithAuthor;
  onClose: () => void;
}

// ============================================================================
// Indexer Status Row
// ============================================================================

function IndexerStatusIcon({ status }: { status: IndexerState['status'] }) {
  switch (status) {
    case 'pending':
      return <LoadingSpinner className="w-4 h-4 text-primary" />;
    case 'complete':
      return <CheckIcon className="w-4 h-4 text-green-400" />;
    case 'error':
      return <AlertCircleIcon className="w-4 h-4 text-destructive" />;
    case 'cancelled':
      return <XIcon className="w-4 h-4 text-muted-foreground" />;
  }
}

function IndexerStatusRow({
  indexer,
  onCancel,
}: {
  indexer: IndexerState;
  onCancel: (id: number) => void;
}) {
  const statusText = (() => {
    switch (indexer.status) {
      case 'pending': return 'Searching...';
      case 'complete': return `${indexer.resultCount ?? 0} result${(indexer.resultCount ?? 0) !== 1 ? 's' : ''}`;
      case 'error': return indexer.error ?? 'Failed';
      case 'cancelled': return 'Cancelled';
    }
  })();

  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-card/50">
      <div className="flex items-center gap-3 min-w-0">
        <IndexerStatusIcon status={indexer.status} />
        <span className="text-sm font-medium truncate">{indexer.name}</span>
        <span className={`text-xs ${indexer.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {statusText}
        </span>
      </div>
      {indexer.status === 'pending' && (
        <button
          type="button"
          onClick={() => onCancel(indexer.id)}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/80 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
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
  guid?: string;
}

// eslint-disable-next-line max-lines-per-function, complexity -- modal orchestrates streaming + mutations + 7 conditional states
export function SearchReleasesModal({ isOpen, book, onClose }: SearchReleasesModalProps) {
  const queryClient = useQueryClient();
  const searchQuery = `${book.title} ${book.authors[0]?.name ?? ''}`.trim();
  const { durationSeconds } = resolveBookQualityInputs(book);

  const { state, actions } = useSearchStream(searchQuery, {
    title: book.title,
    author: book.authors[0]?.name,
    bookDuration: durationSeconds ?? undefined,
  });

  const results = state.results?.results;
  const unsupportedResults = state.results?.unsupportedResults;
  const resultKeys = useMemo(() => deduplicateKeys((results ?? []).map(searchResultKey)), [results]);

  // Auto-start search when modal opens (retries when auth becomes ready)
  const hasStartedRef = useRef(false);
  useEffect(() => {
    if (isOpen && searchQuery.length >= 2 && state.phase === 'idle' && state.authReady) {
      hasStartedRef.current = true;
      actions.start();
    }
    if (!isOpen) {
      hasStartedRef.current = false;
      actions.reset();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- trigger on isOpen and authReady
  }, [isOpen, state.authReady]);

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
          guid: variables.guid,
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
      guid: result.guid,
    });
  };

  const [pendingReplace, setPendingReplace] = useState<PendingGrabParams | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

  if (!isOpen) return null;

  const isSearching = state.phase === 'searching';
  const isResults = state.phase === 'results';

  return (
    <>
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-3xl max-h-[85vh] flex flex-col">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1"
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
              onClick={() => {
                hasStartedRef.current = false;
                actions.reset();
                // Re-trigger search
                setTimeout(() => {
                  hasStartedRef.current = true;
                  actions.start();
                }, 0);
              }}
              disabled={isSearching}
              className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring"
              aria-label="Refresh results"
            >
              <RefreshIcon className={`w-4 h-4 ${isSearching ? 'animate-spin' : ''}`} />
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
          {/* Phase 1: Indexer status view */}
          {isSearching && (
            <>
              <div className="space-y-2">
                {state.indexers.map(indexer => (
                  <IndexerStatusRow
                    key={indexer.id}
                    indexer={indexer}
                    onCancel={actions.cancelIndexer}
                  />
                ))}
                {state.indexers.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12">
                    <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
                    <p className="text-muted-foreground">Connecting to indexers...</p>
                  </div>
                )}
              </div>
              {state.hasResults && (
                <div className="flex justify-center pt-2">
                  <button
                    type="button"
                    onClick={actions.showResults}
                    className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors focus-ring"
                  >
                    Show results
                  </button>
                </div>
              )}
            </>
          )}

          {/* Connection error */}
          {state.error && !isSearching && !isResults && (
            <div className="flex flex-col items-center justify-center py-12 space-y-3">
              <div className="flex items-center gap-3 px-4 py-3 bg-destructive/10 text-destructive rounded-xl">
                <p>Search failed: {state.error}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  hasStartedRef.current = true;
                  actions.start();
                }}
                className="text-sm text-primary hover:text-primary/80"
              >
                Retry
              </button>
            </div>
          )}

          {/* Phase 2: Results view */}
          {isResults && (
            <>
              {/* Loading — results not yet received from server */}
              {!state.results && (
                <div className="flex flex-col items-center justify-center py-12">
                  <LoadingSpinner className="w-8 h-8 text-primary mb-4" />
                  <p className="text-muted-foreground">Finalizing results...</p>
                </div>
              )}

              {/* Empty */}
              {results?.length === 0 && state.results && (
                <div className="flex flex-col items-center justify-center py-12">
                  <SearchIcon className="w-10 h-10 text-muted-foreground/40 mb-4" />
                  <p className="text-muted-foreground">No releases found</p>
                </div>
              )}

              {/* Duration unknown banner */}
              {state.results?.durationUnknown && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-300">
                  <AlertTriangleIcon className="w-4 h-4 shrink-0" />
                  Duration unknown — quality filtering is disabled for this book
                </div>
              )}

              {/* Results */}
              {results && results.length > 0 && (
                <>
                  <p className="text-sm text-muted-foreground">
                    Found {results.length} release{results.length !== 1 ? 's' : ''}
                  </p>
                  <div className="grid gap-3">
                    {results.map((result, index) => {
                      const { sizeBytes: bookSize, durationSeconds: bookDur } = resolveBookQualityInputs(book);
                      return (
                        <ReleaseCard
                          key={resultKeys[index]}
                          result={result}
                          bookDurationSeconds={bookDur ?? undefined}
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
              {unsupportedResults && unsupportedResults.count > 0 && (
                <UnsupportedSection titles={unsupportedResults.titles} count={unsupportedResults.count} />
              )}
            </>
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
