import { useSyncExternalStore } from 'react';
import type { SSEEventType, SSEEventPayloads } from '../../../shared/schemas/sse-events';

export interface IndexerState {
  name: string;
  status: 'pending' | 'complete' | 'error';
  resultsFound?: number;
  elapsedMs?: number;
  error?: string;
}

export interface SearchCardState {
  bookId: number;
  bookTitle: string;
  indexers: Map<number, IndexerState>;
  outcome?: 'grabbed' | 'no_results';
  grabbedFrom?: string;
}

const DISMISS_DELAY_MS = 3000;

const searchProgressMap = new Map<number, SearchCardState>();
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

// Cached snapshot — invalidated on every notify()
let cachedSnapshot: SearchCardState[] = [];

function notify() {
  cachedSnapshot = [...searchProgressMap.values()];
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function scheduleDismiss(bookId: number): void {
  // Clear any existing timer
  const existing = dismissTimers.get(bookId);
  if (existing) clearTimeout(existing);

  dismissTimers.set(bookId, setTimeout(() => {
    searchProgressMap.delete(bookId);
    dismissTimers.delete(bookId);
    notify();
  }, DISMISS_DELAY_MS));
}

type SearchEventType = Extract<SSEEventType, `search_${string}`>;

/** Called by useEventSource to update search progress state. */
export function handleSearchEvent<T extends SearchEventType>(
  type: T,
  data: SSEEventPayloads[T],
): void {
  if (type === 'search_started') {
    const d = data as SSEEventPayloads['search_started'];
    // Clear any pending dismiss timer for this book
    const existing = dismissTimers.get(d.book_id);
    if (existing) clearTimeout(existing);
    dismissTimers.delete(d.book_id);

    const indexers = new Map<number, IndexerState>();
    for (const indexer of d.indexers) {
      indexers.set(indexer.id, { name: indexer.name, status: 'pending' });
    }
    searchProgressMap.set(d.book_id, {
      bookId: d.book_id,
      bookTitle: d.book_title,
      indexers,
    });
    notify();
    return;
  }

  if (type === 'search_indexer_complete') {
    const d = data as SSEEventPayloads['search_indexer_complete'];
    const entry = searchProgressMap.get(d.book_id);
    if (!entry) return;
    entry.indexers.set(d.indexer_id, {
      name: d.indexer_name,
      status: 'complete',
      resultsFound: d.results_found,
      elapsedMs: d.elapsed_ms,
    });
    notify();
    return;
  }

  if (type === 'search_indexer_error') {
    const d = data as SSEEventPayloads['search_indexer_error'];
    const entry = searchProgressMap.get(d.book_id);
    if (!entry) return;
    entry.indexers.set(d.indexer_id, {
      name: d.indexer_name,
      status: 'error',
      error: d.error,
      elapsedMs: d.elapsed_ms,
    });
    notify();
    return;
  }

  if (type === 'search_grabbed') {
    const d = data as SSEEventPayloads['search_grabbed'];
    const entry = searchProgressMap.get(d.book_id);
    if (!entry) return;
    entry.outcome = 'grabbed';
    entry.grabbedFrom = d.indexer_name;
    scheduleDismiss(d.book_id);
    notify();
    return;
  }

  if (type === 'search_complete') {
    const d = data as SSEEventPayloads['search_complete'];
    const entry = searchProgressMap.get(d.book_id);
    if (!entry) return;
    if (!entry.outcome) {
      entry.outcome = d.outcome;
    }
    if (d.outcome === 'no_results') {
      scheduleDismiss(d.book_id);
    } else if (d.outcome === 'grabbed' && !dismissTimers.has(d.book_id)) {
      scheduleDismiss(d.book_id);
    }
    notify();
    return;
  }
}

/** Reactive hook — returns all active search progress entries. */
export function useSearchProgress(): SearchCardState[] {
  return useSyncExternalStore(
    subscribe,
    () => cachedSnapshot,
    () => [],
  );
}

/** Reset store state for testing. */
export function _resetForTesting(): void {
  searchProgressMap.clear();
  for (const timer of dismissTimers.values()) clearTimeout(timer);
  dismissTimers.clear();
  listeners.clear();
  cachedSnapshot = [];
}
