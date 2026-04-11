import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

vi.mock('@/hooks/useLibrary', () => ({
  useLibrary: vi.fn().mockReturnValue({ data: { data: [], total: 0 }, isLoading: false, isPlaceholderData: false }),
  useBookStats: vi.fn().mockReturnValue({ data: null }),
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn().mockResolvedValue({ library: { path: '/audiobooks' } }),
    getIndexers: vi.fn().mockResolvedValue([]),
    rescanLibrary: vi.fn(),
    deleteBook: vi.fn(),
    deleteMissingBooks: vi.fn(),
    searchAllWanted: vi.fn(),
    updateBook: vi.fn(),
    searchBook: vi.fn(),
  },
}));

vi.mock('./useImportPolling.js', () => ({
  useImportPolling: vi.fn(),
}));

import { useLibraryPageState } from './useLibraryPageState';

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe('useLibraryPageState', () => {
  it('returns initial state with loading false and empty books', async () => {
    const { result } = renderHook(() => useLibraryPageState(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
      expect(result.current.displayBooks).toEqual([]);
      expect(result.current.totalBooks).toBe(0);
      expect(result.current.totalAll).toBe(0);
    });
  });

  it('provides view mode defaulting to grid', async () => {
    const { result } = renderHook(() => useLibraryPageState(), { wrapper });

    await waitFor(() => {
      expect(result.current.viewMode).toBe('grid');
    });
  });

  it('provides subtitle for empty collection', async () => {
    const { result } = renderHook(() => useLibraryPageState(), { wrapper });

    await waitFor(() => {
      expect(result.current.subtitle).toBe('0 books in your collection');
    });
  });
});
