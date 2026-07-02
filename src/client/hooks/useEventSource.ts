import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
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
  sseEventTypeSchema,
} from '../../shared/schemas.js';
import { setMergeProgress } from './useMergeProgress.js';
import { handleSearchEvent } from './useSearchProgress.js';
import { safeParseSseEvent } from '@/lib/sse/safe-parse-event';
import { HEARTBEAT_INTERVAL_MS, SSE_HEARTBEAT_EVENT } from '../../shared/sse-constants.js';

// Silence threshold for the liveness watchdog (#1798). A deaf (half-open) stream
// delivers no frames at all — not even heartbeats — yet EventSource keeps
// `readyState` OPEN and never fires `error`. If more than ~3 heartbeat intervals
// pass with no frame of any kind, the stream is treated as dead and force-reopened.
// Derived from the shared cadence (DRY) so tightening the heartbeat also tightens
// detection without a second constant to keep in sync.
const SSE_SILENCE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;

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
          return { ...d, progress: progressData.percentage, downloadSpeed: progressData.speed };
        }
        return d;
      });
      return { ...old, data: patched };
    });
  }
  return { found, hasPageQueries };
}

/** Patch import job progress in-place across cached import-jobs queries. */
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
  if (rule.importJobs === 'invalidate') {
    queryClient.invalidateQueries({ queryKey: ['importJobs'] });
  } else if (rule.importJobs === 'patch' && type === 'import_progress') {
    patchImportJobProgress(queryClient, data as SSEEventPayloads['import_progress']);
  }
}

/** Narrow an SSE payload to a specific event type. Single cast point for type safety. */
function asPayload<T extends SSEEventType>(data: SSEEventPayloads[SSEEventType]): SSEEventPayloads[T] {
  return data as SSEEventPayloads[T];
}

/**
 * Connects to the SSE endpoint and handles cache invalidation + toast notifications.
 * Should be mounted once at the app root.
 *
 * `streamToken` is the short-lived, session-scoped token (#1453) passed as the
 * `?token=` query param — EventSource cannot set headers. A null token means
 * "not ready yet" and no connection is opened. `onStreamError` (optional) fires
 * on the EventSource `error` event so the caller can re-mint an expired token.
 *
 * Reconnect model (#1776): the connection effect is keyed on a `reconnectKey`
 * generation, NOT on `streamToken`, so a routine 4-minute token refresh does not
 * churn a healthy stream. The freshest token is held in a ref and read at open
 * time. A token change only forces a reopen when there is no live stream yet
 * (first connect) or the current stream has errored (post-remint recovery) — so
 * a genuinely expired token still reaches the reopen path. The reconnect catch-up
 * (`invalidateQueries()`) is gated on a ref-backed error flag that survives the
 * effect rebuild, firing exactly once on the reopen and never on the first connect.
 */
