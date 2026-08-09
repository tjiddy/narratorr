import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useEventSource, useSSEConnected } from './useEventSource';
import { useMergeProgress, useMergeActivityCards, setMergeProgress, _resetForTesting as resetMergeStore } from './useMergeProgress';
import { handleSearchEvent } from './useSearchProgress';
import { queryKeys } from '@/lib/queryKeys';
import {
  CACHE_INVALIDATION_MATRIX,
  type CacheInvalidationRule,
  type SSEEventType,
  sseEventTypeSchema,
} from '@shared/schemas.js';
import { HEARTBEAT_INTERVAL_MS } from '@shared/sse-constants.js';

vi.mock('./useSearchProgress', () => ({
  handleSearchEvent: vi.fn(),
  _resetForTesting: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener() { /* noop */ }

  close() {
    this.readyState = 2;
  }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  simulateError() {
    this.onerror?.(new Event('error'));
  }

  simulateEvent(type: string, data: unknown) {
    const handlers = this.listeners.get(type) || [];
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const handler of handlers) {
      handler(event);
    }
  }

  simulateRawEvent(type: string, rawData: string) {
    const handlers = this.listeners.get(type) || [];
    const event = new MessageEvent(type, { data: rawData });
    for (const handler of handlers) {
      handler(event);
    }
  }
}

const originalEventSource = globalThis.EventSource;
beforeEach(() => {
  MockEventSource.instances = [];
  (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
});
afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
  vi.clearAllMocks();
});

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

