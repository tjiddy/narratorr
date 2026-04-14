import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useEventSource, useSSEConnected } from './useEventSource';
import { useMergeProgress, useMergeActivityCards, setMergeProgress, _resetForTesting as resetMergeStore } from './useMergeProgress';
import { handleSearchEvent } from './useSearchProgress';
import { queryKeys } from '@/lib/queryKeys';
import { sseEventTypeSchema } from '../../shared/schemas.js';

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

// Mock EventSource
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

  // Test helpers
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
}

// Install mock
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
    it('connects to /api/events with apikey query param', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });

      expect(MockEventSource.instances).toHaveLength(1);
      expect(MockEventSource.instances[0].url).toBe('/api/events?apikey=test-api-key');
    });

    it('does not connect when apiKey is null', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource(null), { wrapper });

      expect(MockEventSource.instances).toHaveLength(0);
    });

    it('cleans up EventSource on unmount', () => {
      const { wrapper } = createWrapper();
      const { unmount } = renderHook(() => useEventSource('key'), { wrapper });

      const es = MockEventSource.instances[0];
      unmount();

      expect(es.readyState).toBe(2); // CLOSED
    });

    it('invalidates all query keys on reconnect', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      // Simulate error then reconnect
      act(() => {
        es.simulateError();
        es.simulateOpen();
      });

      expect(invalidateSpy).toHaveBeenCalledWith();
    });
  });

  describe('cache invalidation per event type', () => {
    it('patches activity row in-place on download_progress across cached pages', () => {
      const { wrapper, queryClient } = createWrapper();

      // Seed a cached activity page (paginated format)
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
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      // Verify the data was patched correctly in the cached page
      const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
      expect(cached!.data).toHaveLength(2);
      expect(cached!.data[0].progress).toBe(0.5);  // patched
      expect(cached!.data[1].progress).toBe(0.9);  // untouched
    });

    it('does not invalidate activity queries on download_progress when download is in cache', () => {
      const { wrapper, queryClient } = createWrapper();

      // Seed cache with the download present
      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    });

    it('falls back to invalidation when download_progress arrives for a download not in any cached page', () => {
      const { wrapper, queryClient } = createWrapper();

      // Seed cache with a DIFFERENT download — download_id 99 is not in the cache
      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
      });

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    });

    it('does not invalidate when activity cache is completely empty (no pages loaded to miss from)', () => {
      const { wrapper, queryClient } = createWrapper();
      // No activity data seeded — cache is empty, no page queries exist
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
      });

      // #312: No page queries cached — can't "miss" from a page that isn't loaded
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    });

    it('does not invalidate when download_progress patches an existing download successfully', () => {
      const { wrapper, queryClient } = createWrapper();

      // Seed cache with the exact download that will receive the progress event
      const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
      queryClient.setQueryData(queueKey, {
        data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
        total: 1,
      });

      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      // Should NOT invalidate — patched in-place instead
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
    });

    it('invalidates activity and activityCounts on download_status_change', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_status_change', { download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed' });
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
        es.simulateOpen();
        es.simulateEvent('book_status_change', { book_id: 42, old_status: 'importing', new_status: 'imported' });
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
        es.simulateOpen();
        es.simulateEvent('grab_started', { download_id: 1, book_id: 2, book_title: 'Test', release_title: 'test.torrent' });
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
        es.simulateOpen();
        es.simulateEvent('import_complete', { download_id: 1, book_id: 7, book_title: 'My Book' });
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
        es.simulateOpen();
        es.simulateEvent('review_needed', { download_id: 1, book_id: 2, book_title: 'Test' });
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
        es.simulateOpen();
        es.simulateEvent('merge_complete', { book_id: 42, book_title: 'My Book', success: true });
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
        es.simulateOpen();
        es.simulateEvent('import_complete', { download_id: 1, book_id: 2, book_title: 'My Book' });
      });

      expect(toast.success).toHaveBeenCalledWith('"My Book" imported successfully', { duration: 5000 });
    });

    it('does NOT show toast on grab_started (removed from TOAST_EVENT_CONFIG)', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('grab_started', { download_id: 1, book_id: 2, book_title: 'Grabbed Book', release_title: 'test' });
      });

      expect(toast.info).not.toHaveBeenCalled();
    });

    it('shows warning toast on review_needed', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('review_needed', { download_id: 1, book_id: 2, book_title: 'Review Me' });
      });

      expect(toast.warning).toHaveBeenCalledWith('"Review Me" needs review', { duration: 5000 });
    });

    it('does not show toast for download_progress', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
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
        es.simulateOpen();
        es.simulateEvent('download_status_change', { download_id: 1, book_id: 2, old_status: 'downloading', new_status: 'completed' });
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
        es.simulateOpen();
        es.simulateEvent('book_status_change', { book_id: 2, old_status: 'importing', new_status: 'imported' });
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

      act(() => es.simulateOpen());
      expect(connectedResult.result.current).toBe(true);
    });

    it('sets sseConnected to false on error and unmount', () => {
      const { wrapper } = createWrapper();
      const { unmount } = renderHook(() => useEventSource('key'), { wrapper });
      const connectedResult = renderHook(() => useSSEConnected(), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => es.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      act(() => es.simulateError());
      expect(connectedResult.result.current).toBe(false);

      // Re-open then unmount
      act(() => es.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      unmount();
      expect(connectedResult.result.current).toBe(false);
    });

    it('useSSEConnected reactively updates when connection state changes', () => {
      const { wrapper } = createWrapper();

      // Render both hooks in the same wrapper
      const eventSourceResult = renderHook(() => useEventSource('key'), { wrapper });
      const connectedResult = renderHook(() => useSSEConnected(), { wrapper });

      expect(connectedResult.result.current).toBe(false);

      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      act(() => es.simulateError());
      expect(connectedResult.result.current).toBe(false);

      act(() => es.simulateOpen());
      expect(connectedResult.result.current).toBe(true);

      eventSourceResult.unmount();
      expect(connectedResult.result.current).toBe(false);

      connectedResult.unmount();
    });
  });
});

