import { useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { URL_BASE } from '@/lib/api/client';
import type { Download } from '@/lib/api';
import {
  type SSEEventType,
  type SSEEventPayloads,
  CACHE_INVALIDATION_MATRIX,
  TOAST_EVENT_CONFIG,
} from '../../shared/schemas/sse-events.js';

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

/**
 * Connects to the SSE endpoint and handles cache invalidation + toast notifications.
 * Should be mounted once at the app root.
 */
export function useEventSource(apiKey: string | null) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback((type: SSEEventType, data: SSEEventPayloads[typeof type]) => {
    // Cache invalidation
    const rule = CACHE_INVALIDATION_MATRIX[type];
    if (rule.activity === 'invalidate') {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    } else if (rule.activity === 'patch') {
      // Patch the specific download row in-place to avoid full refetch
      const progressData = data as SSEEventPayloads['download_progress'];
      queryClient.setQueryData<Download[]>(queryKeys.activity(), (old) => {
        if (!old) return old;
        return old.map((d) =>
          d.id === progressData.download_id
            ? { ...d, progress: progressData.percentage }
            : d,
        );
      });
    }
    if (rule.activityCounts) {
      queryClient.invalidateQueries({ queryKey: queryKeys.activityCounts() });
    }
    if (rule.books) {
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      // Also invalidate individual book if we have a book_id
      if ('book_id' in data && typeof data.book_id === 'number') {
        queryClient.invalidateQueries({ queryKey: queryKeys.book(data.book_id) });
      }
    }
    if (rule.eventHistory) {
      queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
    }

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
      'import_complete', 'grab_started', 'review_needed',
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

function formatToastMessage(type: SSEEventType, title: string): string {
  switch (type) {
    case 'import_complete': return `"${title}" imported successfully`;
    case 'grab_started': return `Downloading "${title}"`;
    case 'review_needed': return `"${title}" needs review`;
    default: return title;
  }
}