describe('useEventSource', () => {
  describe('connection lifecycle', () => {
    it('connects to /api/events with the stream token query param (#1453)', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-stream-token'), { wrapper });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0]!.url).toBe('/api/events?token=test-stream-token');
    });

    it('does not connect when the stream token is null', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource(null), { wrapper });

      expect(MockEventSource.instances).toHaveLength(0);
    });

    it('invokes onStreamError when the EventSource errors so the caller can re-mint (#1453)', () => {
      const { wrapper } = createWrapper();
      const onStreamError = vi.fn();
      renderHook(() => useEventSource('test-stream-token', onStreamError), { wrapper });

      const es = MockEventSource.instances[0];
      act(() => { es!.simulateError(); });

      expect(onStreamError).toHaveBeenCalled();
    });

    it('cleans up EventSource on unmount', () => {
      const { wrapper } = createWrapper();
      const { unmount } = renderHook(() => useEventSource('key'), { wrapper });

      const es = MockEventSource.instances[0];
      unmount();

      expect(es!.readyState).toBe(2);
    });

    it('invalidates all query keys on reconnect', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateError();
        es!.simulateOpen();
      });

      expect(invalidateSpy).toHaveBeenCalledWith();
    });

    // A remint rebuilds the effect; the error flag must survive and catch up once on fresh open (#1776).
    it('fires the catch-up exactly once on a remint-driven reopen', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const onStreamError = vi.fn();

      const { rerender } = renderHook(
        ({ token }) => useEventSource(token, onStreamError),
        { wrapper, initialProps: { token: 'token-1' } },
      );

      const es1 = MockEventSource.instances[0];
      act(() => es1!.simulateOpen());
      act(() => es1!.simulateError());

      rerender({ token: 'token-2' });
      expect(MockEventSource.instances).toHaveLength(2);

      const es2 = MockEventSource.instances[1];
      const argless = invalidateSpy.mock.calls.filter((c) => c.length === 0);
      expect(argless).toHaveLength(0);

      act(() => es2!.simulateOpen());

      const arglessAfter = invalidateSpy.mock.calls.filter((c) => c.length === 0);
      expect(arglessAfter).toHaveLength(1);
    });

    it('does not catch up on the initial, no-prior-error connect', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      expect(invalidateSpy).not.toHaveBeenCalledWith();
    });

    it('does not tear down an OPEN stream when only the token refreshes', () => {
      const { wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ token }) => useEventSource(token),
        { wrapper, initialProps: { token: 'token-1' } },
      );

      const es1 = MockEventSource.instances[0];
      act(() => es1!.simulateOpen());

      rerender({ token: 'token-2' });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(es1!.readyState).not.toBe(2);
    });

    it('closes the open stream when the token is cleared to null', () => {
      const { wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ token }: { token: string | null }) => useEventSource(token),
        { wrapper, initialProps: { token: 'token-1' as string | null } },
      );

      const es1 = MockEventSource.instances[0];
      act(() => es1!.simulateOpen());

      act(() => rerender({ token: null }));

      expect(es1!.readyState).toBe(2);
      expect(MockEventSource.instances).toHaveLength(1);
    });

    it('reconnects with a fresh token after a null gap (token cleared then re-minted)', () => {
      const { wrapper } = createWrapper();

      const { rerender } = renderHook(
        ({ token }: { token: string | null }) => useEventSource(token),
        { wrapper, initialProps: { token: 'token-1' as string | null } },
      );

      const es1 = MockEventSource.instances[0];
      act(() => es1!.simulateOpen());
      act(() => rerender({ token: null }));
      act(() => rerender({ token: 'token-3' }));

      expect(MockEventSource.instances).toHaveLength(2);
      expect(MockEventSource.instances[1]!.url).toBe('/api/events?token=token-3');
    });
  });

  describe('cache invalidation per event type', () => {
    it('patches activity row in-place on download_progress across cached pages', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [
          { id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' },
          { id: 3, bookId: 4, title: 'Other', progress: 0.9, status: 'downloading' },
        ],
        total: 2,
      });

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
      expect(cached!.data).toHaveLength(2);
      expect(cached!.data[0]!.progress).toBe(0.5);
      expect(cached!.data[1]!.progress).toBe(0.9);
    });

    it('patches downloadSpeed onto the cached row from the download_progress event', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
        total: 1,
      });

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: 1_048_576, eta: null });
      });

      const cached = queryClient.getQueryData<{ data: { id: number; downloadSpeed: number | null }[]; total: number }>(queueKey);
      expect(cached!.data[0]!.downloadSpeed).toBe(1_048_576);
    });

    it('preserves downloadSpeed=0 (stalled) when patching — does NOT drop falsy values', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading', downloadSpeed: 1000 }],
        total: 1,
      });

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: 0, eta: null });
      });

      const cached = queryClient.getQueryData<{ data: { id: number; downloadSpeed: number | null }[]; total: number }>(queueKey);
      expect(cached!.data[0]!.downloadSpeed).toBe(0);
    });

    it('stores downloadSpeed as null when the SSE payload is null', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading', downloadSpeed: 1000 }],
        total: 1,
      });

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      const cached = queryClient.getQueryData<{ data: { id: number; downloadSpeed: number | null }[]; total: number }>(queueKey);
      expect(cached!.data[0]!.downloadSpeed).toBeNull();
    });

    it('does not invalidate activity queries on download_progress when download is in cache', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    });

    it('falls back to invalidation when download_progress arrives for a download not in any cached page', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    });

    it('does not invalidate when activity cache is completely empty (no pages loaded to miss from)', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    });

    it('does not invalidate when download_progress patches an existing download successfully', () => {
      const { wrapper, queryClient } = createWrapper();

      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    });

    it('invalidates activity and activityCounts on download_status_change', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_status_change', { download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity', 'counts'] });
    });

    it('invalidates books on book_status_change', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('book_status_change', { book_id: 42, old_status: 'importing', new_status: 'imported' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 42] });
    });

    it('invalidates activity, activityCounts, eventHistory on grab_started', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('grab_started', { download_id: 1, book_id: 2, book_title: 'Test', release_title: 'test.torrent' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    });

    it('invalidates activity, activityCounts, books, book(id), eventHistory on import_complete', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('import_complete', { download_id: 1, book_id: 7, book_title: 'My Book' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.book(7) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    });

    it('invalidates activity and activityCounts on review_needed', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('review_needed', { download_id: 1, book_id: 2, book_title: 'Test' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity', 'counts'] });
    });

    it('invalidates activity, activityCounts, books, book(id), eventHistory on merge_complete', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('merge_complete', { book_id: 42, book_title: 'My Book', success: true, message: 'done' });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.book(42) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    });
  });

  describe('toast notifications', () => {
    it('shows success toast with book title on import_complete', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('import_complete', { download_id: 1, book_id: 2, book_title: 'My Book' });
      });

      expect(toast.success).toHaveBeenCalledWith('"My Book" imported successfully', { duration: 5000 });
    });

    it('does NOT show toast on grab_started (removed from TOAST_EVENT_CONFIG)', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('grab_started', { download_id: 1, book_id: 2, book_title: 'Grabbed Book', release_title: 'test' });
      });

      expect(toast.info).not.toHaveBeenCalled();
    });

    it('shows warning toast on review_needed', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('review_needed', { download_id: 1, book_id: 2, book_title: 'Review Me' });
      });

      expect(toast.warning).toHaveBeenCalledWith('"Review Me" needs review', { duration: 5000 });
    });

    it('does not show toast for download_progress', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('does not show toast for download_status_change', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('download_status_change', { download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed' });
      });

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('does not show toast for book_status_change', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es!.simulateOpen();
        es!.simulateEvent('book_status_change', { book_id: 2, old_status: 'importing', new_status: 'imported' });
      });

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });
  });

  describe('polling coordination', () => {
    it('sets sseConnected to true when open', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const connectedResult = renderHook(() => useSSEConnected(), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => es!.simulateOpen());
      expect(connectedResult.result.current).toBe(true);
    });

    it('sets sseConnected to false on error and unmount', () => {
      const { wrapper } = createWrapper();
      const { unmount } = renderHook(() => useEventSource('key'), { wrapper });
      const connectedResult = renderHook(() => useSSEConnected(), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => es!.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      act(() => es!.simulateError());
      expect(connectedResult.result.current).toBe(false);

      act(() => es!.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      unmount();
      expect(connectedResult.result.current).toBe(false);
    });

    it('useSSEConnected reactively updates when connection state changes', () => {
      const { wrapper } = createWrapper();

      const eventSourceResult = renderHook(() => useEventSource('key'), { wrapper });
      const connectedResult = renderHook(() => useSSEConnected(), { wrapper });

      expect(connectedResult.result.current).toBe(false);

      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      act(() => es!.simulateError());
      expect(connectedResult.result.current).toBe(false);

      act(() => es!.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      eventSourceResult.unmount();
      expect(connectedResult.result.current).toBe(false);

      connectedResult.unmount();
    });
  });
});

