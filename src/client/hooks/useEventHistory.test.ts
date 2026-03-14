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
