import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { queryKeys, isBookSeriesSearchKey } from '@/lib/queryKeys';
import { URL_BASE } from '@/lib/api/client';
import type { Download } from '@/lib/api';
import {
  type SSEEventType,
  type SSEEventPayloads,
  type CacheInvalidationRule,
  CACHE_INVALIDATION_MATRIX,
  TOAST_EVENT_CONFIG,
  sseEventTypeSchema,
} from '@shared/schemas.js';
import { setMergeProgress, applyMergeStateSnapshot } from './useMergeProgress.js';
import { handleSearchEvent } from './useSearchProgress.js';
import { safeParseSseEvent } from '@/lib/sse/safe-parse-event';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_EVENT } from '@shared/sse-constants.js';

// Half-open streams stay OPEN without errors; three missed heartbeat intervals force a reopen.
// Derive the threshold from the shared cadence so server and client cannot drift (#1798).
const SSE_SILENCE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;

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

export function useSSEConnected(): boolean {
  return useSyncExternalStore(subscribeSseConnected, getSseConnected, getSseConnected);
}

/** Skip non-page data such as activityCounts that shares the activity prefix but has another shape. */
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
          return { ...d, progress: progressData.percentage, downloadSpeed: progressData.speed };
        }
        return d;
      });
      return { ...old, data: patched };
    });
  }
  return { found, hasPageQueries };
}

function patchImportJobProgress(queryClient: ReturnType<typeof useQueryClient>, data: SSEEventPayloads['import_progress']): void {
  const cachedQueries = queryClient.getQueryCache().findAll({ queryKey: ['importJobs'] });
  let found = false;
  for (const query of cachedQueries) {
    const cached = query.state.data;
    if (!Array.isArray(cached)) continue;
    queryClient.setQueryData(query.queryKey, (old: unknown) => {
      if (!Array.isArray(old)) return old;
      return old.map((job: unknown) => {
        const j = job as Record<string, unknown>;
        if (j.id === data.job_id) {
          found = true;
          return { ...j, _progress: data.progress, _byteCounter: data.byte_counter, _progressPhase: data.phase };
        }
        return j;
      });
    });
  }
  if (!found) {
    queryClient.invalidateQueries({ queryKey: ['importJobs'] });
  }
}

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
    // Invalidate only a real page miss; an unloaded page cannot miss the download.
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
    // A series card shows its siblings' status buckets, but the event carries the SIBLING's id,
    // not the open page's — a targeted key would need the sibling→series→page mapping the client
    // deliberately does not hold. The whole singular root is cheap instead: react-query refetches
    // active queries only, so one open book page is one local getBookSeries call (#2541).
    // The Fix Series search is the one descendant that isn't cheap — refetching it re-runs a live
    // Hardcover search that a status change cannot have altered, once per tick of a download, and
    // blanks the open modal while it flies (#2592). Both filters are required: matchQuery ANDs
    // them, and the predicate alone would reach every namespace.
    queryClient.invalidateQueries({
      queryKey: queryKeys.singularBookRoot(),
      predicate: (query) => !isBookSeriesSearchKey(query.queryKey),
    });
  }
  if (rule.eventHistory) {
    queryClient.invalidateQueries({ queryKey: queryKeys.eventHistory.root() });
  }
  if (rule.importJobs === 'invalidate') {
    queryClient.invalidateQueries({ queryKey: ['importJobs'] });
  } else if (rule.importJobs === 'patch' && type === 'import_progress') {
    patchImportJobProgress(queryClient, data as SSEEventPayloads['import_progress']);
  }
}

function asPayload<T extends SSEEventType>(data: SSEEventPayloads[SSEEventType]): SSEEventPayloads[T] {
  return data as SSEEventPayloads[T];
}

/**
 * EventSource cannot set headers, so the short-lived token travels in the query string; null
 * opens nothing (#1453). A ref plus reconnect generation avoids churning healthy token refreshes
 * while still reopening after errors. The ref-backed error flag triggers one cache catch-up only
 * after a reconnect (#1776).
 */
