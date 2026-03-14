import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useLibrary, useLibraryBook, useBookFiles } from './useLibrary';
import { createMockBook } from '@/__tests__/factories';
import type { BookFile } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    getBookById: vi.fn(),
    getBookFiles: vi.fn(),
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
    expect(result.current.data).toEqual(mockBooks);
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
      authorId: 2,
      narrator: null,
      status: 'monitored',
      path: '/library/another-book',
      size: 1024000,
      author: { id: 2, name: 'Another Author', slug: 'another-author' },
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
