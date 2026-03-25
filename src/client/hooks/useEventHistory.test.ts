import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useEventHistory, useBookEventHistory } from './useEventHistory';
import { queryKeys } from '@/lib/queryKeys';

vi.mock('@/lib/api', () => ({
  api: {
    getEventHistory: vi.fn(),
    getBookEventHistory: vi.fn(),
    markEventFailed: vi.fn(),
    deleteEvent: vi.fn(),
    deleteEvents: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
    queryClient,
  };
}

describe('useEventHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns events from API', async () => {
    const mockEvents = [{ id: 1, bookId: 1, downloadId: 1, bookTitle: 'Test', authorName: 'Author', eventType: 'grab', source: 'search', reason: null, createdAt: '2026-01-01' }];
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: mockEvents, total: mockEvents.length });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.events).toEqual(mockEvents);
    expect(api.getEventHistory).toHaveBeenCalledWith(undefined);
  });

  it('passes filter params to API', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });

    const { wrapper } = createWrapper();
    const params = { eventType: 'grab', search: 'test' };
    renderHook(() => useEventHistory(params), { wrapper });

    await waitFor(() => {
      expect(api.getEventHistory).toHaveBeenCalledWith(params);
    });
  });

  it('markFailed invalidates eventHistory with root prefix key', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.markEventFailed).mockResolvedValue(undefined as never);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.markFailedMutation.mutate({ eventId: 1, bookId: 2 } as never);
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.blacklist() });
      expect(toast.success).toHaveBeenCalledWith('Release blacklisted and book set to wanted');
    });
  });

  it('deleteMutation calls api.deleteEvent with id, invalidates root, and shows success toast', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteEvent).mockResolvedValue(undefined as never);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.deleteMutation.mutate(7);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Event deleted');
    });

    expect(api.deleteEvent).toHaveBeenCalledWith(7, expect.anything());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
  });

  it('deleteMutation shows error toast on failure', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteEvent).mockRejectedValue(new Error('Server error'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.deleteMutation.mutate(7);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Delete failed: Server error');
    });
  });

  it('bulkDeleteMutation calls api.deleteEvents without filter, invalidates root, and shows "Cleared all events"', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteEvents).mockResolvedValue(undefined as never);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate(undefined);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Cleared all events');
    });

    expect(api.deleteEvents).toHaveBeenCalledWith(undefined, expect.anything());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
  });

  it('bulkDeleteMutation with eventType filter shows "Cleared matching events"', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteEvents).mockResolvedValue(undefined as never);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ eventType: 'download_failed' });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Cleared matching events');
    });

    expect(api.deleteEvents).toHaveBeenCalledWith({ eventType: 'download_failed' }, expect.anything());
  });

  it('bulkDeleteMutation shows error toast on failure', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteEvents).mockRejectedValue(new Error('Bulk fail'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate(undefined);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Clear failed: Bulk fail');
    });
  });

  it('markFailed shows error toast on failure', async () => {
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.markEventFailed).mockRejectedValue(new Error('Network error'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useEventHistory(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.markFailedMutation.mutate({ eventId: 1, bookId: 2 } as never);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Mark as failed: Network error');
    });
  });

  it('preserves previous page events while next params key is loading (placeholderData)', async () => {
    const page1Event = {
      id: 1,
      bookId: 1,
      downloadId: 1,
      bookTitle: 'Page 1 Event',
      authorName: 'Author',
      eventType: 'grab',
      source: 'search',
      reason: null,
      createdAt: '2026-01-01',
    };

    let resolveP2!: (v: { data: typeof page1Event[]; total: number }) => void;
    const pendingP2 = new Promise<{ data: typeof page1Event[]; total: number }>((r) => {
      resolveP2 = r;
    });

    vi.mocked(api.getEventHistory)
      .mockResolvedValueOnce({ data: [page1Event], total: 50 })
      .mockReturnValueOnce(pendingP2 as never);

    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      (props: { limit: number; offset: number }) => useEventHistory(props),
      { wrapper, initialProps: { limit: 50, offset: 0 } },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.events[0].bookTitle).toBe('Page 1 Event');
    expect(result.current.total).toBe(50);

    // Rerender with new params — triggers page 2 fetch (which is pending)
    rerender({ limit: 50, offset: 50 });

    // placeholderData keeps page 1 events visible synchronously
    expect(result.current.events[0].bookTitle).toBe('Page 1 Event');
    expect(result.current.total).toBe(50);

    // Resolve page 2
    act(() => {
      resolveP2({ data: [], total: 0 });
    });

    await waitFor(() => expect(result.current.total).toBe(0));
    expect(result.current.events).toHaveLength(0);
  });
});

describe('useBookEventHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns book-specific events from API', async () => {
    const mockEvents = [{ id: 1, bookId: 42, downloadId: 1, bookTitle: 'Test', authorName: 'Author', eventType: 'import', source: 'scan', reason: null, createdAt: '2026-01-01' }];
    vi.mocked(api.getBookEventHistory).mockResolvedValue(mockEvents);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBookEventHistory(42), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.events).toEqual(mockEvents);
    expect(api.getBookEventHistory).toHaveBeenCalledWith(42);
  });

  it('deleteMutation calls api.deleteEvent, invalidates root and book-specific keys, and shows toast', async () => {
    vi.mocked(api.getBookEventHistory).mockResolvedValue([]);
    vi.mocked(api.deleteEvent).mockResolvedValue(undefined as never);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useBookEventHistory(42), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.deleteMutation.mutate(7);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Event deleted');
    });

    expect(api.deleteEvent).toHaveBeenCalledWith(7, expect.anything());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.root() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.byBookId(42) });
  });

  it('deleteMutation shows error toast on failure', async () => {
    vi.mocked(api.getBookEventHistory).mockResolvedValue([]);
    vi.mocked(api.deleteEvent).mockRejectedValue(new Error('Gone wrong'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBookEventHistory(42), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.deleteMutation.mutate(7);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Delete failed: Gone wrong');
    });
  });

  it('markFailed invalidates book-specific queries', async () => {
    vi.mocked(api.getBookEventHistory).mockResolvedValue([]);
    vi.mocked(api.markEventFailed).mockResolvedValue(undefined as never);

    const { wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useBookEventHistory(42), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.markFailedMutation.mutate({ eventId: 1, bookId: 42 } as never);
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.eventHistory.byBookId(42) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.book(42) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.blacklist() });
    });
  });
});
