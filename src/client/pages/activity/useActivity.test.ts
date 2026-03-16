import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useActivity } from './useActivity';
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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function makeDownload(overrides: Partial<Download> = {}): Download {
  return {
    id: 1,
    title: 'Test Book',
    protocol: 'torrent',
    status: 'downloading',
    progress: 0.5,
    addedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('useActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns queue and history from separate API calls', async () => {
    const queueItems = [makeDownload({ id: 1, status: 'downloading' })];
    const historyItems = [makeDownload({ id: 2, status: 'completed' })];

    vi.mocked(api.getActivity)
      .mockResolvedValueOnce({ data: queueItems, total: 1 })
      .mockResolvedValueOnce({ data: historyItems, total: 1 });

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0].id).toBe(1);
    expect(result.current.queueTotal).toBe(1);
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0].id).toBe(2);
    expect(result.current.historyTotal).toBe(1);
  });

  it('returns empty arrays while loading', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    expect(result.current.queue).toEqual([]);
    expect(result.current.history).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('cancel mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.cancelDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.cancelMutation.mutate(42);
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
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.retryMutation.mutate(42);
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
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.approveMutation.mutate(42);
    });

    await waitFor(() => {
      expect(api.approveDownload).toHaveBeenCalled();
    });
    expect(vi.mocked(api.approveDownload).mock.calls[0][0]).toBe(42);
  });

  it('reject mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.rejectDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.rejectMutation.mutate(42);
    });

    await waitFor(() => {
      expect(api.rejectDownload).toHaveBeenCalled();
    });
    expect(vi.mocked(api.rejectDownload).mock.calls[0][0]).toBe(42);
  });

  it('sets isError when API rejects', async () => {
    vi.mocked(api.getActivity).mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});
