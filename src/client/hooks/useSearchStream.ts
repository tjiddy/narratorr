import { useState, useEffect, useLayoutEffect, useRef, useCallback, type Dispatch, type SetStateAction } from 'react';
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
} from '@shared/schemas/search-stream.js';

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
  /** Match non-empty infoHash and guid independently, mirroring the server blacklist gate. */
  removeResult: (ref: { infoHash?: string; guid?: string }) => void;
}

// The route validates context independently of editable `q`; unbounded book metadata could make
// every request fail. Clamp only context to route maxima and leave the route schema authoritative.
const MAX_CONTEXT_TITLE = 500;
const MAX_CONTEXT_AUTHOR = 200;

function buildStreamUrl(query: string, context: SearchContext | undefined, token: string): string {
  const params = new URLSearchParams({ q: query });
  if (context?.author) params.set('author', context.author.slice(0, MAX_CONTEXT_AUTHOR));
  if (context?.title) params.set('title', context.title.slice(0, MAX_CONTEXT_TITLE));
  if (context?.bookDuration) params.set('bookDuration', String(context.bookDuration));
  if (token) params.set('token', token);
  return `${URL_BASE}/api/search/stream?${params.toString()}`;
}

// Refresh before the server's five-minute token TTL lapses (#1453).
const STREAM_TOKEN_REFRESH_MS = 4 * 60 * 1000;

/** Return the original response when nothing matches so setState remains a no-op. */
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

/** Data listeners stay lifecycle-free; extraction keeps the hook under the lint line cap. */
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
  // Before results, one stream error gets a transparent token remint; later errors are terminal.
  const remintAttemptedRef = useRef(false);
  const resultsShownRef = useRef(false);
  // Break the onerror → openStream self-dependency.
  const openStreamRef = useRef<(token: string) => void>(() => {});
  // Each start snapshots query/context under a generation advanced synchronously by start, reset,
  // and unmount. Stale remint continuations become no-ops; live ones reopen the snapshot, never a
  // later render. A numeric generation remains safe under StrictMode cleanup/setup probes.
  const sessionGenRef = useRef(0);
  const sessionSnapshotRef = useRef<{ query: string; context: SearchContext | undefined }>({
    query,
    context,
  });

  // The SSE endpoint accepts only short-lived stream tokens, not the long-lived API key (#1453).
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

  const openStream = useCallback((token: string) => {
    if (esRef.current) {
      esRef.current.close();
    }
    // A remint replays the submitted snapshot, not edits made while the search was running (F14).
    const { query: sessionQuery, context: sessionContext } = sessionSnapshotRef.current;
    const url = buildStreamUrl(sessionQuery, sessionContext, token);
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
      if (!resultsShownRef.current && !remintAttemptedRef.current) {
        remintAttemptedRef.current = true;
        // Bind both fulfillment and rejection to this session; neither may reopen or fail a newer
        // session after start, reset, or unmount advances the generation (F11/F17/F18).
        const scheduledGen = sessionGenRef.current;
        api.mintStreamToken()
          .then(({ token: fresh }) => {
            if (sessionGenRef.current !== scheduledGen) return;
            openStreamRef.current(fresh);
          })
          .catch(() => {
            if (sessionGenRef.current !== scheduledGen) return;
            failConnection();
          });
        return;
      }
      failConnection();
    };
  }, [clearFinalizingTimeout, failConnection]);

  useEffect(() => { openStreamRef.current = openStream; }, [openStream]);

  const start = useCallback(() => {
    if (!streamToken) return;

    cleanup();
    sessionGenRef.current += 1;
    sessionSnapshotRef.current = { query, context };
    setPhase('searching');
    setResults(null);
    setError(null);
    setIndexers([]);
    setSessionId(null);
    cancelledRef.current.clear();
    remintAttemptedRef.current = false;
    resultsShownRef.current = false;

    openStream(streamToken.token ?? '');
  }, [streamToken, cleanup, openStream, query, context]);

  const cancelIndexer = useCallback((indexerId: number) => {
    if (!sessionId || cancelledRef.current.has(indexerId)) return;
    cancelledRef.current.add(indexerId);

    setIndexers(prev => prev.map(idx =>
      idx.id === indexerId ? { ...idx, status: 'cancelled' as IndexerStatus } : idx,
    ));

    api.cancelSearchIndexer(sessionId, indexerId).catch(() => {
      // The indexer may already have completed, so cancellation failure is non-critical.
    });
  }, [sessionId]);

  const showResults = useCallback(() => {
    for (const idx of indexers) {
      if (idx.status === 'pending') {
        cancelIndexer(idx.id);
      }
    }
    // Enter results immediately; search-complete fills data later. From here, stream errors are
    // terminal because the user has already left the active-search view.
    resultsShownRef.current = true;
    setPhase('results');

    // Bound the wait for search-complete so finalizing cannot hang forever.
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
    sessionGenRef.current += 1;
    setPhase('idle');
    setSessionId(null);
    setIndexers([]);
    setResults(null);
    setError(null);
    cancelledRef.current.clear();
    remintAttemptedRef.current = false;
    resultsShownRef.current = false;
  }, [cleanup]);

  // Layout cleanup advances the generation before the next keyed UI becomes interactive. Passive
  // cleanup leaves a commit window where a remint can reopen an orphan stream; numeric generation
  // comparison keeps the synchronous seam StrictMode-safe.
  useLayoutEffect(() => () => {
    sessionGenRef.current += 1;
    cleanup();
  }, [cleanup]);

  const hasResults = indexers.some(idx => idx.status === 'complete' && (idx.resultCount ?? 0) > 0);

  const authReady = !!streamToken;

  return {
    state: { phase, sessionId, indexers, results, error, hasResults, authReady },
    actions: { start, cancelIndexer, showResults, reset, removeResult },
  };
}
