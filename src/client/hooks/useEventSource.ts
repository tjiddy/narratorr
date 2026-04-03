import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { URL_BASE } from '@/lib/api/client';
import type { Download } from '@/lib/api';
import {
  type SSEEventType,
  type SSEEventPayloads,
  type CacheInvalidationRule,
  CACHE_INVALIDATION_MATRIX,
  TOAST_EVENT_CONFIG,
} from '../../shared/schemas.js';
import { setMergeProgress } from './useMergeProgress.js';

// ============================================================================
// Reactive SSE connection state (F3)
// ============================================================================

/** Module-level SSE connection state with subscribe/notify for useSyncExternalStore. */
let sseConnected = false;
const sseListeners = new Set<() => void>();

function setSseConnected(value: boolean) {
  if (sseConnected === value) return;
  sseConnected = value;
  for (const listener of sseListeners) {
    listener();
  }
}

function subscribeSseConnected(callback: () => void): () => void {
  sseListeners.add(callback);
  return () => { sseListeners.delete(callback); };
}

function getSseConnected(): boolean {
  return sseConnected;
}

/** Reactive hook — triggers re-render when SSE connection state changes. */
export function useSSEConnected(): boolean {
  return useSyncExternalStore(subscribeSseConnected, getSseConnected, getSseConnected);
}

/** Non-reactive getter for use outside React (e.g., tests). */
export function isSSEConnected(): boolean {
  return sseConnected;
}

/** Patch download progress in-place across cached activity pages; returns true if found.
 *  Skips non-page queries (e.g. activityCounts) that share the ['activity'] prefix
 *  but have a different data shape ({ active, completed } instead of { data[], total }). */
function patchActivityProgress(queryClient: ReturnType<typeof useQueryClient>, progressData: SSEEventPayloads['download_progress']): { found: boolean; hasPageQueries: boolean } {
  const cachedQueries = queryClient.getQueryCache().findAll({ queryKey: ['activity'] });
  let found = false;
  let hasPageQueries = false;
  for (const query of cachedQueries) {
    const cached = query.state.data as { data?: unknown } | undefined;
    if (!cached || !Array.isArray(cached.data)) continue;
    hasPageQueries = true;
    queryClient.setQueryData<{ data: Download[]; total: number }>(query.queryKey, (old) => {
      if (!old?.data) return old;
      const patched = old.data.map((d) => {
        if (d.id === progressData.download_id) {
          found = true;
          return { ...d, progress: progressData.percentage };
        }
        return d;
      });
      return { ...old, data: patched };
    });
  }
  return { found, hasPageQueries };
}

/** Apply cache invalidation rules for an SSE event. */
function invalidateFromRule(
  queryClient: ReturnType<typeof useQueryClient>,
  rule: CacheInvalidationRule,
  type: SSEEventType,
  data: SSEEventPayloads[typeof type],
): void {
  if (rule.activity === 'invalidate') {
    queryClient.invalidateQueries({ queryKey: ['activity'] });
  } else if (rule.activity === 'patch') {
    const { found, hasPageQueries } = patchActivityProgress(queryClient, data as SSEEventPayloads['download_progress']);
    // Cache miss — download not in any cached page. Fall back to full invalidation.
    // Skip when no page queries are cached (only activityCounts) — can't miss from a page that isn't loaded.
    if (!found && hasPageQueries) {
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      queryClient.invalidateQueries({ queryKey: queryKeys.activityCounts() });
    }
  }
  if (rule.activityCounts) {
    queryClient.invalidateQueries({ queryKey: queryKeys.activityCounts() });
  }
  if (rule.books) {
    queryClient.invalidateQueries({ queryKey: ['books'] });
    if ('book_id' in data && typeof data.book_id === 'number') {
      queryClient.invalidateQueries({ queryKey: queryKeys.book(data.book_id) });
    }
  }
  if (rule.eventHistory) {
    queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
  }
}

/**
 * Connects to the SSE endpoint and handles cache invalidation + toast notifications.
 * Should be mounted once at the app root.
 */
export function useEventSource(apiKey: string | null) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback((type: SSEEventType, data: SSEEventPayloads[typeof type]) => {
    const rule = CACHE_INVALIDATION_MATRIX[type];
    invalidateFromRule(queryClient, rule, type, data);

    // Merge progress tracking — update the reactive store
    updateMergeProgressFromEvent(type, data);

    // Toast notifications
    const toastConfig = TOAST_EVENT_CONFIG[type];
    if (toastConfig) {
      const title = toastConfig.titleKey in data
        ? String((data as Record<string, unknown>)[toastConfig.titleKey])
        : type;
      const message = formatToastMessage(type, title);
      switch (toastConfig.level) {
        case 'success': toast.success(message, { duration: 5000 }); break;
        case 'info': toast.info(message, { duration: 5000 }); break;
        case 'warning': toast.warning(message, { duration: 5000 }); break;
        case 'error': toast.error(message, { duration: 5000 }); break;
      }
    }
  }, [queryClient]);

  useEffect(() => {
    if (!apiKey) return;

    const url = `${URL_BASE}/api/events?apikey=${encodeURIComponent(apiKey)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
    };

    es.onerror = () => {
      setSseConnected(false);
      // Browser auto-reconnects; on reconnect we invalidate everything
    };

    // Listen for each event type
    const eventTypes: SSEEventType[] = [
      'download_progress', 'download_status_change', 'book_status_change',
      'import_complete', 'grab_started', 'review_needed', 'merge_complete',
      'merge_started', 'merge_progress', 'merge_failed',
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          handleEvent(type, data);
        } catch {
          // Malformed event — ignore
        }
      });
    }

    // On reconnect (detected via onopen after error), invalidate all queries
    let hadError = false;
    const origOnError = es.onerror;
    es.onerror = (e) => {
      hadError = true;
      origOnError?.call(es, e);
    };
    const origOnOpen = es.onopen;
    es.onopen = (e) => {
      setSseConnected(true);
      if (hadError) {
        // Reconnected — invalidate everything to catch up
        queryClient.invalidateQueries();
        hadError = false;
      }
      origOnOpen?.call(es, e);
    };

    return () => {
      setSseConnected(false);
      es.close();
      esRef.current = null;
    };
  }, [apiKey, handleEvent, queryClient]);
}

function updateMergeProgressFromEvent(type: SSEEventType, data: SSEEventPayloads[typeof type]): void {
  if (type === 'merge_started' && 'book_id' in data) {
    setMergeProgress((data as SSEEventPayloads['merge_started']).book_id, { phase: 'starting' });
  } else if (type === 'merge_progress' && 'book_id' in data) {
    const progressData = data as SSEEventPayloads['merge_progress'];
    setMergeProgress(progressData.book_id, {
      phase: progressData.phase,
      percentage: progressData.percentage,
    });
  } else if ((type === 'merge_complete' || type === 'merge_failed') && 'book_id' in data) {
    setMergeProgress((data as { book_id: number }).book_id, null);
  }
}

function formatToastMessage(type: SSEEventType, title: string): string {
  switch (type) {
    case 'import_complete': return `"${title}" imported successfully`;
    case 'grab_started': return `Downloading "${title}"`;
    case 'review_needed': return `"${title}" needs review`;
    case 'merge_started': return `Merging "${title}"...`;
    case 'merge_failed': return `"${title}" merge failed`;
    case 'merge_complete': return title; // title is the message field (includes filename)
    default: return title;
  }
}
