import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type SearchResult } from '@/lib/api';
import type { BookStatus } from '../../shared/schemas/book.js';
import { grabSchema, type GrabPayload } from '../../shared/schemas/search.js';
import { searchResultKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { resolveBookQualityInputs, calculateQuality } from '@core/utils/index.js';
import { queryKeys } from '@/lib/queryKeys';
import { XIcon, RefreshIcon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { SearchReleasesContent } from '@/components/SearchReleasesContent';
import { useSearchStream } from '@/hooks/useSearchStream';
import { getErrorMessage } from '@/lib/error-message.js';

// ============================================================================
// Props
// ============================================================================

/** Structural minimum the modal reads off the book. Satisfied by both
 *  `BookWithAuthor` (book detail page) and `LibraryBookListItem` (library
 *  list card). The extra fields on BookWithAuthor are unused here. */
export interface SearchReleasesBookInput {
  id: number;
  title: string;
  status: BookStatus;
  authors: ReadonlyArray<{ name: string }>;
  narrators: ReadonlyArray<{ name: string }>;
  audioTotalSize?: number | null;
  audioDuration?: number | null;
  size?: number | null;
  duration?: number | null;
  lastGrabGuid?: string | null;
  lastGrabInfoHash?: string | null;
}

interface SearchReleasesModalProps {
  isOpen: boolean;
  book: SearchReleasesBookInput;
  onClose: () => void;
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
  book: SearchReleasesBookInput;
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
const CONTEXT_KEYS = new Set(['bookId']);
const GRAB_RESULT_KEYS = Object.keys(grabSchema.shape).filter(k => !CONTEXT_KEYS.has(k));

/** Pick SearchResult-sourced grab-contract fields dynamically from grabSchema.shape.
 *  Caller must guard `result.downloadUrl` before calling — the return type assumes it is present. */
function pickGrabFields(result: SearchResult): Omit<GrabPayload, 'bookId'> {
  const picked: Record<string, unknown> = {};
  for (const key of GRAB_RESULT_KEYS) {
    picked[key] = result[key as keyof SearchResult];
  }
  return picked as Omit<GrabPayload, 'bookId'>;
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
      ...(result.infoHash && { infoHash: result.infoHash }),
      ...(result.guid && { guid: result.guid }),
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
      onClose();
    },
    onError: (err: Error) => {
      toast.error(`Failed to grab: ${getErrorMessage(err)}. If a download is already active for this book, cancel it manually from the Activity page first.`);
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

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} className="w-full max-w-4xl max-h-[85vh] flex flex-col">
      <div
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
  );
}
