import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type SearchResult } from '@/lib/api';
import type { BookStatus } from '../../shared/schemas/book.js';
import { grabSchema, type GrabPayload } from '../../shared/schemas/search.js';
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

// ============================================================================
// Query input (persistent across all phases — the editable-query escape hatch)
// ============================================================================

/** The editable, book-derived query input + Search button. Rendered persistently
 *  across every phase (searching / results / empty / error) so the user can always
 *  re-fire an edited query. Enter and Search both route through `onSearch`
 *  (`runSearch`), which self-gates on `canSearch` — never an unconditional fire. */
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

// ============================================================================
// Component
// ============================================================================

/** Fields from grabSchema that are NOT sourced from a SearchResult: `bookId` comes
 *  from UI context, and `replace` (#1857) is set only on a user-confirmed replace —
 *  excluding it here keeps the picker from treating it as a SearchResult field. */
const CONTEXT_KEYS = new Set(['bookId', 'replace']);
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

/** Prefill mirrors the Fix Match modal: `"{title} {author}"`, author omitted if
 *  absent, trimmed (no trailing space). Read only at mount — the stateful body is
 *  keyed by `book.id`, so a book change remounts and re-seeds rather than copying
 *  a stale value into existing state (see the `derived-state-over-copied` learning). */
function deriveQuery(book: SearchReleasesBookInput): string {
  return `${book.title} ${book.authors[0]?.name ?? ''}`.trim();
}

/**
 * Stateful modal body. Rendered `key={book.id}` by the outer shell so a book change
 * REMOUNTS it — discarding results/indexers/query/pending-replace synchronously in
 * the same commit (F7/F8). Owns the query `useState`, `useSearchStream`,
 * `useReplaceGrab`, handlers, and the single guarded start path (F6/F9).
 */
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

  // Single eligibility predicate + single start helper (F6). EVERY start trigger
  // (Search / Enter / Refresh / Retry / auto-start) routes through `runSearch`,
  // the only place the server's 2..500-and-not-searching contract is enforced —
  // `useSearchStream.start()` has no length/phase guard of its own.
  const trimmedLength = query.trim().length;
  const canSearch = trimmedLength >= 2 && trimmedLength <= 500 && state.phase !== 'searching';
  const runSearch = useCallback(() => {
    if (canSearch) startSearch();
  }, [canSearch, startSearch]);

  const results = state.results?.results;
  const resultKeys = useMemo(() => deduplicateKeys((results ?? []).map(searchResultKey)), [results]);

  // Auto-start once on mount (fresh book). Gated on `canSearch` (which subsumes the
  // 2..500 check, closing the over-500 programmatic-prefill hole) plus idle + no
  // prior error + authReady. Requiring `!state.error` is what keeps a failed search
  // from auto-retrying AND makes StrictMode's setup→cleanup→setup probe converge on
  // exactly one live stream: each `start()` closes the prior one, and once the phase
  // leaves 'idle' the effect stops firing (F8/F12).
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
      // Drop the blacklisted row(s) from the open results immediately (local-state
      // only, no refetch). The mutation variables already carry `{ infoHash?, guid? }`,
      // so pass them straight through — the hook owns identity matching (independent
      // OR-match on either identifier), NOT the render key, which never consults `guid`.
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

  // Grab + cancel-&-replace state machine (#1857) — owns the multi-code 409
  // branching, the confirm dialog, and pending-replace state.
  const { grab, isGrabbing, confirm, reset: resetReplace } = useReplaceGrab(onClose, book.title);

  // Advance the replace-grab lifecycle generation on a SYNCHRONOUS seam at teardown
  // (F10/F16). This body unmounts on both close (outer returns null) and book change
  // (key remount); a layout-phase cleanup runs before the next book's body is
  // interactive, whereas a passive `useEffect` cleanup runs after B has committed —
  // leaving a window in which an old in-flight grab that settles could toast/confirm
  // against, or close, book B. The always-run cache invalidations stay unconditional.
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

/** Thin outer shell: `<Modal>` chrome + `isOpen` gate. The stateful body is keyed
 *  by `book.id` so a book change remounts it, discarding the previous book's search
 *  state synchronously (F7). */
export function SearchReleasesModal({ isOpen, book, onClose }: SearchReleasesModalProps) {
  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} className="w-full max-w-4xl max-h-[85vh] flex flex-col">
      <SearchReleasesBody key={book.id} book={book} onClose={onClose} />
    </Modal>
  );
}
