import { useState, useEffect, useRef, useCallback, type Dispatch, type SetStateAction } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { URL_BASE } from '@/lib/api/client';
import { safeParseEvent } from '@/lib/sse/safe-parse-event';
import type { SearchResponse, SearchContext } from '@/lib/api/search';
import {
  searchStartEventSchema,
  indexerCompleteEventSchema,
  indexerErrorEventSchema,
  indexerCancelledEventSchema,
  searchResponseSchema,
} from '../../shared/schemas/search-stream.js';

// ============================================================================
// Types
// ============================================================================

export type IndexerStatus = 'pending' | 'complete' | 'error' | 'cancelled';

export interface IndexerState {
  id: number;
  name: string;
  status: IndexerStatus;
  resultCount?: number;
  elapsedMs?: number;
  error?: string;
}

export type SearchPhase = 'idle' | 'searching' | 'results';

export interface SearchStreamState {
  phase: SearchPhase;
  sessionId: string | null;
  indexers: IndexerState[];
  results: SearchResponse | null;
  error: string | null;
  hasResults: boolean;
  authReady: boolean;
}

export interface SearchStreamActions {
  start: () => void;
  cancelIndexer: (indexerId: number) => void;
  showResults: () => void;
  reset: () => void;
  /** Drop all held results matching the blacklist identity. A held row is
   *  removed when EITHER non-empty identifier in `ref` equals the row's
   *  corresponding identifier (independent OR-match, mirroring server-side
   *  blacklist gating). Empty/absent identifiers never match; an empty/absent
   *  `ref` is a no-op. */
  removeResult: (ref: { infoHash?: string; guid?: string }) => void;
}

/** Build the SSE stream URL with query, context, and stream-token params (#1453). */
function buildStreamUrl(query: string, context: SearchContext | undefined, token: string): string {
  const params = new URLSearchParams({ q: query });
  if (context?.author) params.set('author', context.author);
  if (context?.title) params.set('title', context.title);
  if (context?.bookDuration) params.set('bookDuration', String(context.bookDuration));
  if (token) params.set('token', token);
  return `${URL_BASE}/api/search/stream?${params.toString()}`;
}

// Re-mint the stream token before its server-side TTL (5 min, #1453) lapses so an
// on-demand search never opens with a stale token.
const STREAM_TOKEN_REFRESH_MS = 4 * 60 * 1000;

/** Drop all results matching `ref` from a held response. A row matches when
 *  EITHER non-empty identifier in `ref` equals the row's corresponding
 *  identifier — an independent OR-match mirroring the server blacklist gate
 *  (`filterBlacklistedResults` in `search-pipeline.ts`, which OR-matches
 *  `infoHash` and `guid` independently). The per-identifier truthiness guard
 *  makes empty-string identifiers no-ops, and an empty/absent `ref` removes
 *  nothing. Returns the same reference when nothing matches so the setState is
 *  a no-op (no spurious re-render). */
function removeResultsMatching(
  prev: SearchResponse | null,
  ref: { infoHash?: string; guid?: string },
): SearchResponse | null {
  if (!prev) return prev;
  const filtered = prev.results.filter(
    r => !((ref.infoHash && r.infoHash === ref.infoHash) || (ref.guid && r.guid === ref.guid)),
  );
  if (filtered.length === prev.results.length) return prev;
  return { ...prev, results: filtered };
}

// ============================================================================
// Hook
// ============================================================================

export interface SearchStreamOptions {
  finalizingTimeoutMs?: number;
}

const DEFAULT_FINALIZING_TIMEOUT_MS = 10_000;

interface SearchStreamListeners {
  setSessionId: (id: string) => void;
  setIndexers: Dispatch<SetStateAction<IndexerState[]>>;
  setResults: (r: SearchResponse) => void;
  setPhase: (p: SearchPhase) => void;
  setError: (e: string) => void;
  clearFinalizingTimeout: () => void;
  markResultsShown: () => void;
}

/**
 * Wire the data-event listeners (search-start, indexer-*, search-complete) onto
 * an SSE stream. Pure with respect to connection lifecycle — onerror handling and
 * token re-mint/reconnect stay in the hook. Extracted to keep the hook body under
 * the max-lines-per-function cap.
 */