describe('#257 merge observability — useEventSource', () => {
  describe('cache invalidation', () => {
    it('merge_started event triggers eventHistory cache invalidation', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
    });

    it('merge_state event does NOT trigger cache invalidation (per-tick frame)', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5 }], queued: [],
      }));

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('merge_failed event triggers eventHistory + books cache invalidation', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
    });
  });

  describe('toast notifications', () => {
    it('merge_started SSE event shows info toast', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(toast.info).toHaveBeenCalledWith('Merging "My Book"...', { duration: 5000 });
    });

    it('merge_failed SSE event shows error toast via toast.error', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(toast.error).toHaveBeenCalledWith('"My Book" merge failed', { duration: 5000 });
    });

    it('merge_complete SSE event shows success toast using message field', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true,
        message: 'Merged 5 files to My Book.m4b',
      }));

      expect(toast.success).toHaveBeenCalledWith('Merged 5 files to My Book.m4b', { duration: 5000 });
    });
  });

  describe('event listener registration', () => {
    it('registers listeners for the surviving merge events (started, failed, state)', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      for (const type of ['merge_started', 'merge_failed', 'merge_state']) {
        const handlers = (es as unknown as { listeners: Map<string, unknown[]> }).listeners.get(type);
        expect(handlers).toBeDefined();
        expect(handlers!.length).toBeGreaterThan(0);
      }
      // Retired merge events stay absent unless restored to the schema (#2142).
      for (const type of ['merge_progress', 'merge_queued', 'merge_queue_updated']) {
        expect((es as unknown as { listeners: Map<string, unknown[]> }).listeners.get(type)).toBeUndefined();
      }
    });
  });

  describe('merge progress store transitions', () => {
    beforeEach(() => {
      resetMergeStore();
    });
    afterEach(() => {
      setMergeProgress(42, null);
    });

    // `merge_started` must not reintroduce a second non-terminal writer (#2129/#2142).
    it('merge_started does not write the store (AC8)', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(progressResult.current).toBeNull();
    });

    it('merge_state sets phase and percentage in the store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      expect(progressResult.current).toBeNull();

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5 }], queued: [],
      }));

      expect(progressResult.current).toEqual({ phase: 'processing', percentage: 0.5 });
    });

    it('merge_complete surfaces terminal state with outcome to per-book hook during dismiss window', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'starting' }], queued: [],
      }));
      expect(progressResult.current).not.toBeNull();

      act(() => es!.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true, message: 'done',
      }));

      expect(progressResult.current).not.toBeNull();
      expect(progressResult.current).toMatchObject({ phase: 'complete', outcome: 'success' });
    });

    it('merge_failed surfaces terminal state with outcome to per-book hook during dismiss window', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'starting' }], queued: [],
      }));
      expect(progressResult.current).not.toBeNull();

      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(progressResult.current).not.toBeNull();
      expect(progressResult.current).toMatchObject({ phase: 'failed', outcome: 'error' });
    });
  });

  describe('#422 merge activity cards — bookTitle preservation and terminal state', () => {
    afterEach(() => {
      resetMergeStore();
    });

    it('merge_state passes bookTitle and phase into the activity store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'starting' }], queued: [],
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({ bookId: 42, bookTitle: 'My Book', phase: 'starting' });
    });

    it('merge_state preserves bookTitle across a phase/percentage change', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5 }], queued: [],
      }));

      expect(result.current[0]).toMatchObject({ bookTitle: 'My Book', phase: 'processing', percentage: 0.5 });
    });

    it('merge_state passes bookTitle and FIFO position for a queued book', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 7, book_title: 'Runner', phase: 'processing' }],
        queued: [{ book_id: 41, book_title: 'Ahead' }, { book_id: 42, book_title: 'My Book' }],
      }));

      expect(result.current.find((c) => c.bookId === 42)).toMatchObject({ bookTitle: 'My Book', phase: 'queued', position: 2 });
    });

    it('merge_complete sets terminal success state instead of clearing', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'committing' }], queued: [],
      }));
      act(() => es!.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true, message: 'Merged 3 files',
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({
        bookTitle: 'My Book',
        phase: 'complete',
        outcome: 'success',
        message: 'Merged 3 files',
      });
    });

    it('merge_failed sets terminal error state instead of clearing', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing' }], queued: [],
      }));
      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({
        bookTitle: 'My Book',
        phase: 'failed',
        outcome: 'error',
        error: 'ffmpeg crashed',
      });
    });

    it('merge_complete with enrichmentWarning preserves it in activity store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true, message: 'done',
        enrichmentWarning: 'Metadata update failed',
      }));

      expect(result.current[0]!.enrichmentWarning).toBe('Metadata update failed');
    });
  });
});