// ============================================================================
// #257 — Merge observability: SSE handler cache/toast integration
// ============================================================================

describe('#257 merge observability — useEventSource', () => {
  describe('cache invalidation', () => {
    it('merge_started event triggers eventHistory cache invalidation', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
    });

    it('merge_progress event does NOT trigger full cache invalidation', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_progress', {
        book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5,
      }));

      // merge_progress has empty invalidation rule — no invalidation calls
      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('merge_failed event triggers eventHistory + books cache invalidation', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_failed', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(toast.info).toHaveBeenCalledWith('Merging "My Book"...', { duration: 5000 });
    });

    it('merge_failed SSE event shows error toast via toast.error', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed',
      }));

      expect(toast.error).toHaveBeenCalledWith('"My Book" merge failed', { duration: 5000 });
    });

    it('merge_complete SSE event shows success toast using message field', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true,
        message: 'Merged 5 files to My Book.m4b',
      }));

      expect(toast.success).toHaveBeenCalledWith('Merged 5 files to My Book.m4b', { duration: 5000 });
    });
  });

  describe('event listener registration', () => {
    it('registers listeners for merge_started, merge_progress, merge_failed', () => {
      const { wrapper } = createWrapper();

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      // Check that all 3 new event types have listeners registered
      for (const type of ['merge_started', 'merge_progress', 'merge_failed']) {
        const handlers = (es as unknown as { listeners: Map<string, unknown[]> }).listeners.get(type);
        expect(handlers).toBeDefined();
        expect(handlers!.length).toBeGreaterThan(0);
      }
    });
  });

  describe('merge progress store transitions', () => {
    beforeEach(() => {
      resetMergeStore();
    });
    afterEach(() => {
      // Clean up store state between tests
      setMergeProgress(42, null);
    });

    it('merge_started sets progress to { phase: starting }', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      expect(progressResult.current).toBeNull();

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(progressResult.current).toEqual({ phase: 'starting' });
    });

    it('merge_progress updates phase and percentage in store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_progress', {
        book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5,
      }));

      expect(progressResult.current).toEqual({ phase: 'processing', percentage: 0.5 });
    });

    it('merge_complete surfaces terminal state with outcome to per-book hook during dismiss window', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result: progressResult } = renderHook(() => useMergeProgress(42));
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      expect(progressResult.current).not.toBeNull();

      act(() => es.simulateEvent('merge_complete', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      expect(progressResult.current).not.toBeNull();

      act(() => es.simulateEvent('merge_failed', {
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

    it('merge_started passes bookTitle into activity store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));

      expect(result.current).toHaveLength(1);
      expect(result.current[0]).toMatchObject({ bookId: 42, bookTitle: 'My Book', phase: 'starting' });
    });

    it('merge_progress preserves bookTitle in activity store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_progress', {
        book_id: 42, book_title: 'My Book', phase: 'processing', percentage: 0.5,
      }));

      expect(result.current[0]).toMatchObject({ bookTitle: 'My Book', phase: 'processing', percentage: 0.5 });
    });

    it('merge_queued passes bookTitle and position into activity store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_queued', { book_id: 42, book_title: 'My Book', position: 2 }));

      expect(result.current[0]).toMatchObject({ bookTitle: 'My Book', phase: 'queued', position: 2 });
    });

    it('merge_complete sets terminal success state instead of clearing', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      act(() => es.simulateEvent('merge_complete', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      act(() => es.simulateEvent('merge_failed', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_complete', {
        book_id: 42, book_title: 'My Book', success: true, message: 'done',
        enrichmentWarning: 'Metadata update failed',
      }));

      expect(result.current[0].enrichmentWarning).toBe('Metadata update failed');
    });
  });
});

