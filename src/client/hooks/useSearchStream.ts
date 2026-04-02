import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { URL_BASE } from '@/lib/api/client';
import type { SearchResponse, SearchContext } from '@/lib/api/search';

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
}

export interface SearchStreamActions {
  start: () => void;
  cancelIndexer: (indexerId: number) => void;
  showResults: () => void;
  reset: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useSearchStream(
  query: string,
  context?: SearchContext,
): { state: SearchStreamState; actions: SearchStreamActions } {
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [indexers, setIndexers] = useState<IndexerState[]>([]);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const cancelledRef = useRef(new Set<number>());

  const { data: authConfig } = useQuery({
    queryKey: queryKeys.auth.config(),
    queryFn: api.getAuthConfig,
    staleTime: Infinity,
  });

  const cleanup = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    cleanup();
    setPhase('searching');
    setResults(null);
    setError(null);
    setIndexers([]);
    setSessionId(null);
    cancelledRef.current.clear();

    const params = new URLSearchParams({ q: query });
    if (context?.author) params.set('author', context.author);
    if (context?.title) params.set('title', context.title);
    if (context?.bookDuration) params.set('bookDuration', String(context.bookDuration));

    const apiKey = authConfig?.apiKey ?? '';
    if (apiKey) params.set('apikey', apiKey);

    const url = `${URL_BASE}/api/search/stream?${params.toString()}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('search-start', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { sessionId: string; indexers: Array<{ id: number; name: string }> };
        setSessionId(data.sessionId);
        setIndexers(data.indexers.map(idx => ({
          id: idx.id,
          name: idx.name,
          status: 'pending' as IndexerStatus,
        })));
      } catch { /* malformed event */ }
    });

    es.addEventListener('indexer-complete', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { indexerId: number; name: string; resultCount: number; elapsedMs: number };
        setIndexers(prev => prev.map(idx =>
          idx.id === data.indexerId
            ? { ...idx, status: 'complete' as IndexerStatus, resultCount: data.resultCount, elapsedMs: data.elapsedMs }
            : idx,
        ));
      } catch { /* malformed event */ }
    });

    es.addEventListener('indexer-error', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { indexerId: number; name: string; error: string; elapsedMs: number };
        setIndexers(prev => prev.map(idx =>
          idx.id === data.indexerId
            ? { ...idx, status: 'error' as IndexerStatus, error: data.error, elapsedMs: data.elapsedMs }
            : idx,
        ));
      } catch { /* malformed event */ }
    });

    es.addEventListener('indexer-cancelled', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { indexerId: number };
        setIndexers(prev => prev.map(idx =>
          idx.id === data.indexerId
            ? { ...idx, status: 'cancelled' as IndexerStatus }
            : idx,
        ));
      } catch { /* malformed event */ }
    });

    es.addEventListener('search-complete', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SearchResponse;
        setResults(data);
        setPhase('results');
      } catch { /* malformed event */ }
      es.close();
    });

    es.onerror = () => {
      setError('Search connection failed');
      setPhase('idle');
      es.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- start should only be called explicitly
  }, [query, context?.author, context?.title, context?.bookDuration, authConfig?.apiKey, cleanup]);

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
    // The search-complete event will arrive from the server and trigger transition
  }, [indexers, cancelIndexer]);

  const reset = useCallback(() => {
    cleanup();
    setPhase('idle');
    setSessionId(null);
    setIndexers([]);
    setResults(null);
    setError(null);
    cancelledRef.current.clear();
  }, [cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const hasResults = indexers.some(idx => idx.status === 'complete' && (idx.resultCount ?? 0) > 0);

  return {
    state: { phase, sessionId, indexers, results, error, hasResults },
    actions: { start, cancelIndexer, showResults, reset },
  };
}
