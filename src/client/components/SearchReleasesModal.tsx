import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type BookWithAuthor, type SearchResult } from '@/lib/api';
import { grabSchema, type GrabPayload } from '../../shared/schemas/search.js';
import { searchResultKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { resolveBookQualityInputs, calculateQuality } from '@core/utils/index.js';
import { queryKeys } from '@/lib/queryKeys';
import {
  LoadingSpinner,
  XIcon,
  RefreshIcon,
  CheckIcon,
  AlertCircleIcon,
} from '@/components/icons';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesContent } from '@/components/SearchReleasesContent';
import { useSearchStream, type IndexerState } from '@/hooks/useSearchStream';
import { getErrorMessage } from '@/lib/error-message.js';

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

export function IndexerStatusRow({
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
// Header
// ============================================================================

function SearchReleasesHeader({
  book,
  isSearching,
  onRefresh,
  onClose,
}: {
  book: BookWithAuthor;
  isSearching: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
      <div className="min-w-0">
        <h3 id="search-releases-modal-title" className="font-display text-lg font-semibold truncate">
          Releases for: {book.title}
        </h3>
        {book.authors[0]?.name && (
          <p className="text-sm text-muted-foreground truncate">by {book.authors[0].name}</p>
        )}
        {book.narrators?.length > 0 && (
          <p className="text-sm text-muted-foreground truncate">Narrated by {book.narrators.map(n => n.name).join(', ')}</p>
        )}
        {(() => { const q = calculateQuality(book.audioTotalSize ?? 0, book.audioDuration ?? 0); return q ? <p className="text-sm text-muted-foreground truncate">Current quality · {q.mbPerHour} MB/hr · {q.tier}</p> : null; })()}
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-4">
        <button
          type="button"
          onClick={onRefresh}
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
  );
}

// ============================================================================
// Component
// ============================================================================

/** Fields from grabSchema that come from SearchResult (not from UI context). */
const CONTEXT_KEYS = new Set(['bookId', 'replaceExisting']);
const GRAB_RESULT_KEYS = Object.keys(grabSchema.shape).filter(k => !CONTEXT_KEYS.has(k));

/** Pick SearchResult-sourced grab-contract fields dynamically from grabSchema.shape.
 *  Caller must guard `result.downloadUrl` before calling — the return type assumes it is present. */
function pickGrabFields(result: SearchResult): Omit<GrabPayload, 'bookId' | 'replaceExisting'> {
  const picked: Record<string, unknown> = {};
  for (const key of GRAB_RESULT_KEYS) {
    picked[key] = result[key as keyof SearchResult];
  }
  return picked as Omit<GrabPayload, 'bookId' | 'replaceExisting'>;
}

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
      toast.error(`Failed to blacklist: ${getErrorMessage(err)}`);
    },
  });

  const handleBlacklist = (result: SearchResult) => {
    if (!result.infoHash && !result.guid) {
      toast.error('Cannot blacklist: no identifier available');
      return;
    }
    blacklistMutation.mutate({
      infoHash: result.infoHash || undefined,
      guid: result.guid || undefined,
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
        setPendingReplace(variables);
        return;
      }
      setPendingReplace(null);
      toast.error(`Failed to grab: ${getErrorMessage(err)}`);
    },
  });

  const handleGrab = (result: SearchResult) => {
    if (!result.downloadUrl) {
      toast.error('No download link available for this result');
      return;
    }
    grabMutation.mutate({
      ...pickGrabFields(result),
      bookId: book.id,
    });
  };

  const [pendingReplace, setPendingReplace] = useState<GrabPayload | null>(null);

  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen && pendingReplace === null, onClose, modalRef);

  if (!isOpen) return null;

  return (
    <>
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-4xl max-h-[85vh] flex flex-col">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-releases-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1"
      >
        <SearchReleasesHeader
          book={book}
          isSearching={state.phase === 'searching'}
          onRefresh={() => {
            hasStartedRef.current = false;
            actions.reset();
            setTimeout(() => {
              hasStartedRef.current = true;
              actions.start();
            }, 0);
          }}
          onClose={onClose}
        />
        <SearchReleasesContent
          phase={state.phase}
          indexers={state.indexers}
          hasResults={state.hasResults}
          error={state.error}
          searchResponse={state.results}
          resultKeys={resultKeys}
          book={book}
          isGrabbing={grabMutation.isPending}
          isBlacklisting={blacklistMutation.isPending}
          onCancelIndexer={actions.cancelIndexer}
          onShowResults={actions.showResults}
          onRetry={() => {
            hasStartedRef.current = true;
            actions.start();
          }}
          onGrab={handleGrab}
          onBlacklist={handleBlacklist}
        />
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
