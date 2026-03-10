import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useEventSource, isSSEConnected, useSSEConnected } from './useEventSource';

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
    it('patches activity row in-place on download_progress', () => {
      const { wrapper, queryClient } = createWrapper();
      const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

      // Seed existing activity data
      queryClient.setQueryData(['activity'], [
        { id: 1, bookId: 2, title: 'Book', progress: 0.1, status: 'downloading' },
        { id: 3, bookId: 4, title: 'Other', progress: 0.9, status: 'downloading' },
      ]);

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      // Should call setQueryData with the activity key and an updater function
      expect(setQueryDataSpy).toHaveBeenCalledWith(['activity'], expect.any(Function));

      // Verify the data was patched correctly
      const data = queryClient.getQueryData<{ id: number; progress: number }[]>(['activity']);
      expect(data).toHaveLength(2);
      expect(data![0].progress).toBe(0.5);  // patched
      expect(data![1].progress).toBe(0.9);  // untouched
    });

    it('does not invalidate activity queries on download_progress', () => {
      const { wrapper, queryClient } = createWrapper();
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.5, speed: null, eta: null });
      });

      expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['activity'] });
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

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity', 'counts'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
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

      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity', 'counts'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books', 7] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['eventHistory'] });
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

    it('shows info toast on grab_started', () => {
      const { wrapper } = createWrapper();
      renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => {
        es.simulateOpen();
        es.simulateEvent('grab_started', { download_id: 1, book_id: 2, book_title: 'Grabbed Book', release_title: 'test' });
      });

      expect(toast.info).toHaveBeenCalledWith('Downloading "Grabbed Book"', { duration: 5000 });
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
      const es = MockEventSource.instances[0];

      act(() => es.simulateOpen());
      expect(isSSEConnected()).toBe(true);
    });

    it('sets sseConnected to false on error and unmount', () => {
      const { wrapper } = createWrapper();
      const { unmount } = renderHook(() => useEventSource('key'), { wrapper });
      const es = MockEventSource.instances[0];

      act(() => es.simulateOpen());
      expect(isSSEConnected()).toBe(true);

      act(() => es.simulateError());
      expect(isSSEConnected()).toBe(false);

      // Re-open then unmount
      act(() => es.simulateOpen());
      expect(isSSEConnected()).toBe(true);

      unmount();
      expect(isSSEConnected()).toBe(false);
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
