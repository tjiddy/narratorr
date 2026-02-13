import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useLibrary, useLibraryBook } from './useLibrary';
import type { BookWithAuthor } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    getBookById: vi.fn(),
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
    const mockBooks: BookWithAuthor[] = [
      {
        id: 1,
        title: 'Test Book',
        authorId: 1,
        narrator: 'Test Narrator',
        description: 'A test book',
        coverUrl: 'https://example.com/cover.jpg',
        asin: 'B001',
        isbn: null,
        seriesName: null,
        seriesPosition: null,
        duration: 3600,
        publishedDate: '2023-01-01',
        genres: ['Fiction'],
        status: 'wanted',
        path: null,
        size: null,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        author: {
          id: 1,
          name: 'Test Author',
          slug: 'test-author',
          asin: 'A001',
          imageUrl: null,
          bio: null,
        },
      },
    ];

    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

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
    const mockBook: BookWithAuthor = {
      id: 1,
      title: 'Test Book',
      authorId: 1,
      narrator: 'Test Narrator',
      description: 'A test book',
      coverUrl: 'https://example.com/cover.jpg',
      asin: 'B001',
      isbn: null,
      seriesName: null,
      seriesPosition: null,
      duration: 3600,
      publishedDate: '2023-01-01',
      genres: ['Fiction'],
      status: 'wanted',
      path: null,
      size: null,
      createdAt: '2023-01-01T00:00:00Z',
      updatedAt: '2023-01-01T00:00:00Z',
      author: {
        id: 1,
        name: 'Test Author',
        slug: 'test-author',
        asin: 'A001',
        imageUrl: null,
        bio: null,
      },
    };

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
    const mockBook: BookWithAuthor = {
      id: 42,
      title: 'Another Book',
      authorId: 2,
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
      status: 'monitored',
      path: '/library/another-book',
      size: 1024000,
      createdAt: '2023-02-01T00:00:00Z',
      updatedAt: '2023-02-01T00:00:00Z',
      author: {
        id: 2,
        name: 'Another Author',
        slug: 'another-author',
        asin: null,
        imageUrl: null,
        bio: null,
      },
    };

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