describe('#312 cache-miss scoping — patchActivityProgress', () => {
  it('does not trigger invalidation when only activityCounts is cached (no queue/history pages)', () => {
    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(['activity', 'counts'], { active: 1, completed: 0 });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  it('still triggers invalidation fallback when queue pages are cached but download is missing', () => {
    const { wrapper, queryClient } = createWrapper();

    const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(queueKey, {
      data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
      total: 1,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  it('patches in-place with no invalidation when download is found in cached queue page (regression guard)', () => {
    const { wrapper, queryClient } = createWrapper();

    const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(queueKey, {
      data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
      total: 1,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.7, speed: null, eta: null });
    });

    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
    expect(cached!.data[0]!.progress).toBe(0.7);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  it('skips activityCounts query gracefully when it coexists with a page query containing the download', () => {
    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(['activity', 'counts'], { active: 1, completed: 0 });
    const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(queueKey, {
      data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
      total: 1,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.6, speed: null, eta: null });
    });

    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
    expect(cached!.data[0]!.progress).toBe(0.6);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });

    const counts = queryClient.getQueryData<{ active: number; completed: number }>(['activity', 'counts']);
    expect(counts).toEqual({ active: 1, completed: 0 });
  });

  it('patches download in page 2 when present there but missing from page 1 — no invalidation', () => {
    const { wrapper, queryClient } = createWrapper();

    const page1Key = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(page1Key, {
      data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
      total: 2,
    });

    const page2Key = ['activity', { section: 'queue', limit: 50, offset: 50 }];
    queryClient.setQueryData(page2Key, {
      data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
      total: 2,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.8, speed: null, eta: null });
    });

    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(page2Key);
    expect(cached!.data[0]!.progress).toBe(0.8);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  describe('#368 merge queue — SSE event handling', () => {
    it('takes the queue position from the snapshot\'s FIFO order (#2129)', () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['auth', 'config'], { apiKey: 'test-key' });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useEventSource('test-key'), { wrapper });

      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es!.simulateOpen();

      act(() => {
        es!.simulateEvent('merge_state', {
          active: [],
          queued: [{ book_id: 7, book_title: 'Ahead' }, { book_id: 42, book_title: 'Test Book' }],
        });
      });

      const { result } = renderHook(() => useMergeProgress(42));
      expect(result.current).toEqual({ phase: 'queued', position: 2 });

      setMergeProgress(42, null);
    });

    it('handles merge_complete with enrichmentWarning by showing warning toast', () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['auth', 'config'], { apiKey: 'test-key' });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useEventSource('test-key'), { wrapper });

      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es!.simulateOpen();

      act(() => {
        es!.simulateEvent('merge_complete', {
          book_id: 42,
          book_title: 'Test Book',
          success: true,
          message: 'Merged 3 files into Test.m4b',
          enrichmentWarning: 'Merge succeeded but metadata update failed',
        });
      });

      expect(toast.warning).toHaveBeenCalledWith('Merge succeeded but metadata update failed');
    });
  });

  describe('#392 search progress event routing', () => {
    it('subscribes to all 5 new search event types', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es!.simulateOpen();

      for (const type of ['search_started', 'search_indexer_complete', 'search_indexer_error', 'search_grabbed', 'search_complete']) {
        expect(es!['listeners'].has(type)).toBe(true);
      }
    });

    it('routes search_started to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es!.simulateOpen();

      const payload = { book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }] };
      es!.simulateEvent('search_started', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_started', payload);
    });

    it('routes search_indexer_complete to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es!.simulateOpen();

      const payload = { book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 3, elapsed_ms: 1200 };
      es!.simulateEvent('search_indexer_complete', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_indexer_complete', payload);
    });

    it('routes search_grabbed to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es!.simulateOpen();

      const payload = { book_id: 1, release_title: 'Best Result', indexer_name: 'MAM' };
      es!.simulateEvent('search_grabbed', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_grabbed', payload);
    });

    it('routes search_complete to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es!.simulateOpen();

      const payload = { book_id: 1, total_results: 0, outcome: 'no_results' };
      es!.simulateEvent('search_complete', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_complete', payload);
    });

    it('search_complete with outcome grab_error dispatches an error toast using book_title as title and error_message in description slot', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('search_complete', {
        book_id: 99,
        total_results: 3,
        outcome: 'grab_error',
        book_title: 'Scheduled Book',
        release_title: 'Release.MP3',
        error_message: 'at wedge reserve floor',
      }));

      expect(toast.error).toHaveBeenCalledWith(
        'Scheduled Book',
        { description: 'at wedge reserve floor', duration: 5000 },
      );
    });

    it('search_complete grab_error falls back to "Unknown grab error" in description when error_message is absent', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('search_complete', {
        book_id: 99,
        total_results: 3,
        outcome: 'grab_error',
        book_title: 'Scheduled Book',
      }));

      expect(toast.error).toHaveBeenCalledWith(
        'Scheduled Book',
        { description: 'Unknown grab error', duration: 5000 },
      );
    });

    it('search_complete grab_error falls back to "Grab failed" title when book_title is absent', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('search_complete', {
        book_id: 99,
        total_results: 3,
        outcome: 'grab_error',
        error_message: 'Connection refused',
      }));

      expect(toast.error).toHaveBeenCalledWith(
        'Grab failed',
        { description: 'Connection refused', duration: 5000 },
      );
    });

    it('search_complete with outcome no_results does NOT dispatch a toast', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('search_complete', {
        book_id: 99, total_results: 0, outcome: 'no_results',
      }));

      expect(toast.error).not.toHaveBeenCalled();
    });

    it('search_complete with outcome grabbed does NOT dispatch a toast', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('search_complete', {
        book_id: 99, total_results: 1, outcome: 'grabbed',
      }));

      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('merge cancellation SSE handling', () => {
    it('merge_failed with reason cancelled sets outcome to cancelled, not error', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing' }], queued: [],
      }));
      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'Cancelled by user', reason: 'cancelled',
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({
        bookTitle: 'My Book',
        phase: 'cancelled',
        outcome: 'cancelled',
      });
    });

    it('merge_failed with reason error continues to set outcome to error', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing' }], queued: [],
      }));
      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed', reason: 'error',
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({
        phase: 'failed',
        outcome: 'error',
        error: 'ffmpeg crashed',
      });
    });

    it('cancelled merge does not show error toast', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'Cancelled by user', reason: 'cancelled',
      }));

      expect(toast.error).not.toHaveBeenCalled();
    });

    it('real merge failure still shows error toast', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed', reason: 'error',
      }));

      expect(toast.error).toHaveBeenCalledWith('"My Book" merge failed', { duration: 5000 });
    });

    it('merge_failed without reason field defaults to error outcome', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'My Book', phase: 'processing' }], queued: [],
      }));
      act(() => es!.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({
        phase: 'failed',
        outcome: 'error',
      });
    });
  });
});

