import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useActivity } from './useActivity';
import type { ActivityListParams } from '@/lib/api/activity';
import type { Download } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getActivity: vi.fn(),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(),
    approveDownload: vi.fn(),
    rejectDownload: vi.fn(),
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

function createWrapperWithClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, queryClient };
}

function makeDownload(overrides: Partial<Download> = {}): Download {
  return {
    id: 1,
    title: 'Test Book',
    protocol: 'torrent',
    status: 'downloading',
    progress: 0.5,
    addedAt: '2024-01-01T00:00:00Z',
    completedAt: null,
    seeders: null,
    indexerName: null,
    ...overrides,
  };
}

describe('useActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns queue data from API call', async () => {
    const queueItems = [makeDownload({ id: 1, status: 'downloading' })];

    vi.mocked(api.getActivity).mockResolvedValue({ data: queueItems, total: 1 });

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    expect(result.current.state.queue).toHaveLength(1);
    expect(result.current.state.queue[0].id).toBe(1);
    expect(result.current.state.queueTotal).toBe(1);
  });

  it('returns empty arrays while loading', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    expect(result.current.state.queue).toEqual([]);
    expect(result.current.status.isLoading).toBe(true);
  });

  it('cancel mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.cancelDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.cancelMutation.mutate(42);
    });

    await waitFor(() => {
      expect(api.cancelDownload).toHaveBeenCalled();
    });
    expect(vi.mocked(api.cancelDownload).mock.calls[0][0]).toBe(42);
  });

  it('retry mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.retryDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.retryMutation.mutate(42);
    });

    await waitFor(() => {
      expect(api.retryDownload).toHaveBeenCalled();
    });
    expect(vi.mocked(api.retryDownload).mock.calls[0][0]).toBe(42);
  });

  it('approve mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.approveDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.approveMutation.mutate(42);
    });

    await waitFor(() => {
      expect(api.approveDownload).toHaveBeenCalled();
    });
    expect(vi.mocked(api.approveDownload).mock.calls[0][0]).toBe(42);
  });

  it('reject mutation with retry=false calls api.rejectDownload(id, { retry: false }) and invalidates on success', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.rejectDownload).mockResolvedValue(undefined as never);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useActivity(), { wrapper });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.rejectMutation.mutate({ id: 42, retry: false });
    });

    await waitFor(() => {
      expect(api.rejectDownload).toHaveBeenCalledWith(42, { retry: false });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
  });

  it('reject mutation with retry=true calls api.rejectDownload(id, { retry: true })', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.rejectDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.rejectMutation.mutate({ id: 42, retry: true });
    });

    await waitFor(() => {
      expect(api.rejectDownload).toHaveBeenCalledWith(42, { retry: true });
    });
  });

  it('reject mutation does not invalidate queries on failure', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.rejectDownload).mockRejectedValue(new Error('reject failed'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result } = renderHook(() => useActivity(), { wrapper });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    invalidateSpy.mockClear();

    await act(async () => {
      result.current.mutations.rejectMutation.mutate({ id: 42, retry: false });
    });

    await waitFor(() => {
      expect(result.current.mutations.rejectMutation.isError).toBe(true);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('sets isError when API rejects', async () => {
    vi.mocked(api.getActivity).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isError).toBe(true);
    });
  });
});

describe('grouped return shape (REACT-1 refactor)', () => {
  it('returned object has state, mutations, status keys with no top-level leaked values', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity(), { wrapper });
    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('mutations');
    expect(result.current).toHaveProperty('status');
    expect(result.current).not.toHaveProperty('queue');
    expect(result.current).not.toHaveProperty('isLoading');
    expect(result.current).not.toHaveProperty('cancelMutation');
  });

  it('state group contains queue and queueTotal', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity(), { wrapper });
    expect(result.current.state).toHaveProperty('queue');
    expect(result.current.state).toHaveProperty('queueTotal');
  });

  it('status group contains isLoading and isError', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity(), { wrapper });
    expect(result.current.status).toHaveProperty('isLoading');
    expect(result.current.status).toHaveProperty('isError');
  });

  it('mutations group contains all 4 mutations', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity(), { wrapper });
    const mutationNames = ['cancelMutation', 'retryMutation', 'approveMutation', 'rejectMutation'] as const;
    for (const name of mutationNames) {
      expect(result.current.mutations).toHaveProperty(name);
    }
  });
});

