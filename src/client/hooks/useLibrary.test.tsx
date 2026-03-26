import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useLibrary, useLibraryBook, useBookFiles, useBookIdentifiers, useBookStats } from './useLibrary';
import { createMockBook } from '@/__tests__/factories';
import type { BookFile, BookIdentifier, BookStats } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    getBookById: vi.fn(),
    getBookFiles: vi.fn(),
    getBookIdentifiers: vi.fn(),
    getBookStats: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

describe('useLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.getBooks and returns data', async () => {
    const mockBooks = [createMockBook({ id: 1, title: 'Test Book' })];

    vi.mocked(api.getBooks).mockResolvedValue({ data: mockBooks, total: mockBooks.length });

    const { result } = renderHook(() => useLibrary(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBooks).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ data: mockBooks, total: mockBooks.length });
  });

  it('handles loading state', () => {
    vi.mocked(api.getBooks).mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );

    const { result } = renderHook(() => useLibrary(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it('preserves previous page data while next params key is loading (placeholderData)', async () => {
    const page1Books = [createMockBook({ id: 1, title: 'Page 1 Book' })];

    let resolveP2!: (v: { data: ReturnType<typeof createMockBook>[]; total: number }) => void;
    const pendingP2: Promise<{ data: ReturnType<typeof createMockBook>[]; total: number }> = new Promise((r) => {
      resolveP2 = r;
    });

    vi.mocked(api.getBooks)
      .mockResolvedValueOnce({ data: page1Books, total: page1Books.length })
      .mockReturnValueOnce(pendingP2 as never);

    const { result, rerender } = renderHook(
      (props: { limit: number; offset: number }) => useLibrary(props),
      { wrapper: createWrapper(), initialProps: { limit: 100, offset: 0 } },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.data?.[0]?.title).toBe('Page 1 Book');

    // Rerender with new params — triggers page 2 fetch (which is pending)
    rerender({ limit: 100, offset: 100 });

    // placeholderData keeps page 1 data visible synchronously
    expect(result.current.data?.data?.[0]?.title).toBe('Page 1 Book');

    // Resolve page 2
    act(() => {
      resolveP2({ data: [], total: page1Books.length });
    });

    await waitFor(() => expect(result.current.data?.data).toHaveLength(0));
  });
});

describe('useLibraryBook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.getBookById with the given id', async () => {
    const mockBook = createMockBook({ id: 1, title: 'Test Book' });

    vi.mocked(api.getBookById).mockResolvedValue(mockBook);

    const { result } = renderHook(() => useLibraryBook(1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBookById).toHaveBeenCalledWith(1);
    expect(result.current.data).toEqual(mockBook);
  });

  it('does not call api when id is undefined (query disabled)', () => {
    const { result } = renderHook(() => useLibraryBook(undefined), {
      wrapper: createWrapper(),
    });

    expect(api.getBookById).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not call api when id is NaN (query disabled)', () => {
    const { result } = renderHook(() => useLibraryBook(NaN), {
      wrapper: createWrapper(),
    });

    expect(api.getBookById).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('returns data when id is valid', async () => {
    const mockBook = createMockBook({
      id: 42,
      title: 'Another Book',
      status: 'monitored',
      path: '/library/another-book',
      size: 1024000,
      authors: [{ id: 2, name: 'Another Author', slug: 'another-author' }],
      narrators: [],
    });

    vi.mocked(api.getBookById).mockResolvedValue(mockBook);

    const { result } = renderHook(() => useLibraryBook(42), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBookById).toHaveBeenCalledWith(42);
    expect(result.current.data).toEqual(mockBook);
  });
});

describe('useBookFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.getBookFiles when id is valid', async () => {
    const mockFiles: BookFile[] = [
      { name: 'chapter1.mp3', size: 1024000 },
      { name: 'chapter2.mp3', size: 2048000 },
    ];

    vi.mocked(api.getBookFiles).mockResolvedValue(mockFiles);

    const { result } = renderHook(() => useBookFiles(1), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBookFiles).toHaveBeenCalledWith(1);
    expect(result.current.data).toEqual(mockFiles);
  });

  it('does not call api when id is undefined (query disabled)', () => {
    const { result } = renderHook(() => useBookFiles(undefined), {
      wrapper: createWrapper(),
    });

    expect(api.getBookFiles).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not call api when id is NaN (query disabled)', () => {
    const { result } = renderHook(() => useBookFiles(NaN), {
      wrapper: createWrapper(),
    });

    expect(api.getBookFiles).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useBookIdentifiers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.getBookIdentifiers and returns identifiers array', async () => {
    const mockIds: BookIdentifier[] = [
      { asin: 'B001', title: 'Book One', authorName: 'Author A', authorSlug: null },
      { asin: null, title: 'Book Two', authorName: null, authorSlug: null },
    ];
    vi.mocked(api.getBookIdentifiers).mockResolvedValue(mockIds);

    const { result } = renderHook(() => useBookIdentifiers(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBookIdentifiers).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockIds);
  });
});

describe('useBookStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls api.getBookStats and returns stats object', async () => {
    const mockStats: BookStats = {
      counts: { wanted: 5, downloading: 3, imported: 10, failed: 1, missing: 2 },
      authors: ['Author A', 'Author B'],
      series: ['Series A'],
      narrators: ['Narrator A'],
    };
    vi.mocked(api.getBookStats).mockResolvedValue(mockStats);

    const { result } = renderHook(() => useBookStats(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(api.getBookStats).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockStats);
  });
});