export function useEventSource(streamToken: string | null, onStreamError?: () => void) {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);
  const hadErrorRef = useRef(false);
  // Wall-clock timestamp of the last frame received on the current stream (any
  // event, including the `hb` heartbeat). The watchdog compares it against
  // `Date.now()` to detect a silent stream (#1798).
  const lastFrameAtRef = useRef(0);
  const tokenRef = useRef<string | null>(streamToken);
  const onStreamErrorRef = useRef(onStreamError);
  useEffect(() => { onStreamErrorRef.current = onStreamError; }, [onStreamError]);
  const [reconnectKey, setReconnectKey] = useState(0);

  const handleEvent = useCallback((type: SSEEventType, data: SSEEventPayloads[typeof type]) => {
    const rule = CACHE_INVALIDATION_MATRIX[type];
    invalidateFromRule(queryClient, rule, type, data);

    // Merge progress tracking — update the reactive store
    updateMergeProgressFromEvent(type, data);

    // Search progress tracking — update the reactive store
    if (type.startsWith('search_')) {
      handleSearchEvent(type as Extract<SSEEventType, `search_${string}`>, asPayload<Extract<SSEEventType, `search_${string}`>>(data));
    }

    dispatchToasts(type, data);
  }, [queryClient]);

  // Opens the stream on the current `reconnectKey`, reading the freshest token
  // from the ref. Declared before the token effect so that on mount `esRef` is
  // populated by the time the token effect runs (avoids a spurious reopen).
  useEffect(() => {
    const token = tokenRef.current;
    if (!token) return;

    const url = `${URL_BASE}/api/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;
    // Seed liveness at open time so a slow first frame doesn't trip the watchdog
    // before the stream has had a chance to deliver anything.
    lastFrameAtRef.current = Date.now();

    // Any frame — domain event or `hb` heartbeat — proves the stream is live.
    const refreshLiveness = () => { lastFrameAtRef.current = Date.now(); };

    // Proactively tear down and reopen a stream the browser still believes is
    // OPEN (#1798). Guarded so a watchdog tick and an `online`/`visibilitychange`
    // fire in the same frame can't double-bump the reconnect generation. Mirrors
    // the `onerror` path: set the ref-backed error flag BEFORE closing so the
    // reopen's `onopen` fires the single catch-up invalidation.
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
        // Reconnected after a drop — invalidate everything to catch up on any
        // events missed while disconnected. Fires exactly once per reopen.
        queryClient.invalidateQueries();
        hadErrorRef.current = false;
      }
    };

    es.onerror = () => {
      setSseConnected(false);
      hadErrorRef.current = true;
      // Browser auto-reconnects the same instance; if the token has expired that
      // reconnect keeps failing, so ask the caller to re-mint (#1453). The fresh
      // token drives a reopen via the token effect above (which sees the error).
      onStreamErrorRef.current?.();
    };

    // Listen for each event type — derived from schema (single source of truth).
    // Every domain listener refreshes liveness so any real traffic counts (AC #2).
    const eventTypes: SSEEventType[] = [...sseEventTypeSchema.options];

    for (const type of eventTypes) {
      es.addEventListener(type, (event: MessageEvent) => {
        refreshLiveness();
        const parsed = safeParseSseEvent(type, event);
        if (parsed === null) return;
        handleEvent(type, parsed);
      });
    }

    // The named heartbeat (#1798) is not a domain event — it carries no payload and
    // is absent from `sseEventTypeSchema`, and EventSource routes named events by
    // name (not to `onmessage`), so it needs its own listener. It exists purely to
    // refresh liveness on an otherwise idle stream.
    es.addEventListener(SSE_HEARTBEAT_EVENT, refreshLiveness);

    // Watchdog: a deaf stream (NAT flush, proxy restart, laptop sleep/wake with no
    // RST) delivers no frames while `readyState` stays OPEN and `onerror` never
    // fires. Poll on the heartbeat cadence; once silence exceeds the threshold,
    // force the reopen so the recovery + catch-up path runs (AC #1).
    const watchdog = setInterval(() => {
      if (isStale()) forceReconnect();
    }, HEARTBEAT_INTERVAL_MS);

    // Cheap adjunct (#1798): a sleep/wake or network flap often surfaces as an
    // `online` or `visibilitychange` before the watchdog's next tick — check
    // liveness immediately so recovery isn't delayed by up to a full interval.
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

  // Keep the freshest token in a ref and decide whether it warrants a reconnect
  // by bumping the generation (which re-runs the connection effect above).
  //  - (Re)open when there is a token but no live stream (first connect after a
  //    null token) or the current one has errored (post-remint recovery). Never
  //    on a healthy refresh, which would churn the connection.
  //  - Close when the token is cleared to null while a stream is still open
  //    (e.g. logout / token revocation) — the connection effect re-runs, its
  //    cleanup closes the old EventSource, and the null token short-circuits the
  //    reopen, leaving no dangling connection on the revoked token.
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
  // Inline dispatch: search_complete + outcome:grab_error → error toast.
  // The book cache may be empty for scheduled/background searches, so use
  // payload.book_title and payload.error_message directly instead of a cache lookup.
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

  // Enrichment warning on merge_complete
  if (type === 'merge_complete') {
    const warning = asPayload<'merge_complete'>(data).enrichmentWarning;
    if (warning) {
      toast.warning(warning);
    }
  }
}

function updateMergeProgressFromEvent(type: SSEEventType, data: SSEEventPayloads[typeof type]): void {
  if (type === 'merge_queued' || type === 'merge_queue_updated') {
    const d = asPayload<'merge_queued'>(data);
    setMergeProgress(d.book_id, {
      bookTitle: d.book_title,
      phase: 'queued',
      position: d.position,
    });
  } else if (type === 'merge_started') {
    const d = asPayload<'merge_started'>(data);
    setMergeProgress(d.book_id, { bookTitle: d.book_title, phase: 'starting' });
  } else if (type === 'merge_progress') {
    const d = asPayload<'merge_progress'>(data);
    setMergeProgress(d.book_id, {
      bookTitle: d.book_title,
      phase: d.phase,
      ...(d.percentage !== undefined && { percentage: d.percentage }),
    });
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
    case 'merge_complete': return title; // title is the message field (includes filename)
    default: return title;
  }
}