describe('#637 import SSE cache/toast behaviors', () => {
  it('import_progress patches the matching cached job row with _progress and _byteCounter', () => {
    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: 1, bookId: 42, status: 'processing', phase: 'copying' },
      { id: 2, bookId: 43, status: 'pending', phase: 'queued' },
    ]);

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 1, book_id: 42, book_title: 'Test', phase: 'copying', progress: 0.5,
        byte_counter: { current: 5000, total: 10000 },
      });
    });

    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached).toHaveLength(2);
    expect(cached[0]).toMatchObject({ id: 1, _progress: 0.5, _byteCounter: { current: 5000, total: 10000 }, _progressPhase: 'copying' });
    expect(cached[1]).toMatchObject({ id: 2, status: 'pending' });
    expect(cached[1]).not.toHaveProperty('_progress');
    expect(cached[1]).not.toHaveProperty('_progressPhase');
  });

  it('import_progress falls back to invalidateQueries on cache miss', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 99, book_id: 42, book_title: 'Test', phase: 'copying', progress: 0.5,
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
  });

  it('import_failed invalidates importJobs, books, eventHistory and shows error toast', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_failed', {
        job_id: 1, book_id: 42, book_title: 'Failed Book', phase: 'copying', error_message: 'Copy failed',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed Book'), expect.any(Object));
  });

  it('import_phase_change invalidates importJobs', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_phase_change', {
        job_id: 1, book_id: 42, book_title: 'Test', from: 'analyzing', to: 'copying',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
  });

  it('import_complete invalidates importJobs alongside existing caches', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_complete', {
        download_id: 0, book_id: 42, book_title: 'Done Book', job_id: 1, elapsed_ms: 5000,
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
  });
});

describe('#707 nullable book_id in import event payloads', () => {
  it('import_complete with null book_id does not invalidate per-book key but still invalidates books list', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_complete', {
        download_id: null, book_id: null, book_title: 'Done Book', job_id: 1, elapsed_ms: 5000,
      });
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.book(0) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
  });

  it('import_phase_change with null book_id does not throw and still invalidates importJobs', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_phase_change', {
        job_id: 1, book_id: null, book_title: 'Test', from: 'analyzing', to: 'copying',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
  });

  it('import_progress patches the matching job by job_id even when book_id is null', () => {
    const { wrapper, queryClient } = createWrapper();

    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: 1, bookId: null, status: 'processing', phase: 'copying' },
    ]);

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 1, book_id: null, book_title: 'Test', phase: 'copying', progress: 0.5,
      });
    });

    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached[0]).toMatchObject({ id: 1, _progress: 0.5, _progressPhase: 'copying' });
  });

  it('import_failed with null book_id does not throw and still shows error toast + invalidations', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_failed', {
        job_id: 1, book_id: null, book_title: 'Failed Book', phase: 'copying', error_message: 'fail',
      });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed Book'), expect.any(Object));
  });
});

describe('#514 useEventSource type safety', () => {
  it('event type list is derived from sseEventTypeSchema.options (single source of truth)', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });

    const es = MockEventSource.instances[0];
    const registeredTypes = [...(es as unknown as { listeners: Map<string, unknown[]> }).listeners.keys()];
    const schemaOptions = [...sseEventTypeSchema.options];

    // Heartbeat is deliberately outside the domain-event schema (#1798).
    const domainTypes = registeredTypes.filter((t) => t !== 'hb');
    expect(domainTypes.sort()).toEqual(schemaOptions.sort());
    expect(registeredTypes).toContain('hb');
  });
});

