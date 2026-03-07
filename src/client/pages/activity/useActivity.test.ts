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

  it('returns downloads split into queue and history', async () => {
    const downloads: Download[] = [
      makeDownload({ id: 1, status: 'downloading' }),
      makeDownload({ id: 2, status: 'queued' }),
      makeDownload({ id: 3, status: 'imported' }),
      makeDownload({ id: 4, status: 'failed' }),
      makeDownload({ id: 5, status: 'importing' }),
      makeDownload({ id: 6, status: 'completed' }),
      makeDownload({ id: 7, status: 'paused' }),
    ];
    vi.mocked(api.getActivity).mockResolvedValue(downloads);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Queue: queued, downloading, paused, importing
    expect(result.current.queue).toHaveLength(4);
    expect(result.current.queue.map((d) => d.id).sort()).toEqual([1, 2, 5, 7]);

    // History: completed, imported, failed
    expect(result.current.history).toHaveLength(3);
    expect(result.current.history.map((d) => d.id).sort()).toEqual([3, 4, 6]);
  });

  it('returns empty arrays while loading', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    expect(result.current.downloads).toEqual([]);
    expect(result.current.queue).toEqual([]);
    expect(result.current.history).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });

  it('cancel mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue([]);
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
    vi.mocked(api.getActivity).mockResolvedValue([]);
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
