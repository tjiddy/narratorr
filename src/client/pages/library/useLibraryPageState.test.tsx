import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

let clampToTotalCallCount = 0;
type ClampFn = (total: number) => void;
const clampWrapperCache = new WeakMap<ClampFn, ClampFn>();
vi.mock('@/hooks/usePagination', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const mod: typeof import('@/hooks/usePagination') = await vi.importActual('@/hooks/usePagination');
  return {
    ...mod,
    usePagination: (...args: Parameters<typeof mod.usePagination>) => {
      const result = mod.usePagination(...args);
      const original = result.clampToTotal;
      if (!clampWrapperCache.has(original)) {
        clampWrapperCache.set(original, (total: number) => {
          clampToTotalCallCount++;
          return original(total);
        });
      }
      return { ...result, clampToTotal: clampWrapperCache.get(original)! };
    },
  };
});

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

import { useLibrary } from '@/hooks/useLibrary';
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
  beforeEach(() => {
    clampToTotalCallCount = 0;
  });

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

  it('clamp effect does not re-fire on re-render when totalBooks is unchanged (stable deps)', async () => {
    const TOTAL = 80;
    vi.mocked(useLibrary).mockReturnValue({
      data: { data: [], total: TOTAL },
      isLoading: false,
      isPlaceholderData: false,
    } as ReturnType<typeof useLibrary>);

    const { result, rerender } = renderHook(() => useLibraryPageState(), { wrapper });

    await waitFor(() => expect(result.current.totalBooks).toBe(TOTAL));

    const countBeforeRerender = clampToTotalCallCount;

    vi.mocked(useLibrary).mockReturnValue({
      data: { data: [], total: TOTAL },
      isLoading: false,
      isPlaceholderData: false,
    } as ReturnType<typeof useLibrary>);

    rerender();

    expect(clampToTotalCallCount).toBe(countBeforeRerender);
  });
});