describe('#706 CACHE_INVALIDATION_MATRIX runtime semantics', () => {
  // Keep this fixture independent of the matrix so a flipped rule fails equality and behavior.
  const EXPECTED_RULES: Record<SSEEventType, CacheInvalidationRule> = {
    download_progress: { activity: 'patch' },
    download_status_change: { activity: 'invalidate', activityCounts: 'invalidate' },
    book_status_change: { books: 'invalidate' },
    grab_started: { activity: 'invalidate', activityCounts: 'invalidate', eventHistory: 'invalidate' },
    import_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate', importJobs: 'invalidate' },
    import_phase_change: { importJobs: 'invalidate' },
    import_progress: { importJobs: 'patch' },
    import_failed: { importJobs: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
    review_needed: { activity: 'invalidate', activityCounts: 'invalidate' },
    merge_complete: { activity: 'invalidate', activityCounts: 'invalidate', books: 'invalidate', eventHistory: 'invalidate' },
    merge_started: { eventHistory: 'invalidate' },
    merge_failed: { eventHistory: 'invalidate', books: 'invalidate' },
    merge_state: {},
    search_started: {},
    search_indexer_complete: {},
    search_indexer_error: {},
    search_grabbed: {},
    search_complete: { eventHistory: 'invalidate' },
  };

  const PAYLOADS: Record<SSEEventType, Record<string, unknown>> = {
    download_progress: { download_id: 7, book_id: 42, percentage: 0.5, speed: 1024, eta: 30 },
    download_status_change: { download_id: 7, book_id: 42, old_status: 'downloading', new_status: 'completed' },
    book_status_change: { book_id: 42, old_status: 'wanted', new_status: 'imported' },
    grab_started: { download_id: 7, book_id: 42, book_title: 'Test', release_title: 'Release' },
    import_complete: { download_id: 7, book_id: 42, book_title: 'Test', job_id: 1, elapsed_ms: 1000 },
    import_phase_change: { job_id: 1, book_id: 42, book_title: 'Test', from: 'analyzing', to: 'copying' },
    import_progress: { job_id: 1, book_id: 42, book_title: 'Test', phase: 'copying', progress: 0.5, byte_counter: { current: 1, total: 2 } },
    import_failed: { job_id: 1, book_id: 42, book_title: 'Test', phase: 'copying', error_message: 'fail' },
    review_needed: { download_id: 7, book_id: 42, book_title: 'Test' },
    merge_complete: { book_id: 42, book_title: 'Test', success: true, message: 'msg' },
    merge_started: { book_id: 42, book_title: 'Test' },
    merge_failed: { book_id: 42, book_title: 'Test', error: 'err', reason: 'error' },
    merge_state: { active: [], queued: [] },
    search_started: { book_id: 42, book_title: 'Test', indexers: [] },
    search_indexer_complete: { book_id: 42, indexer_id: 1, indexer_name: 'X', results_found: 0, elapsed_ms: 1 },
    search_indexer_error: { book_id: 42, indexer_id: 1, indexer_name: 'X', error: 'e', elapsed_ms: 1 },
    search_grabbed: { book_id: 42, release_title: 'r', indexer_name: 'X' },
    search_complete: { book_id: 42, total_results: 0, outcome: 'no_results' },
  };

  it('CACHE_INVALIDATION_MATRIX deep-equals the independent EXPECTED_RULES fixture', () => {
    expect(CACHE_INVALIDATION_MATRIX).toEqual(EXPECTED_RULES);
  });

  it('CACHE_INVALIDATION_MATRIX keys cover every sseEventTypeSchema option', () => {
    expect(Object.keys(CACHE_INVALIDATION_MATRIX).sort()).toEqual([...sseEventTypeSchema.options].sort());
  });

  function assertActivityPatch(type: SSEEventType, payload: Record<string, unknown>) {
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(queryKeys.activity(), {
      data: [{ id: payload.download_id, progress: 0, downloadSpeed: null }],
      total: 1,
    });
    renderHook(() => useEventSource('key'), { wrapper });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const es = MockEventSource.instances[0];
    act(() => {
      es!.simulateOpen();
      es!.simulateEvent(type, payload);
    });
    const cached = queryClient.getQueryData(queryKeys.activity()) as { data: Record<string, unknown>[]; total: number };
    expect(cached.data[0]).toMatchObject({
      id: payload.download_id,
      progress: payload.percentage,
      downloadSpeed: payload.speed,
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  }

  function assertImportJobsPatch(type: SSEEventType, payload: Record<string, unknown>) {
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: payload.job_id, bookId: payload.book_id, status: 'processing', phase: 'queued' },
    ]);
    renderHook(() => useEventSource('key'), { wrapper });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const es = MockEventSource.instances[0];
    act(() => {
      es!.simulateOpen();
      es!.simulateEvent(type, payload);
    });
    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached[0]).toMatchObject({
      id: payload.job_id,
      _progress: payload.progress,
      _byteCounter: payload.byte_counter,
      _progressPhase: payload.phase,
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['importJobs'] });
  }

  function assertNoOp(type: SSEEventType, payload: Record<string, unknown>) {
    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const setSpy = vi.spyOn(queryClient, 'setQueryData');
    const es = MockEventSource.instances[0];
    act(() => {
      es!.simulateOpen();
      es!.simulateEvent(type, payload);
    });
    const trackedKeys: readonly (readonly unknown[])[] = [
      ['activity'],
      queryKeys.activityCounts(),
      ['books'],
      queryKeys.eventHistory.root(),
      ['importJobs'],
    ];
    for (const key of trackedKeys) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: key });
      expect(setSpy).not.toHaveBeenCalledWith(key, expect.anything());
    }
  }

  function assertInvalidate(type: SSEEventType, payload: Record<string, unknown>, rule: CacheInvalidationRule) {
    const { wrapper, queryClient } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const es = MockEventSource.instances[0];
    act(() => {
      es!.simulateOpen();
      es!.simulateEvent(type, payload);
    });

    if (rule.activity === 'invalidate') {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    }
    if (rule.activityCounts) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    }
    if (rule.books) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      if (typeof payload.book_id === 'number') {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.book(payload.book_id) });
      }
    }
    if (rule.eventHistory) {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    }
    if (rule.importJobs === 'invalidate') {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['importJobs'] });
    }

    if (!rule.activity) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    }
    if (!rule.activityCounts) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    }
    if (!rule.books) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['books'] });
      if (typeof payload.book_id === 'number') {
        expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.book(payload.book_id) });
      }
    }
    if (!rule.eventHistory) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    }
    if (!rule.importJobs) {
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['importJobs'] });
    }
  }

  it.each(Object.keys(EXPECTED_RULES) as SSEEventType[])(
    'matrix runtime semantics: %s',
    (type) => {
      const rule = EXPECTED_RULES[type];
      const payload = PAYLOADS[type];

      if (rule.activity === 'patch') {
        assertActivityPatch(type, payload);
        return;
      }
      if (rule.importJobs === 'patch') {
        assertImportJobsPatch(type, payload);
        return;
      }
      if (Object.keys(rule).length === 0) {
        assertNoOp(type, payload);
        return;
      }
      assertInvalidate(type, payload, rule);
    },
  );

  // Harness behavior only: matrix completeness is asserted separately because unknown events
  // have no registered listener and are silent here.
  it('MockEventSource.simulateEvent for an unregistered type reaches no listener', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];
    expect(() => es!.simulateEvent('not_in_matrix', {})).not.toThrow();
    const registered = [...(es as unknown as { listeners: Map<string, unknown[]> }).listeners.keys()];
    expect(registered).not.toContain('not_in_matrix');
  });
});