// ============================================================================
// #312 — Cache-miss scoping: exclude activityCounts from patchActivityProgress
// ============================================================================

describe('#312 cache-miss scoping — patchActivityProgress', () => {
  it('does not trigger invalidation when only activityCounts is cached (no queue/history pages)', () => {
    const { wrapper, queryClient } = createWrapper();

    // Seed ONLY activityCounts — no queue/history page queries
    queryClient.setQueryData(['activity', 'counts'], { active: 1, completed: 0 });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateOpen();
      es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
    });

    // No queue/history pages loaded — should NOT fall back to invalidation
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  it('still triggers invalidation fallback when queue pages are cached but download is missing', () => {
    const { wrapper, queryClient } = createWrapper();

    // Seed a queue page that does NOT contain download_id=1
    const queueKey = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(queueKey, {
      data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
      total: 1,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateOpen();
      es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.3, speed: null, eta: null });
    });

    // Queue page IS cached but download is missing — invalidation fallback MUST fire
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
      es.simulateOpen();
      es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.7, speed: null, eta: null });
    });

    // Download found in cache — should patch in-place, no invalidation
    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
    expect(cached!.data[0].progress).toBe(0.7);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  it('skips activityCounts query gracefully when it coexists with a page query containing the download', () => {
    const { wrapper, queryClient } = createWrapper();

    // Seed both activityCounts and a page query with the target download
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
      es.simulateOpen();
      es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.6, speed: null, eta: null });
    });

    // Should patch page query, skip counts query, no invalidation
    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(queueKey);
    expect(cached!.data[0].progress).toBe(0.6);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });

    // Counts query should be untouched
    const counts = queryClient.getQueryData<{ active: number; completed: number }>(['activity', 'counts']);
    expect(counts).toEqual({ active: 1, completed: 0 });
  });

  it('patches download in page 2 when present there but missing from page 1 — no invalidation', () => {
    const { wrapper, queryClient } = createWrapper();

    // Page 1 does NOT have the target download
    const page1Key = ['activity', { section: 'queue', limit: 50, offset: 0 }];
    queryClient.setQueryData(page1Key, {
      data: [{ id: 99, bookId: 10, title: 'Other Book', progress: 0.5, status: 'downloading' }],
      total: 2,
    });

    // Page 2 HAS the target download
    const page2Key = ['activity', { section: 'queue', limit: 50, offset: 50 }];
    queryClient.setQueryData(page2Key, {
      data: [{ id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' }],
      total: 2,
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useEventSource('key'), { wrapper });
    const es = MockEventSource.instances[0];

    act(() => {
      es.simulateOpen();
      es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.8, speed: null, eta: null });
    });

    // Found in page 2 — patched, no invalidation
    const cached = queryClient.getQueryData<{ data: { id: number; progress: number }[]; total: number }>(page2Key);
    expect(cached!.data[0].progress).toBe(0.8);
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: queryKeys.activityCounts() });
  });

  describe('#368 merge queue — SSE event handling', () => {
    it('handles merge_queued event by calling setMergeProgress with queued phase and position', () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['auth', 'config'], { apiKey: 'test-key' });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useEventSource('test-key'), { wrapper });

      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateOpen();

      act(() => {
        es.simulateEvent('merge_queued', { book_id: 42, book_title: 'Test Book', position: 2 });
      });

      const { result } = renderHook(() => useMergeProgress(42));
      expect(result.current).toEqual({ phase: 'queued', position: 2 });

      // Clean up
      setMergeProgress(42, null);
    });

    it('handles merge_queue_updated event by updating position', () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['auth', 'config'], { apiKey: 'test-key' });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useEventSource('test-key'), { wrapper });

      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateOpen();

      act(() => {
        es.simulateEvent('merge_queued', { book_id: 42, book_title: 'Test Book', position: 3 });
      });

      act(() => {
        es.simulateEvent('merge_queue_updated', { book_id: 42, book_title: 'Test Book', position: 1 });
      });

      const { result } = renderHook(() => useMergeProgress(42));
      expect(result.current).toEqual({ phase: 'queued', position: 1 });

      setMergeProgress(42, null);
    });

    it('handles merge_complete with enrichmentWarning by showing warning toast', () => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['auth', 'config'], { apiKey: 'test-key' });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      renderHook(() => useEventSource('test-key'), { wrapper });

      const es = MockEventSource.instances[MockEventSource.instances.length - 1];
      es.simulateOpen();

      act(() => {
        es.simulateEvent('merge_complete', {
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

  // ============================================================================
  // #392 — Search progress event routing
  // ============================================================================

  describe('#392 search progress event routing', () => {
    it('subscribes to all 5 new search event types', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es.simulateOpen();

      for (const type of ['search_started', 'search_indexer_complete', 'search_indexer_error', 'search_grabbed', 'search_complete']) {
        expect(es['listeners'].has(type)).toBe(true);
      }
    });

    it('routes search_started to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es.simulateOpen();

      const payload = { book_id: 1, book_title: 'Test', indexers: [{ id: 10, name: 'MAM' }] };
      es.simulateEvent('search_started', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_started', payload);
    });

    it('routes search_indexer_complete to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es.simulateOpen();

      const payload = { book_id: 1, indexer_id: 10, indexer_name: 'MAM', results_found: 3, elapsed_ms: 1200 };
      es.simulateEvent('search_indexer_complete', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_indexer_complete', payload);
    });

    it('routes search_grabbed to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es.simulateOpen();

      const payload = { book_id: 1, release_title: 'Best Result', indexer_name: 'MAM' };
      es.simulateEvent('search_grabbed', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_grabbed', payload);
    });

    it('routes search_complete to search-progress store', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('test-api-key'), { wrapper });
      const es = MockEventSource.instances[0];
      es.simulateOpen();

      const payload = { book_id: 1, total_results: 0, outcome: 'no_results' };
      es.simulateEvent('search_complete', payload);

      expect(handleSearchEvent).toHaveBeenCalledWith('search_complete', payload);
    });
  });

  describe('merge cancellation SSE handling', () => {
    it('merge_failed with reason cancelled sets outcome to cancelled, not error', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      act(() => es.simulateEvent('merge_failed', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      act(() => es.simulateEvent('merge_failed', {
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
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'Cancelled by user', reason: 'cancelled',
      }));

      expect(toast.error).not.toHaveBeenCalled();
    });

    it('real merge failure still shows error toast', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_failed', {
        book_id: 42, book_title: 'My Book', error: 'ffmpeg crashed', reason: 'error',
      }));

      expect(toast.error).toHaveBeenCalledWith('"My Book" merge failed', { duration: 5000 });
    });

    it('merge_failed without reason field defaults to error outcome', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const { result } = renderHook(() => useMergeActivityCards());
      const es = MockEventSource.instances[0];
      act(() => es.simulateOpen());

      act(() => es.simulateEvent('merge_started', { book_id: 42, book_title: 'My Book' }));
      act(() => es.simulateEvent('merge_failed', {
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

describe('#514 useEventSource type safety', () => {
  it('event type list is derived from sseEventTypeSchema.options (single source of truth)', () => {
    const { wrapper } = createWrapper();
    renderHook(() => useEventSource('key'), { wrapper });

    const es = MockEventSource.instances[0];
    const registeredTypes = [...(es as unknown as { listeners: Map<string, unknown[]> }).listeners.keys()];
    const schemaOptions = [...sseEventTypeSchema.options];

    expect(registeredTypes.sort()).toEqual(schemaOptions.sort());
  });
});
