import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useActivityCounts } from './useActivityCounts';

vi.mock('@/lib/api', () => ({
  api: {
    getActivityCounts: vi.fn(),
  },
}));

vi.mock('@/hooks/useEventSource', () => ({
  useSSEConnected: vi.fn(() => false),
}));

import { api } from '@/lib/api';
import { useSSEConnected } from '@/hooks/useEventSource';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useActivityCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns counts from API', async () => {
    vi.mocked(api.getActivityCounts).mockResolvedValue({ active: 3, completed: 5 });

    const { result } = renderHook(() => useActivityCounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.active).toBe(3);
    expect(result.current.completed).toBe(5);
  });

  it('defaults to zero before data loads', () => {
    vi.mocked(api.getActivityCounts).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useActivityCounts(), {
      wrapper: createWrapper(),
    });

    expect(result.current.active).toBe(0);
    expect(result.current.completed).toBe(0);
    expect(result.current.isLoading).toBe(true);
  });

  it('falls back to zero counts when API rejects', async () => {
    vi.mocked(api.getActivityCounts).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useActivityCounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.active).toBe(0);
    expect(result.current.completed).toBe(0);
  });

  it('disables polling when SSE is connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(useSSEConnected).mockReturnValue(true);
      vi.mocked(api.getActivityCounts).mockResolvedValue({ active: 2, completed: 1 });

      const { result } = renderHook(() => useActivityCounts(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const callCountAfterLoad = vi.mocked(api.getActivityCounts).mock.calls.length;

      // Advance well past the 30s interval — SSE gate should suppress polling
      await vi.advanceTimersByTimeAsync(60_000);

      expect(vi.mocked(api.getActivityCounts).mock.calls.length).toBe(callCountAfterLoad);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enables polling when SSE disconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(useSSEConnected).mockReturnValue(true);
      vi.mocked(api.getActivityCounts).mockResolvedValue({ active: 1, completed: 0 });

      const { result, rerender } = renderHook(() => useActivityCounts(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const callCountAfterLoad = vi.mocked(api.getActivityCounts).mock.calls.length;

      // Confirm polling is suppressed while SSE is connected
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.mocked(api.getActivityCounts).mock.calls.length).toBe(callCountAfterLoad);

      // SSE disconnects — interval should switch to 30_000
      vi.mocked(useSSEConnected).mockReturnValue(false);
      rerender();

      await vi.advanceTimersByTimeAsync(31_000);

      expect(vi.mocked(api.getActivityCounts).mock.calls.length).toBeGreaterThan(callCountAfterLoad);
    } finally {
      vi.useRealTimers();
    }
  });
});
