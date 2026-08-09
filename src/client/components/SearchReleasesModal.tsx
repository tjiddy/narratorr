import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type SearchResult } from '@/lib/api';
import type { BookStatus } from '@shared/schemas/book.js';
import { grabSchema, type GrabPayload } from '@shared/schemas/search.js';
import { searchResultKey, deduplicateKeys } from '@/lib/stableKeys.js';
import { resolveBookQualityInputs, calculateQuality } from '@core/utils/index.js';
import { queryKeys } from '@/lib/queryKeys';
import { XIcon, RefreshIcon, SearchIcon, LoadingSpinner } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesContent } from '@/components/SearchReleasesContent';
import { useSearchStream } from '@/hooks/useSearchStream';
import { useReplaceGrab } from '@/hooks/useReplaceGrab';
import { getErrorMessage } from '@/lib/error-message.js';

// Shared minimum accepted from book details and library cards.
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

function SearchReleasesHeader({
  book,
  isSearching,
  refreshDisabled,
  onRefresh,
  onClose,
}: {
  book: SearchReleasesBookInput;
  isSearching: boolean;
  refreshDisabled: boolean;
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
          disabled={refreshDisabled}
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
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

function SearchReleasesQueryInput({
  query,
  isSearching,
  canSearch,
  onQueryChange,
  onSearch,
}: {
  query: string;
  isSearching: boolean;
  canSearch: boolean;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearch();
    }
  };

  return (
    <div className="flex gap-2 px-6 pt-4">
      <input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={500}
        placeholder="Search by title and author..."
        className="flex-1 px-3 py-2 glass-card rounded-xl text-sm focus-ring"
        aria-label="Search query"
      />
      <button
        type="button"
        onClick={onSearch}
        disabled={!canSearch}
        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
      >
        {isSearching ? <LoadingSpinner className="w-3.5 h-3.5" /> : <SearchIcon className="w-3.5 h-3.5" />}
        Search
      </button>
    </div>
  );
}

// UI-only grab fields excluded from the SearchResult projection.
const CONTEXT_KEYS = new Set(['bookId', 'replace']);
const GRAB_RESULT_KEYS = Object.keys(grabSchema.shape).filter(k => !CONTEXT_KEYS.has(k));

// Keep the projection aligned with grabSchema; callers must require downloadUrl.
function pickGrabFields(result: SearchResult): Omit<GrabPayload, 'bookId'> {
  const picked: Record<string, unknown> = {};
  for (const key of GRAB_RESULT_KEYS) {
    picked[key] = result[key as keyof SearchResult];
  }
  return picked as Omit<GrabPayload, 'bookId'>;
}

function deriveQuery(book: SearchReleasesBookInput): string {
  return `${book.title} ${book.authors[0]?.name ?? ''}`.trim();
}

// key={book.id} makes book changes synchronously discard all body-owned state.
function SearchReleasesBody({
  book,
  onClose,
}: {
  book: SearchReleasesBookInput;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(() => deriveQuery(book));
  const { durationSeconds } = resolveBookQualityInputs(book);

  const { state, actions } = useSearchStream(query, {
    title: book.title,
    author: book.authors[0]?.name,
    bookDuration: durationSeconds ?? undefined,
  });
  const { start: startSearch } = actions;

  // Every trigger must pass this server-aligned guard; startSearch() does not validate it.
  const trimmedLength = query.trim().length;
  const canSearch = trimmedLength >= 2 && trimmedLength <= 500 && state.phase !== 'searching';
  // Adopt a relaxed query only if the user has not edited since this search started.
  const lastSearchedRef = useRef<string | null>(null);
  const runSearch = useCallback(() => {
    if (canSearch) {
      lastSearchedRef.current = query;
      startSearch();
    }
  }, [canSearch, query, startSearch]);

  const relaxedQuery = state.results?.relaxedQuery;
  useEffect(() => {
    if (relaxedQuery === undefined || relaxedQuery === query) return;
    if (lastSearchedRef.current === null || query !== lastSearchedRef.current) return;
    lastSearchedRef.current = relaxedQuery;
    setQuery(relaxedQuery);
  }, [relaxedQuery, query]);

  const results = state.results?.results;
  const resultKeys = useMemo(() => deduplicateKeys((results ?? []).map(searchResultKey)), [results]);

  // Error blocks auto-retry; phase plus stream replacement makes StrictMode converge on one stream.
  useEffect(() => {
    if (state.phase === 'idle' && !state.error && state.authReady) {
      runSearch();
    }
  }, [state.phase, state.error, state.authReady, runSearch]);

  const blacklistMutation = useMutation({
    mutationFn: api.addToBlacklist,
    onSuccess: (_data, variables) => {
      toast.success('Release blacklisted');
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      actions.removeResult(variables);
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

  const { grab, isGrabbing, confirm, reset: resetReplace } = useReplaceGrab(onClose, book.title);

  // Layout cleanup invalidates old grabs before a replacement book becomes interactive.
  useLayoutEffect(() => resetReplace, [resetReplace]);

  const handleGrab = (result: SearchResult) => {
    if (!result.downloadUrl) {
      toast.error('No download link available for this result');
      return;
    }
    grab({
      ...pickGrabFields(result),
      bookId: book.id,
    });
  };

  return (
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
        refreshDisabled={!canSearch}
        onRefresh={runSearch}
        onClose={onClose}
      />
      <SearchReleasesQueryInput
        query={query}
        isSearching={state.phase === 'searching'}
        canSearch={canSearch}
        onQueryChange={setQuery}
        onSearch={runSearch}
      />
      <SearchReleasesContent
        phase={state.phase}
        indexers={state.indexers}
        hasResults={state.hasResults}
        error={state.error}
        searchResponse={state.results}
        resultKeys={resultKeys}
        book={book}
        isGrabbing={isGrabbing}
        isBlacklisting={blacklistMutation.isPending}
        onCancelIndexer={actions.cancelIndexer}
        onShowResults={actions.showResults}
        onRetry={runSearch}
        retryDisabled={!canSearch}
        onGrab={handleGrab}
        onBlacklist={handleBlacklist}
      />
      {confirm && (
        <ConfirmModal
          isOpen={confirm.isOpen}
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Cancel & Replace"
          cancelLabel="Keep Existing"
          confirmDisabled={confirm.isPending}
          onConfirm={confirm.onConfirm}
          onCancel={confirm.onCancel}
        />
      )}
    </div>
  );
}

export function SearchReleasesModal({ isOpen, book, onClose }: SearchReleasesModalProps) {
  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} className="w-full max-w-4xl max-h-[85vh] flex flex-col">
      <SearchReleasesBody key={book.id} book={book} onClose={onClose} />
    </Modal>
  );
}