function attachSearchDataListeners(es: EventSource, l: SearchStreamListeners): void {
  es.addEventListener('search-start', (event: MessageEvent) => {
    const data = safeParseEvent('search-start', event, searchStartEventSchema);
    if (!data) return;
    l.setSessionId(data.sessionId);
    l.setIndexers(data.indexers.map(idx => ({
      id: idx.id,
      name: idx.name,
      status: 'pending' as IndexerStatus,
    })));
  });

  es.addEventListener('indexer-complete', (event: MessageEvent) => {
    const data = safeParseEvent('indexer-complete', event, indexerCompleteEventSchema);
    if (!data) return;
    l.setIndexers(prev => prev.map(idx =>
      idx.id === data.indexerId
        ? { ...idx, status: 'complete' as IndexerStatus, resultCount: data.resultCount, elapsedMs: data.elapsedMs }
        : idx,
    ));
  });

  es.addEventListener('indexer-error', (event: MessageEvent) => {
    const data = safeParseEvent('indexer-error', event, indexerErrorEventSchema);
    if (!data) return;
    l.setIndexers(prev => prev.map(idx =>
      idx.id === data.indexerId
        ? { ...idx, status: 'error' as IndexerStatus, error: data.error, elapsedMs: data.elapsedMs }
        : idx,
    ));
  });

  es.addEventListener('indexer-cancelled', (event: MessageEvent) => {
    const data = safeParseEvent('indexer-cancelled', event, indexerCancelledEventSchema);
    if (!data) return;
    l.setIndexers(prev => prev.map(idx =>
      idx.id === data.indexerId
        ? { ...idx, status: 'cancelled' as IndexerStatus }
        : idx,
    ));
  });

  es.addEventListener('search-complete', (event: MessageEvent) => {
    const data = safeParseEvent('search-complete', event, searchResponseSchema);
    if (!data) {
      l.clearFinalizingTimeout();
      l.setError('Search ended with malformed payload');
      l.setPhase('idle');
      es.close();
      return;
    }
    l.markResultsShown();
    l.clearFinalizingTimeout();
    l.setResults(data as SearchResponse);
    l.setPhase('results');
    es.close();
  });
}

