import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useLibraryBulkActions } from './useLibraryBulkActions';
import type { BookWithAuthor } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';

vi.mock('@/lib/api', () => ({
  api: {
    deleteBook: vi.fn(),
    searchBook: vi.fn(),
    updateBook: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const book1 = createMockBook({ id: 1, status: 'wanted' });
const book2 = createMockBook({ id: 2, status: 'wanted' });
const book3 = createMockBook({ id: 3, status: 'wanted' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLibraryBulkActions — selection state', () => {
  it('initial state: returned selectedIds is an empty Set and selectedBooks is an empty array', () => {
    const { result } = renderHook(() => useLibraryBulkActions([book1, book2]), {
      wrapper: createWrapper(),
    });

    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedBooks).toEqual([]);
  });

  it('after calling setSelectedIds with IDs including some not in visibleBooks, returned selectedIds only contains the visible subset', () => {
    const { result } = renderHook(() => useLibraryBulkActions([book1, book2]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 99]));
    });

    expect(result.current.selectedIds).toEqual(new Set([1, 2]));
    expect(result.current.selectedIds.has(99)).toBe(false);
  });

  it('selectedBooks contains exactly the visible books whose IDs are in the returned selectedIds', () => {
    const { result } = renderHook(() => useLibraryBulkActions([book1, book2, book3]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1, 3]));
    });

    expect(result.current.selectedBooks).toEqual([book1, book3]);
  });

  it('when visibleBooks changes (rerender with fewer books), returned selectedIds updates to exclude the removed books', () => {
    let visibleBooks: BookWithAuthor[] = [book1, book2, book3];
    const { result, rerender } = renderHook(() => useLibraryBulkActions(visibleBooks), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    expect(result.current.selectedIds).toEqual(new Set([1, 2, 3]));

    // Rerender with book2 removed from visible list
    visibleBooks = [book1, book3];
    rerender();

    expect(result.current.selectedIds).toEqual(new Set([1, 3]));
    expect(result.current.selectedIds.has(2)).toBe(false);
  });

  it('clearSelection resets selectedIds to an empty Set', () => {
    const { result } = renderHook(() => useLibraryBulkActions([book1, book2]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });
    expect(result.current.selectedIds.size).toBe(2);

    act(() => {
      result.current.clearSelection();
    });
    expect(result.current.selectedIds.size).toBe(0);
  });
});

describe('useLibraryBulkActions — bulkDeleteMutation onError', () => {
  it('when mutationFn throws, toast.error is called with "Bulk delete failed: <message>"', async () => {
    // Make deleteBook throw immediately so Promise.allSettled never runs
    vi.mocked(api.deleteBook).mockImplementation(() => {
      throw new Error('Network failure');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Bulk delete failed: Network failure');
    });
  });

  it('selection state is preserved (not cleared) after onError', async () => {
    vi.mocked(api.deleteBook).mockImplementation(() => {
      throw new Error('Network failure');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });

    expect(result.current.selectedIds).toEqual(new Set([1]));
  });
});

describe('useLibraryBulkActions — bulkSearchMutation onError', () => {
  it('when mutationFn throws, toast.error is called with "Bulk search failed: <message>"', async () => {
    vi.mocked(api.searchBook).mockImplementation(() => {
      throw new Error('Indexer unavailable');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Bulk search failed: Indexer unavailable');
    });
  });

  it('selection state is preserved after onError', async () => {
    vi.mocked(api.searchBook).mockImplementation(() => {
      throw new Error('Indexer unavailable');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });

    expect(result.current.selectedIds).toEqual(new Set([1]));
  });
});

describe('useLibraryBulkActions — bulkSetStatusMutation onError', () => {
  it('when mutationFn throws, toast.error is called with "Bulk status update failed: <message>"', async () => {
    vi.mocked(api.updateBook).mockImplementation(() => {
      throw new Error('Server error');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkSetStatusMutation.mutate({ status: 'imported', label: 'Owned' });
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Bulk status update failed: Server error');
    });
  });

  it('selection state is preserved after onError', async () => {
    vi.mocked(api.updateBook).mockImplementation(() => {
      throw new Error('Server error');
    });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkSetStatusMutation.mutate({ status: 'imported', label: 'Owned' });
    });

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalled();
    });

    expect(result.current.selectedIds).toEqual(new Set([1]));
  });
});

describe('useLibraryBulkActions — boundary values', () => {
  it('empty visibleBooks array — returned selectedIds is empty regardless of what was passed to setSelectedIds', () => {
    const { result } = renderHook(() => useLibraryBulkActions([]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedBooks).toEqual([]);
  });

  it('single book selected and visible — mutation operates on exactly one book', async () => {
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

    const { result } = renderHook(() => useLibraryBulkActions([book1]), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    act(() => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(api.deleteBook).toHaveBeenCalledTimes(1);
      expect(api.deleteBook).toHaveBeenCalledWith(1, undefined);
    });
  });
});
