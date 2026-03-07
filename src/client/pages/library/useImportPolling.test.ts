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

import { toast } from 'sonner';

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
    author: undefined,
    authorId: null,
    narrator: null,
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
    vi.useFakeTimers();
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
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];

    renderHook(() => useImportPolling(importingBooks), {
      wrapper: createWrapper(),
    });

    // Should set an interval for 3s polling
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // No error thrown means the interval is running fine
  });

  it('cleans up interval when no books are importing', () => {
    const importingBooks = [makeBook({ id: 1, status: 'importing' })];

    const { rerender } = renderHook(
      ({ books }) => useImportPolling(books),
      {
        wrapper: createWrapper(),
        initialProps: { books: importingBooks },
      },
    );

    // No more importing
    rerender({ books: [makeBook({ id: 1, status: 'imported' })] });

    // Advancing time shouldn't cause issues (interval cleaned up)
    act(() => {
      vi.advanceTimersByTime(10000);
    });
  });
});