describe('#722 SSE schema validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('drops malformed JSON without crashing the hook or invoking the consumer', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateRawEvent('merge_complete', 'not-json');
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE merge_complete: invalid JSON'),
      expect.any(Error),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
  });

  it('continues to process subsequent valid events after a malformed-JSON event', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateRawEvent('merge_complete', '{not valid json');
      es!.simulateEvent('merge_complete', { book_id: 1, book_title: 'Book', success: true, message: 'ok' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
  });

  it('rejects import_progress with malformed byte_counter (missing required current field)', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: 1, bookId: 42, status: 'processing', phase: 'copying' },
    ]);

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 1,
        book_id: 42,
        book_title: 'Test',
        phase: 'copying',
        progress: 0.5,
        byte_counter: { total: 123 },
      });
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE import_progress: schema validation failed'),
      expect.any(Object),
    );
    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached[0]).not.toHaveProperty('_progress');
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['importJobs'] });
  });

  it('rejects merge_complete missing required message field', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('merge_complete', { book_id: 42, book_title: 'My Book', success: true });
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE merge_complete: schema validation failed'),
      expect.any(Object),
    );
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.books() });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('rejects download_progress with wrong type for percentage (string instead of number)', () => {
    const { wrapper, queryClient } = createWrapper();
    const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(queueKey, {
      data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
      total: 1,
    });

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: '0.5', speed: null, eta: null });
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE download_progress: schema validation failed'),
      expect.any(Object),
    );
    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[] }>(queueKey);
    expect(cached!.data[0]!.progress).toBe(0.1);
  });

  it('accepts import_progress with book_id: null (nullable per schema)', () => {
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: 1, bookId: null, status: 'processing', phase: 'copying' },
    ]);

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 1,
        book_id: null,
        book_title: 'Test',
        phase: 'copying',
        progress: 0.5,
      });
    });

    expect(warnSpy).not.toHaveBeenCalled();
    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached[0]).toMatchObject({ id: 1, _progress: 0.5, _progressPhase: 'copying' });
  });

  it('processes a fully-valid import_progress event end-to-end (happy path)', () => {
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(queryKeys.importJobs(), [
      { id: 1, bookId: 42, status: 'processing', phase: 'copying' },
    ]);

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es!.simulateOpen();
      es!.simulateEvent('import_progress', {
        job_id: 1,
        book_id: 42,
        book_title: 'Test',
        phase: 'copying',
        progress: 0.75,
        byte_counter: { current: 7500, total: 10000 },
      });
    });

    expect(warnSpy).not.toHaveBeenCalled();
    const cached = queryClient.getQueryData(queryKeys.importJobs()) as Record<string, unknown>[];
    expect(cached[0]).toMatchObject({
      id: 1,
      _progress: 0.75,
      _byteCounter: { current: 7500, total: 10000 },
      _progressPhase: 'copying',
    });
  });
});

describe('#722 SSE_PARSERS registry completeness', () => {
  it('SSE_PARSERS keys cover every sseEventTypeSchema option (compile-time enforced via SSEParserMap)', async () => {
    const { SSE_PARSERS } = await import('@/lib/sse/safe-parse-event');
    expect(Object.keys(SSE_PARSERS).sort()).toEqual([...sseEventTypeSchema.options].sort());
  });
});