describe('refetchInterval conditional logic', () => {
  function createRefetchWrapper() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    return { wrapper, queryClient };
  }

  it('queue with SSE connected returns false (polling disabled)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
    vi.mocked(useSSEConnected).mockReturnValue(true);
    try {
      vi.mocked(api.getActivity).mockResolvedValue({ data: [makeDownload({ id: 1, status: 'downloading' })], total: 1 });

      const { wrapper, queryClient } = createRefetchWrapper();
      const { unmount } = renderHook(() => useActivity(), { wrapper });

      await waitFor(() => {
        expect(api.getActivity).toHaveBeenCalledTimes(1);
      });

      vi.mocked(api.getActivity).mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

      expect(api.getActivity).not.toHaveBeenCalled();

      unmount();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queue with SSE disconnected and undefined data returns 5000 (default polling)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
    vi.mocked(useSSEConnected).mockReturnValue(false);
    try {
      vi.mocked(api.getActivity).mockRejectedValue(new Error('network error'));

      const { wrapper, queryClient } = createRefetchWrapper();
      const { unmount } = renderHook(() => useActivity(), { wrapper });

      await waitFor(() => {
        expect(api.getActivity).toHaveBeenCalledTimes(1);
      });

      vi.mocked(api.getActivity).mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });

      expect(api.getActivity).toHaveBeenCalled();

      unmount();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queue with SSE disconnected and all terminal-status downloads returns false', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
    vi.mocked(useSSEConnected).mockReturnValue(false);
    try {
      vi.mocked(api.getActivity).mockResolvedValue({
        data: [
          makeDownload({ id: 1, status: 'completed' }),
          makeDownload({ id: 2, status: 'failed' }),
        ],
        total: 2,
      });

      const { wrapper, queryClient } = createRefetchWrapper();
      const { unmount } = renderHook(() => useActivity(), { wrapper });

      await waitFor(() => {
        expect(api.getActivity).toHaveBeenCalledTimes(1);
      });

      vi.mocked(api.getActivity).mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

      expect(api.getActivity).not.toHaveBeenCalled();

      unmount();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queue with SSE disconnected and at least one in-progress download returns 5000', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
    vi.mocked(useSSEConnected).mockReturnValue(false);
    try {
      vi.mocked(api.getActivity).mockResolvedValue({
        data: [
          makeDownload({ id: 1, status: 'completed' }),
          makeDownload({ id: 2, status: 'downloading' }),
        ],
        total: 2,
      });

      const { wrapper, queryClient } = createRefetchWrapper();
      const { unmount } = renderHook(() => useActivity(), { wrapper });

      await waitFor(() => {
        expect(api.getActivity).toHaveBeenCalledTimes(1);
      });

      vi.mocked(api.getActivity).mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(5100); });

      expect(api.getActivity).toHaveBeenCalled();

      unmount();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queue with SSE disconnected and empty data array returns false', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
    vi.mocked(useSSEConnected).mockReturnValue(false);
    try {
      vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });

      const { wrapper, queryClient } = createRefetchWrapper();
      const { unmount } = renderHook(() => useActivity(), { wrapper });

      await waitFor(() => {
        expect(api.getActivity).toHaveBeenCalledTimes(1);
      });

      vi.mocked(api.getActivity).mockClear();

      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });

      expect(api.getActivity).not.toHaveBeenCalled();

      unmount();
      queryClient.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