export function useEventSource(streamToken: string | null, onStreamError?: () => void) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const hadErrorRef = useRef(false);
  // Any frame, including heartbeat, resets this wall-clock liveness timestamp (#1798).
  const lastFrameAtRef = useRef(0);
  const tokenRef = useRef<string | null>(streamToken);
  const onStreamErrorRef = useRef(onStreamError);
  useEffect(() => { onStreamErrorRef.current = onStreamError; }, [onStreamError]);
  const [reconnectKey, setReconnectKey] = useState(0);

  const handleEvent = useCallback((type: SSEEventType, data: SSEEventPayloads[typeof type]) => {
    const rule = CACHE_INVALIDATION_MATRIX[type];
    invalidateFromRule(queryClient, rule, type, data);

    updateMergeProgressFromEvent(type, data);

    if (type.startsWith('search_')) {
      handleSearchEvent(type as Extract<SSEEventType, `search_${string}`>, asPayload<Extract<SSEEventType, `search_${string}`>>(data));
    }

    dispatchToasts(type, data);
  }, [queryClient]);

  // Keep this effect before the token effect so `esRef` is populated before token reconciliation;
  // otherwise mount spuriously bumps the reconnect generation.
  useEffect(() => {
    const token = tokenRef.current;
    if (!token) return;

    const url = `${URL_BASE}/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;
    // Give the first frame a full silence window.
    lastFrameAtRef.current = Date.now();

    const refreshLiveness = () => { lastFrameAtRef.current = Date.now(); };

    // Coalesce watchdog/browser signals into one generation bump. Mark the error before closing
    // so the replacement stream performs the catch-up invalidation (#1798).
    let reconnecting = false;
    const forceReconnect = () => {
      if (reconnecting) return;
      reconnecting = true;
      setSseConnected(false);
      hadErrorRef.current = true;
      es.close();
      esRef.current = null;
      setReconnectKey((k) => k + 1);
    };

    const isStale = () => Date.now() - lastFrameAtRef.current > SSE_SILENCE_THRESHOLD_MS;

    es.onopen = () => {
      refreshLiveness();
      setSseConnected(true);
      if (hadErrorRef.current) {
        // Catch up once for events missed during the disconnected interval.
        queryClient.invalidateQueries();
        hadErrorRef.current = false;
      }
    };

    es.onerror = () => {
      setSseConnected(false);
      hadErrorRef.current = true;
      // Browser retries the same expired token, so ask the caller to mint one that can reopen (#1453).
      onStreamErrorRef.current?.();
    };

    // Schema options are the domain listener registry; every valid frame also proves liveness.
    const eventTypes: SSEEventType[] = [...sseEventTypeSchema.options];

    for (const type of eventTypes) {
      es.addEventListener(type, (event: MessageEvent) => {
        refreshLiveness();
        const parsed = safeParseSseEvent(type, event);
        if (parsed === null) return;
        handleEvent(type, parsed);
      });
    }

    // Named heartbeats bypass domain listeners and carry no payload, so register one explicitly.
    es.addEventListener(SSE_HEARTBEAT_EVENT, refreshLiveness);

    const watchdog = setInterval(() => {
      if (isStale()) forceReconnect();
    }, HEARTBEAT_INTERVAL_MS);

    // Browser wake/network signals can recover a stale stream before the next watchdog tick.
    const onOnline = () => { if (isStale()) forceReconnect(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isStale()) forceReconnect();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      setSseConnected(false);
      clearInterval(watchdog);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      es.close();
      esRef.current = null;
    };
  }, [reconnectKey, handleEvent, queryClient]);

  // Healthy token refreshes update only the ref. Missing/errored streams reopen; clearing the
  // token bumps the generation so cleanup closes the revoked stream without replacement.
  useEffect(() => {
    tokenRef.current = streamToken;
    const hasStream = esRef.current !== null;
    const needsReopen = !!streamToken && (!hasStream || hadErrorRef.current);
    const needsClose = !streamToken && hasStream;
    if (needsReopen || needsClose) {
      setReconnectKey((k) => k + 1);
    }
  }, [streamToken]);
}

function dispatchToasts(type: SSEEventType, data: SSEEventPayloads[typeof type]): void {
  const record = data as Record<string, unknown>;
  // Scheduled searches may have no cached book; grab failures must use payload copy directly.
  if (type === 'search_complete' && record.outcome === 'grab_error') {
    const p = asPayload<'search_complete'>(data);
    const title = p.book_title ?? 'Grab failed';
    const description = p.error_message ?? 'Unknown grab error';
    toast.error(title, { description, duration: 5000 });
  }

  const isCancelledMerge = type === 'merge_failed' && record.reason === 'cancelled';
  const toastConfig = TOAST_EVENT_CONFIG[type];
  if (toastConfig && !isCancelledMerge) {
    const title = toastConfig.titleKey in data
      ? String(record[toastConfig.titleKey])
      : type;
    const message = formatToastMessage(type, title);
    switch (toastConfig.level) {
      case 'success': toast.success(message, { duration: 5000 }); break;
      case 'info': toast.info(message, { duration: 5000 }); break;
      case 'warning': toast.warning(message, { duration: 5000 }); break;
      case 'error': toast.error(message, { duration: 5000 }); break;
    }
  }

  if (type === 'merge_complete') {
    const warning = asPayload<'merge_complete'>(data).enrichmentWarning;
    if (warning) {
      toast.warning(warning);
    }
  }
}

/**
 * `merge_state` is the sole non-terminal store writer; `merge_started` exists only for toast and
 * history invalidation (#2129/#2142). Terminal events still write details absent from snapshots,
 * which omit completed books so the store can retain them through the dismiss window.
 */
function updateMergeProgressFromEvent(type: SSEEventType, data: SSEEventPayloads[typeof type]): void {
  if (type === 'merge_state') {
    applyMergeStateSnapshot(asPayload<'merge_state'>(data));
  } else if (type === 'merge_complete') {
    const d = asPayload<'merge_complete'>(data);
    setMergeProgress(d.book_id, {
      bookTitle: d.book_title,
      phase: 'complete',
      outcome: 'success',
      message: d.message,
      ...(d.enrichmentWarning !== undefined && { enrichmentWarning: d.enrichmentWarning }),
    });
  } else if (type === 'merge_failed') {
    const d = asPayload<'merge_failed'>(data);
    const isCancelled = d.reason === 'cancelled';
    setMergeProgress(d.book_id, {
      bookTitle: d.book_title,
      phase: isCancelled ? 'cancelled' : 'failed',
      outcome: isCancelled ? 'cancelled' : 'error',
      error: d.error,
    });
  }
}

function formatToastMessage(type: SSEEventType, title: string): string {
  switch (type) {
    case 'import_complete': return `"${title}" imported successfully`;
    case 'import_failed': return `Import failed: "${title}"`;
    case 'grab_started': return `Downloading "${title}"`;
    case 'review_needed': return `"${title}" needs review`;
    case 'merge_started': return `Merging "${title}"...`;
    case 'merge_failed': return `"${title}" merge failed`;
    case 'merge_complete': return title;
    default: return title;
  }
}