// Fake only intervals and Date for watchdog tests; faking setTimeout deadlocks TanStack Query.
// Half-open streams remain OPEN without errors, so silence must enter normal recovery (#1798).
describe('#1798 SSE liveness watchdog', () => {
  const THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const arglessInvalidations = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter((c: unknown[]) => c.length === 0);

  it('does not churn a healthy stream — a frame each interval keeps liveness fresh (AC #2)', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0]!;
    act(() => es.simulateOpen());

    for (let i = 0; i < 5; i++) {
      act(() => {
        es.simulateEvent('hb', {});
        vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      });
    }

    expect(MockEventSource.instances).toHaveLength(1);
    expect(es.readyState).not.toBe(2);
    expect(arglessInvalidations(invalidateSpy)).toHaveLength(0);
  });

  it('closes and reopens a silent stream, firing the catch-up exactly once on reopen (AC #1)', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useEventSource('key'), { wrapper });
    const es1 = MockEventSource.instances[0]!;
    act(() => es1.simulateOpen());
    expect(arglessInvalidations(invalidateSpy)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 4));

    expect(es1.readyState).toBe(2);
    expect(MockEventSource.instances).toHaveLength(2);

    const es2 = MockEventSource.instances[1]!;
    expect(arglessInvalidations(invalidateSpy)).toHaveLength(0);
    act(() => es2.simulateOpen());
    expect(arglessInvalidations(invalidateSpy)).toHaveLength(1);
  });

  it('flips sseConnected false during the outage window, back true after reopen (AC #4)', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const connected = renderHook(() => useSSEConnected(), { wrapper });
    const es1 = MockEventSource.instances[0]!;

    act(() => es1.simulateOpen());
    expect(connected.result.current).toBe(true);

    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 4));
    expect(connected.result.current).toBe(false);

    const es2 = MockEventSource.instances[1]!;
    act(() => es2.simulateOpen());
    expect(connected.result.current).toBe(true);
  });

  it('a named `hb` event refreshes liveness — resetting it prevents the watchdog firing (AC #2)', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0]!;
    act(() => es.simulateOpen());

    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2));
    act(() => es.simulateEvent('hb', {}));
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(es.readyState).not.toBe(2);
  });

  it('a domain SSE event refreshes liveness just like a heartbeat (AC #2)', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0]!;
    act(() => es.simulateOpen());

    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2));
    act(() => es.simulateEvent('download_status_change', {
      download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed',
    }));
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2));

    expect(MockEventSource.instances).toHaveLength(1);
    expect(es.readyState).not.toBe(2);
  });

  it('reopens a stale stream on a window "online" event before the next watchdog tick', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es1 = MockEventSource.instances[0]!;
    act(() => es1.simulateOpen());

    // Cross just after the 60s tick; strict `>` keeps the watchdog from reconnecting until 80s.
    act(() => vi.advanceTimersByTime(THRESHOLD_MS + 1));
    expect(MockEventSource.instances).toHaveLength(1);

    act(() => window.dispatchEvent(new Event('online')));
    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('reopens a stale stream on visibilitychange when the document is visible', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es1 = MockEventSource.instances[0]!;
    act(() => es1.simulateOpen());

    act(() => vi.advanceTimersByTime(THRESHOLD_MS + 1));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(MockEventSource.instances).toHaveLength(2);
  });

  it('does not reconnect a stale stream on visibilitychange while the tab is hidden', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es1 = MockEventSource.instances[0]!;
      act(() => es1.simulateOpen());

      act(() => vi.advanceTimersByTime(THRESHOLD_MS + 1));
      expect(MockEventSource.instances).toHaveLength(1);

      act(() => document.dispatchEvent(new Event('visibilitychange')));
      expect(MockEventSource.instances).toHaveLength(1);
      expect(es1.readyState).not.toBe(2);
    } finally {
      // Restore jsdom's prototype getter after the own-property override.
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });

  it('does not churn a healthy stream on "online"/"visibilitychange"', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const es1 = MockEventSource.instances[0]!;
    act(() => es1.simulateOpen());

    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(es1.readyState).not.toBe(2);
  });

  it('tears down the watchdog + online/visibility listeners on unmount (no leak) (AC #6)', () => {
    const winRemove = vi.spyOn(window, 'removeEventListener');
    const docRemove = vi.spyOn(document, 'removeEventListener');
    const { wrapper } = createWrapper();
    const { unmount } = renderHook(() => useEventSource('key'), { wrapper });
    act(() => MockEventSource.instances[0]!.simulateOpen());

    unmount();

    expect(winRemove).toHaveBeenCalledWith('online', expect.any(Function));
    expect(docRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    // A leaked watchdog would reopen the closed stream after this advance.
    act(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5));
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

describe('#2129 merge_state — snapshot handling in useEventSource', () => {
  beforeEach(() => { resetMergeStore(); });
  afterEach(() => { resetMergeStore(); });

  it('updates the store without invalidating any query or raising a toast', () => {
    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    renderHook(() => useEventSource('key'), { wrapper });
    const { result } = renderHook(() => useMergeActivityCards());
    const es = MockEventSource.instances[0];
    act(() => es!.simulateOpen());
    invalidateSpy.mockClear();

    act(() => es!.simulateEvent('merge_state', {
      active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing', percentage: 0.35 }],
      queued: [{ book_id: 43, book_title: 'The Shining' }],
    }));

    expect(result.current).toEqual([
      { bookId: 42, bookTitle: 'Dogs of War', phase: 'processing', percentage: 0.35 },
      { bookId: 43, bookTitle: 'The Shining', phase: 'queued', position: 1 },
    ]);
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('drops a malformed payload and leaves the store untouched', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });
    const { result } = renderHook(() => useMergeActivityCards());
    const es = MockEventSource.instances[0];
    act(() => es!.simulateOpen());

    act(() => es!.simulateEvent('merge_state', {
      active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'staging' }], queued: [],
    }));
    expect(result.current).toHaveLength(1);

    // A terminal phase in `active` is off-contract and must not clear the last valid chip.
    act(() => es!.simulateEvent('merge_state', { active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'complete' }], queued: [] }));
    act(() => es!.simulateEvent('merge_state', { active: [{ book_id: 42 }], queued: [] }));
    act(() => es!.simulateEvent('merge_state', 'not-an-object'));

    expect(result.current).toEqual([{ bookId: 42, bookTitle: 'Dogs of War', phase: 'staging' }]);
  });

  it('keeps a terminal card through the snapshot that clears it, then removes it on the timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es!.simulateOpen());

      act(() => es!.simulateEvent('merge_state', {
        active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'committing' }], queued: [],
      }));
      // Production sends the terminal event before the snapshot that excludes the book.
      act(() => es!.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'Dogs of War', success: true, message: 'Merged 3 files',
      }));
      act(() => es!.simulateEvent('merge_state', { active: [], queued: [] }));

      expect(result.current[0]).toMatchObject({ phase: 'complete', outcome: 'success', message: 'Merged 3 files' });

      act(() => { vi.advanceTimersByTime(3000); });
      expect(result.current).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
