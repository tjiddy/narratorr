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

import { api } from '@/lib/api';

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
});