export function useSearchStream(
  query: string,
  context?: SearchContext,
  options?: SearchStreamOptions,
): { state: SearchStreamState; actions: SearchStreamActions } {
  const finalizingTimeoutMs = options?.finalizingTimeoutMs ?? DEFAULT_FINALIZING_TIMEOUT_MS;
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [indexers, setIndexers] = useState<IndexerState[]>([]);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const cancelledRef = useRef(new Set<number>());
  const finalizingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Token-expiry recovery (#1453): the first stream error during an active search
  // (before results are shown) is most likely an expired stream token — re-mint
  // once and reconnect transparently before surfacing a terminal failure. Both
  // refs reset at the start of every search.
  const remintAttemptedRef = useRef(false);
  const resultsShownRef = useRef(false);
  // Holds the latest openStream so a reconnect can call it from inside onerror
  // without making openStream depend on itself.
  const openStreamRef = useRef<(token: string) => void>(() => {});

  // Mint a short-lived stream token (#1453) for SSE auth instead of reading the
  // long-lived API key — the search-stream endpoint is no longer key-reachable.
  const { data: streamToken } = useQuery({
    queryKey: queryKeys.auth.streamToken(),
    queryFn: api.mintStreamToken,
    staleTime: STREAM_TOKEN_REFRESH_MS,
    refetchInterval: STREAM_TOKEN_REFRESH_MS,
    refetchOnWindowFocus: false,
  });

  const clearFinalizingTimeout = useCallback(() => {
    if (finalizingTimeoutRef.current !== null) {
      clearTimeout(finalizingTimeoutRef.current);
      finalizingTimeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearFinalizingTimeout();
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, [clearFinalizingTimeout]);

  const failConnection = useCallback(() => {
    clearFinalizingTimeout();
    setError('Search connection failed');
    setPhase('idle');
  }, [clearFinalizingTimeout]);

  // Open (or re-open) the SSE stream with a given token. Extracted so the
  // onerror handler can transparently reconnect with a freshly minted token.
  const openStream = useCallback((token: string) => {
    if (esRef.current) {
      esRef.current.close();
    }
    const url = buildStreamUrl(query, context, token);
    const es = new EventSource(url);
    esRef.current = es;

    attachSearchDataListeners(es, {
      setSessionId,
      setIndexers,
      setResults,
      setPhase,
      setError,
      clearFinalizingTimeout,
      markResultsShown: () => { resultsShownRef.current = true; },
    });

    es.onerror = () => {
      es.close();
      // Transparent token-expiry recovery (#1453): the first error during an
      // active search (results not yet shown) is most likely an expired stream
      // token. Re-mint a fresh token and reconnect once before failing, so an
      // expired token never drops the user's search permanently. A second error,
      // or one after results are shown, is treated as a terminal failure.
      if (!resultsShownRef.current && !remintAttemptedRef.current) {
        remintAttemptedRef.current = true;
        api.mintStreamToken()
          .then(({ token: fresh }) => { openStreamRef.current(fresh); })
          .catch(failConnection);
        return;
      }
      failConnection();
    };
  }, [query, context, clearFinalizingTimeout, failConnection]);

  // Keep openStreamRef pointed at the latest openStream so onerror reconnects
  // with current query/context without a self-referential dependency.
  useEffect(() => { openStreamRef.current = openStream; }, [openStream]);

  const start = useCallback(() => {
    // Gate on stream-token readiness — don't open an unauthenticated stream
    if (!streamToken) return;

    cleanup();
    setPhase('searching');
    setResults(null);
    setError(null);
    setIndexers([]);
    setSessionId(null);
    cancelledRef.current.clear();
    remintAttemptedRef.current = false;
    resultsShownRef.current = false;

    openStream(streamToken.token ?? '');
  }, [streamToken, cleanup, openStream]);

  const cancelIndexer = useCallback((indexerId: number) => {
    if (!sessionId || cancelledRef.current.has(indexerId)) return;
    cancelledRef.current.add(indexerId);

    // Optimistically mark as cancelled
    setIndexers(prev => prev.map(idx =>
      idx.id === indexerId ? { ...idx, status: 'cancelled' as IndexerStatus } : idx,
    ));

    api.cancelSearchIndexer(sessionId, indexerId).catch(() => {
      // Cancel failure is non-critical — the indexer may have already completed
    });
  }, [sessionId]);

  const showResults = useCallback(() => {
    // Cancel all pending indexers
    for (const idx of indexers) {
      if (idx.status === 'pending') {
        cancelIndexer(idx.id);
      }
    }
    // Transition to Phase 2 immediately — don't wait for search-complete
    // The search-complete event will still arrive and set results data.
    // Past this point a stream error is terminal, not a token-expiry remint —
    // the user has already moved to the results view.
    resultsShownRef.current = true;
    setPhase('results');

    // Start a finalizing timeout — if search-complete doesn't arrive in time,
    // fall back to error state so the user isn't stuck on the spinner forever
    clearFinalizingTimeout();
    finalizingTimeoutRef.current = setTimeout(() => {
      finalizingTimeoutRef.current = null;
      setError('Search timed out waiting for results');
      setPhase('idle');
      cleanup();
    }, finalizingTimeoutMs);
  }, [indexers, cancelIndexer, finalizingTimeoutMs, clearFinalizingTimeout, cleanup]);

  const removeResult = useCallback((ref: { infoHash?: string; guid?: string }) => {
    setResults(prev => removeResultsMatching(prev, ref));
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setPhase('idle');
    setSessionId(null);
    setIndexers([]);
    setResults(null);
    setError(null);
    cancelledRef.current.clear();
    remintAttemptedRef.current = false;
    resultsShownRef.current = false;
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const hasResults = indexers.some(idx => idx.status === 'complete' && (idx.resultCount ?? 0) > 0);

  const authReady = !!streamToken;

  return {
    state: { phase, sessionId, indexers, results, error, hasResults, authReady },
    actions: { start, cancelIndexer, showResults, reset, removeResult },
  };
}
