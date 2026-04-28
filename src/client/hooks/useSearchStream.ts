import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { URL_BASE } from '@/lib/api/client';
import type { SearchResponse, SearchContext } from '@/lib/api/search';
import {
  searchStartEventSchema,
  indexerCompleteEventSchema,
  indexerErrorEventSchema,
  indexerCancelledEventSchema,
  searchResponseSchema,
} from '../../shared/schemas/search-stream.js';

function safeParseEvent<T extends z.ZodTypeAny>(
  type: string,
  event: MessageEvent,
  schema: T,
): z.infer<T> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(event.data);
  } catch (err) {
    console.warn(`SSE ${type}: invalid JSON`, err);
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    console.warn(`SSE ${type}: schema validation failed`, result.error);
    return null;
  }
  return result.data;
}

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
}

// ============================================================================
// Hook
// ============================================================================

export interface SearchStreamOptions {
  finalizingTimeoutMs?: number;
}

const DEFAULT_FINALIZING_TIMEOUT_MS = 10_000;

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

  const { data: authConfig } = useQuery({
    queryKey: queryKeys.auth.config(),
    queryFn: api.getAuthConfig,
    staleTime: Infinity,
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

  const start = useCallback(() => {
    // Gate on auth config readiness — don't open an unauthenticated stream
    if (!authConfig) return;

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

    const apiKey = authConfig.apiKey ?? '';
    if (apiKey) params.set('apikey', apiKey);

    const url = `${URL_BASE}/api/search/stream?${params.toString()}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('search-start', (event: MessageEvent) => {
      const data = safeParseEvent('search-start', event, searchStartEventSchema);
      if (!data) return;
      setSessionId(data.sessionId);
      setIndexers(data.indexers.map(idx => ({
        id: idx.id,
        name: idx.name,
        status: 'pending' as IndexerStatus,
      })));
    });

    es.addEventListener('indexer-complete', (event: MessageEvent) => {
      const data = safeParseEvent('indexer-complete', event, indexerCompleteEventSchema);
      if (!data) return;
      setIndexers(prev => prev.map(idx =>
        idx.id === data.indexerId
          ? { ...idx, status: 'complete' as IndexerStatus, resultCount: data.resultCount, elapsedMs: data.elapsedMs }
          : idx,
      ));
    });

    es.addEventListener('indexer-error', (event: MessageEvent) => {
      const data = safeParseEvent('indexer-error', event, indexerErrorEventSchema);
      if (!data) return;
      setIndexers(prev => prev.map(idx =>
        idx.id === data.indexerId
          ? { ...idx, status: 'error' as IndexerStatus, error: data.error, elapsedMs: data.elapsedMs }
          : idx,
      ));
    });

    es.addEventListener('indexer-cancelled', (event: MessageEvent) => {
      const data = safeParseEvent('indexer-cancelled', event, indexerCancelledEventSchema);
      if (!data) return;
      setIndexers(prev => prev.map(idx =>
        idx.id === data.indexerId
          ? { ...idx, status: 'cancelled' as IndexerStatus }
          : idx,
      ));
    });

    es.addEventListener('search-complete', (event: MessageEvent) => {
      const data = safeParseEvent('search-complete', event, searchResponseSchema);
      if (!data) {
        clearFinalizingTimeout();
        setError('Search ended with malformed payload');
        setPhase('idle');
        es.close();
        return;
      }
      clearFinalizingTimeout();
      setResults(data as SearchResponse);
      setPhase('results');
      es.close();
    });

    es.onerror = () => {
      clearFinalizingTimeout();
      setError('Search connection failed');
      setPhase('idle');
      es.close();
    };
  }, [query, context, authConfig, cleanup, clearFinalizingTimeout]);

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
    // The search-complete event will still arrive and set results data
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

  const authReady = !!authConfig;

  return {
    state: { phase, sessionId, indexers, results, error, hasResults, authReady },
    actions: { start, cancelIndexer, showResults, reset },
  };
}
