import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useImportPolling } from './useImportPolling';
import type { BookWithAuthor } from '@/lib/api';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/useEventSource', () => ({
  useSSEConnected: vi.fn(() => false),
}));

import { toast } from 'sonner';
import { useSSEConnected } from '@/hooks/useEventSource';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return {
    id: 1,
    title: 'Test Book',
    status: 'imported',
    enrichmentStatus: 'pending',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    authors: [],
    narrators: [],
    description: null,
    coverUrl: null,
    asin: null,
    isbn: null,
    seriesName: null,
    seriesPosition: null,
    duration: null,
    publishedDate: null,
    genres: null,
    path: null,
    size: null,
    audioCodec: null,
    audioBitrate: null,
    audioSampleRate: null,
    audioChannels: null,
    audioBitrateMode: null,
    audioFileFormat: null,
    audioFileCount: null,
    audioTotalSize: null,
    audioDuration: null,
    monitorForUpgrades: false,
    ...overrides,
  };
}

describe('useImportPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows toast when importing count transitions from N to 0', () => {
    const importingBooks = [
      makeBook({ id: 1, status: 'importing' }),
      makeBook({ id: 2, status: 'importing' }),
    ];

    const { rerender } = renderHook(
      ({ books }) => useImportPolling(books),
      {
        wrapper: createWrapper(),
        initialProps: { books: importingBooks },
      },
    );

    // Transition to 0 importing
    const doneBooks = [
      makeBook({ id: 1, status: 'imported' }),
      makeBook({ id: 2, status: 'imported' }),
    ];
    rerender({ books: doneBooks });

    expect(toast.success).toHaveBeenCalledWith('Import complete');
  });

  it('does NOT show toast when importing count is 0 from the start', () => {
    const books = [makeBook({ id: 1, status: 'imported' })];

    renderHook(() => useImportPolling(books), {
      wrapper: createWrapper(),
    });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does NOT show toast when importing count goes from N to N (no change to zero)', () => {
    const twoImporting = [
      makeBook({ id: 1, status: 'importing' }),
      makeBook({ id: 2, status: 'importing' }),
    ];

    const { rerender } = renderHook(
      ({ books }) => useImportPolling(books),
      {
        wrapper: createWrapper(),
        initialProps: { books: twoImporting },
      },
    );

    // Still importing (one finished, one new)
    const stillImporting = [
      makeBook({ id: 1, status: 'imported' }),
      makeBook({ id: 3, status: 'importing' }),
    ];
    rerender({ books: stillImporting });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('sets up polling interval when books are importing', () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useImportPolling(importingBooks), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });

    // First tick of the 3s interval should invalidate the books query
    act(() => { vi.advanceTimersByTime(3000); });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
  });

  it('does NOT start polling when SSE is connected and imports are active (#488)', () => {
    vi.mocked(useSSEConnected).mockReturnValue(true);
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useImportPolling(importingBooks), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });

    act(() => { vi.advanceTimersByTime(6000); });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('starts polling when SSE is disconnected and imports are active (#488)', () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useImportPolling(importingBooks), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });

    act(() => { vi.advanceTimersByTime(3000); });

    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('stops polling when SSE reconnects mid-import (#488)', () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { rerender } = renderHook(() => useImportPolling(importingBooks), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });

    // Polling fires while disconnected
    act(() => { vi.advanceTimersByTime(3000); });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    // SSE reconnects
    vi.mocked(useSSEConnected).mockReturnValue(true);
    rerender();
    invalidateSpy.mockClear();

    // No more polling after reconnect
    act(() => { vi.advanceTimersByTime(6000); });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('no polling when importingCount is 0 regardless of SSE state (#488)', () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);
    const books = [makeBook({ id: 1, status: 'imported' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderHook(() => useImportPolling(books), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
    });

    act(() => { vi.advanceTimersByTime(6000); });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('cleans up interval when no books are importing', () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const { rerender } = renderHook(
      ({ books }) => useImportPolling(books),
      {
        wrapper: ({ children }) => createElement(QueryClientProvider, { client: queryClient }, children),
        initialProps: { books: importingBooks },
      },
    );

    // No more importing — should clear the interval
    rerender({ books: [makeBook({ id: 1, status: 'imported' })] });

    // If cleanup failed, the 3s interval would fire during this advance
    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
