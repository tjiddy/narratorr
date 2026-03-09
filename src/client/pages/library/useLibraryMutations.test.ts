import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useLibraryMutations } from './useLibraryMutations';

vi.mock('@/lib/api', () => ({
  api: {
    rescanLibrary: vi.fn(),
    deleteBook: vi.fn(),
    deleteMissingBooks: vi.fn(),
    searchAllWanted: vi.fn(),
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
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useLibraryMutations', () => {
  describe('rescanMutation', () => {
    it('calls rescanLibrary and shows success toast', async () => {
      vi.mocked(api.rescanLibrary).mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.rescanMutation.mutate(); });

      await waitFor(() => {
        expect(api.rescanLibrary).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          'Scanned: 10 books. Missing: 2 books. Restored: 1 books.',
        );
      });
    });

    it('shows error toast when rescan fails', async () => {
      vi.mocked(api.rescanLibrary).mockRejectedValue(new Error('Network timeout'));

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.rescanMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Rescan failed: Network timeout');
      });
    });
  });

  describe('deleteMutation', () => {
    it('calls deleteBook without deleteFiles option', async () => {
      vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMutation.mutate({ id: 1, deleteFiles: false }); });

      await waitFor(() => {
        expect(api.deleteBook).toHaveBeenCalledWith(1, undefined);
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed book from library');
      });
    });

    it('calls deleteBook with deleteFiles option and shows file deletion toast', async () => {
      vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMutation.mutate({ id: 1, deleteFiles: true }); });

      await waitFor(() => {
        expect(api.deleteBook).toHaveBeenCalledWith(1, { deleteFiles: true });
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed book and deleted files from disk');
      });
    });

    it('shows error toast when delete fails', async () => {
      vi.mocked(api.deleteBook).mockRejectedValue(new Error('Permission denied'));

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMutation.mutate({ id: 1, deleteFiles: false }); });

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove book: Permission denied');
      });
    });
  });

  describe('deleteMissingMutation', () => {
    it('calls deleteMissingBooks and shows success toast with count', async () => {
      vi.mocked(api.deleteMissingBooks).mockResolvedValue({ deleted: 5 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMissingMutation.mutate(); });

      await waitFor(() => {
        expect(api.deleteMissingBooks).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed 5 missing books');
      });
    });

    it('uses singular form when only 1 book deleted', async () => {
      vi.mocked(api.deleteMissingBooks).mockResolvedValue({ deleted: 1 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMissingMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed 1 missing book');
      });
    });

    it('shows error toast when batch delete fails', async () => {
      vi.mocked(api.deleteMissingBooks).mockRejectedValue(new Error('DB connection lost'));

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.deleteMissingMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove missing books: DB connection lost');
      });
    });
  });

  describe('searchAllWantedMutation', () => {
    it('calls api.searchAllWanted on mutate', async () => {
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 5, grabbed: 2, skipped: 1, errors: 0 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(api.searchAllWanted).toHaveBeenCalledTimes(1);
      });
    });

    it('shows success toast with searched/grabbed/skipped counts on success', async () => {
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 5, grabbed: 2, skipped: 1, errors: 0 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Search complete: 5 searched, 2 grabbed, 1 skipped');
      });
    });

    it('includes errors in toast when present', async () => {
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 3, grabbed: 1, skipped: 0, errors: 2 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Search complete: 3 searched, 1 grabbed, 2 errors');
      });
    });

    it('omits both skipped and errors from toast when both are zero', async () => {
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 4, grabbed: 3, skipped: 0, errors: 0 });

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Search complete: 4 searched, 3 grabbed');
      });
    });

    it('invalidates books and activity queries on success', async () => {
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 2, grabbed: 1, skipped: 0, errors: 0 });

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      const { result } = renderHook(() => useLibraryMutations(), { wrapper });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith({ queryKey: ['books'] });
        expect(spy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      });
    });

    it('shows error toast on failure', async () => {
      vi.mocked(api.searchAllWanted).mockRejectedValue(new Error('Server error'));

      const { result } = renderHook(() => useLibraryMutations(), { wrapper: createWrapper() });

      act(() => { result.current.searchAllWantedMutation.mutate(); });

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Search all wanted failed: Server error');
      });
    });
  });
});
