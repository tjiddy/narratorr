import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useActivity } from './useActivity';
import type { ActivityListParams } from '@/lib/api/activity';
import type { Download } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

vi.mock('@/lib/api', () => ({
  api: {
    getActivity: vi.fn(),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(),
    approveDownload: vi.fn(),
    rejectDownload: vi.fn(),
    deleteHistoryDownload: vi.fn(),
    deleteDownloadHistory: vi.fn(),
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
    indexerName: null,
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
      expect(result.current.status.isLoading).toBe(false);
    });

    expect(result.current.state.queue).toHaveLength(1);
    expect(result.current.state.queue[0].id).toBe(1);
    expect(result.current.state.queueTotal).toBe(1);
    expect(result.current.state.history).toHaveLength(1);
    expect(result.current.state.history[0].id).toBe(2);
    expect(result.current.state.historyTotal).toBe(1);
  });

  it('returns empty arrays while loading', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    expect(result.current.state.queue).toEqual([]);
    expect(result.current.state.history).toEqual([]);
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

  it('reject mutation calls api and invalidates queries', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.rejectDownload).mockResolvedValue(undefined as never);

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.status.isLoading).toBe(false);
    });

    await act(async () => {
      result.current.mutations.rejectMutation.mutate(42);
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
      expect(result.current.status.isError).toBe(true);
    });
  });

  it('deleteMutation calls deleteHistoryDownload with correct id', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteHistoryDownload).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    await act(async () => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    await waitFor(() => {
      expect(api.deleteHistoryDownload).toHaveBeenCalledWith(7);
    });
  });

  it('deleteMutation invalidates eventHistory.root() and eventHistory.byBookId() when bookId is non-null', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteHistoryDownload).mockResolvedValue({ success: true });

    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useActivity(), { wrapper });

    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    await act(async () => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    await waitFor(() => {
      expect(api.deleteHistoryDownload).toHaveBeenCalledWith(7);
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContainEqual({ queryKey: ['activity'] });
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.root() });
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.byBookId(99) });
  });

  it('deleteMutation skips eventHistory.byBookId() invalidation when bookId is null', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteHistoryDownload).mockResolvedValue({ success: true });

    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useActivity(), { wrapper });

    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    await act(async () => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: null });
    });

    await waitFor(() => {
      expect(api.deleteHistoryDownload).toHaveBeenCalledWith(7);
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.root() });
    expect(invalidatedKeys).not.toContainEqual(
      expect.objectContaining({ queryKey: expect.arrayContaining(['eventHistory', 'book']) }),
    );
  });

  it('deleteMutation onMutate removes the target item from all matching history activity cache entries and decrements total', async () => {
    const item1 = makeDownload({ id: 7, bookId: 99, status: 'completed' });
    const item2 = makeDownload({ id: 8, bookId: null, status: 'failed' });

    const { wrapper, queryClient } = createWrapperWithClient();

    // Pre-populate a history cache entry
    const historyKey = queryKeys.activity({ section: 'history', limit: 10, offset: 0 });
    queryClient.setQueryData(historyKey, { data: [item1, item2], total: 2 });

    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    // Use a deferred promise so onMutate runs but mutation doesn't complete
    let resolveDelete!: (v: { success: boolean }) => void;
    vi.mocked(api.deleteHistoryDownload).mockReturnValue(
      new Promise<{ success: boolean }>((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    act(() => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    // onMutate should have run synchronously — cache should be updated before resolve
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
      expect(cached?.data.map((d) => d.id)).toEqual([8]);
      expect(cached?.total).toBe(1);
    });

    resolveDelete({ success: true });
  });

  it('deleteMutation onMutate patches all history page caches when item spans multiple paginated entries', async () => {
    const targetItem = makeDownload({ id: 7, bookId: 99, status: 'completed' });
    const otherItem = makeDownload({ id: 8, bookId: null, status: 'failed' });

    const { wrapper, queryClient } = createWrapperWithClient();

    // Seed two different history pages (different offsets)
    const historyPage1 = queryKeys.activity({ section: 'history', limit: 10, offset: 0 });
    const historyPage2 = queryKeys.activity({ section: 'history', limit: 10, offset: 10 });
    queryClient.setQueryData(historyPage1, { data: [targetItem, otherItem], total: 12 });
    queryClient.setQueryData(historyPage2, { data: [targetItem], total: 12 });

    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    let resolveDelete!: (v: { success: boolean }) => void;
    vi.mocked(api.deleteHistoryDownload).mockReturnValue(
      new Promise<{ success: boolean }>((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    act(() => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    // Both history pages should have the item removed and total decremented
    await waitFor(() => {
      const page1 = queryClient.getQueryData<{ data: Download[]; total: number }>(historyPage1);
      expect(page1?.data.map((d) => d.id)).toEqual([8]);
      expect(page1?.total).toBe(11);
    });

    const page2 = queryClient.getQueryData<{ data: Download[]; total: number }>(historyPage2);
    expect(page2?.data).toHaveLength(0);
    expect(page2?.total).toBe(11);

    resolveDelete({ success: true });
  });

  it('deleteMutation onMutate leaves queue cache entries untouched', async () => {
    const queueItem = makeDownload({ id: 5, status: 'downloading' });
    const historyItem = makeDownload({ id: 7, bookId: 99, status: 'completed' });

    const { wrapper, queryClient } = createWrapperWithClient();

    const queueKey = queryKeys.activity({ section: 'queue', limit: 10, offset: 0 });
    const historyKey = queryKeys.activity({ section: 'history', limit: 10, offset: 0 });
    queryClient.setQueryData(queueKey, { data: [queueItem], total: 1 });
    queryClient.setQueryData(historyKey, { data: [historyItem], total: 1 });

    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    let resolveDelete!: (v: { success: boolean }) => void;
    vi.mocked(api.deleteHistoryDownload).mockReturnValue(
      new Promise<{ success: boolean }>((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    act(() => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    await waitFor(() => {
      const history = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
      expect(history?.data).toHaveLength(0);
    });

    // Queue should be untouched
    const queue = queryClient.getQueryData<{ data: Download[]; total: number }>(queueKey);
    expect(queue?.data).toHaveLength(1);
    expect(queue?.total).toBe(1);

    resolveDelete({ success: true });
  });

  it('deleteMutation onError restores both data and total from the onMutate snapshot', async () => {
    const item1 = makeDownload({ id: 7, bookId: 99, status: 'completed' });
    const item2 = makeDownload({ id: 8, bookId: null, status: 'failed' });

    const { wrapper, queryClient } = createWrapperWithClient();
    const historyKey = queryKeys.activity({ section: 'history', limit: 10, offset: 0 });
    queryClient.setQueryData(historyKey, { data: [item1, item2], total: 2 });

    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    let rejectDelete!: (e: Error) => void;
    vi.mocked(api.deleteHistoryDownload).mockReturnValue(
      new Promise<{ success: boolean }>((_, rej) => { rejectDelete = rej; }),
    );

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    act(() => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    // Verify optimistic removal happened
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
      expect(cached?.data).toHaveLength(1);
    });

    // Reject → should restore
    act(() => { rejectDelete(new Error('Server error')); });

    await waitFor(() => {
      const cached = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
      expect(cached?.data.map((d) => d.id)).toEqual([7, 8]);
      expect(cached?.total).toBe(2);
    });
  });

  it('deleteMutation onSettled invalidates activity, eventHistory.root(), and eventHistory.byBookId() when bookId is non-null', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteHistoryDownload).mockResolvedValue({ success: true });

    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    await act(async () => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    await waitFor(() => {
      expect(api.deleteHistoryDownload).toHaveBeenCalledWith(7);
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContainEqual({ queryKey: ['activity'] });
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.root() });
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.byBookId(99) });
  });

  it('deleteHistoryMutation calls deleteDownloadHistory and invalidates eventHistory.root()', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.deleteDownloadHistory).mockResolvedValue({ deleted: 3 });

    const { wrapper, queryClient } = createWrapperWithClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => useActivity(), { wrapper });

    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    await act(async () => {
      result.current.mutations.deleteHistoryMutation.mutate();
    });

    await waitFor(() => {
      expect(api.deleteDownloadHistory).toHaveBeenCalled();
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map((c) => c[0]);
    expect(invalidatedKeys).toContainEqual({ queryKey: ['activity'] });
    expect(invalidatedKeys).toContainEqual({ queryKey: queryKeys.eventHistory.root() });
  });

  it('deleteMutation onMutate cancels in-flight activity queries so a stale refetch cannot overwrite the optimistic removal', async () => {
    const targetItem = makeDownload({ id: 7, bookId: 99, status: 'completed' });
    const otherItem = makeDownload({ id: 8, bookId: null, status: 'failed' });

    const { wrapper, queryClient } = createWrapperWithClient();

    let resolveStaleRefetch!: (v: { data: Download[]; total: number }) => void;
    const staleRefetchPromise = new Promise<{ data: Download[]; total: number }>(
      (r) => { resolveStaleRefetch = r; },
    );

    // Initial loads resolve immediately; subsequent history refetches are deferred
    vi.mocked(api.getActivity)
      .mockResolvedValueOnce({ data: [], total: 0 }) // queue initial
      .mockResolvedValueOnce({ data: [targetItem, otherItem], total: 2 }) // history initial
      .mockImplementation((params?: ActivityListParams) => {
        if (params?.section === 'history') return staleRefetchPromise;
        return Promise.resolve({ data: [], total: 0 });
      });

    let resolveDelete!: (v: { success: boolean }) => void;
    vi.mocked(api.deleteHistoryDownload).mockReturnValue(
      new Promise<{ success: boolean }>((r) => { resolveDelete = r; }),
    );

    const { result } = renderHook(() => useActivity(), { wrapper });
    await waitFor(() => { expect(result.current.status.isLoading).toBe(false); });

    // The hook calls useActivity() with no args so the history key is params={section:'history'}
    const historyKey = queryKeys.activity({ section: 'history' });

    // Trigger a background invalidation simulating SSE or another mutation firing
    act(() => {
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    });

    // Delete while the refetch is still in-flight
    act(() => {
      result.current.mutations.deleteMutation.mutate({ id: 7, bookId: 99 });
    });

    // onMutate ran: item 7 should be removed
    await waitFor(() => {
      const cached = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
      expect(cached?.data.map((d) => d.id)).toEqual([8]);
    });

    // Resolve the stale refetch with original data still containing item 7
    act(() => { resolveStaleRefetch({ data: [targetItem, otherItem], total: 2 }); });

    // Let microtasks settle — the stale response should be discarded because cancelQueries ran
    await act(async () => { await new Promise<void>((r) => { setTimeout(r, 50); }); });

    const cached = queryClient.getQueryData<{ data: Download[]; total: number }>(historyKey);
    expect(cached?.data.map((d) => d.id)).not.toContain(7);

    resolveDelete({ success: true });
  });
});

describe('grouped return shape (REACT-1 refactor)', () => {
  it('returned object has state, mutations, status keys with no top-level leaked values', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity({}, {}), { wrapper });
    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('mutations');
    expect(result.current).toHaveProperty('status');
    expect(result.current).not.toHaveProperty('queue');
    expect(result.current).not.toHaveProperty('history');
    expect(result.current).not.toHaveProperty('isLoading');
    expect(result.current).not.toHaveProperty('cancelMutation');
  });

  it('state group contains queue, queueTotal, history, historyTotal', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity({}, {}), { wrapper });
    expect(result.current.state).toHaveProperty('queue');
    expect(result.current.state).toHaveProperty('queueTotal');
    expect(result.current.state).toHaveProperty('history');
    expect(result.current.state).toHaveProperty('historyTotal');
  });

  it('status group contains isLoading and isError', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity({}, {}), { wrapper });
    expect(result.current.status).toHaveProperty('isLoading');
    expect(result.current.status).toHaveProperty('isError');
  });

  it('mutations group contains all 6 mutations', () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    const { wrapper } = createWrapperWithClient();
    const { result } = renderHook(() => useActivity({}, {}), { wrapper });
    const mutationNames = ['cancelMutation', 'retryMutation', 'approveMutation', 'rejectMutation', 'deleteMutation', 'deleteHistoryMutation'] as const;
    for (const name of mutationNames) {
      expect(result.current.mutations).toHaveProperty(name);
    }
  });
});
