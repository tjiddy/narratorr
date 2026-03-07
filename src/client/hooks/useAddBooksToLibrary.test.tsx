import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useAddBooksToLibrary } from './useAddBooksToLibrary';
import { createMockBook } from '@/__tests__/factories';
import type { BookMetadata, BookWithAuthor } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    addBook: vi.fn(),
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

function makeBook(overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    title: 'Test Book',
    authors: [{ name: 'Test Author' }],
    ...overrides,
  };
}

function makeLibraryBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({
    title: 'Test Book',
    author: { id: 1, name: 'Test Author', slug: 'test-author' },
    ...overrides,
  });
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

describe('useAddBooksToLibrary', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
  });

  describe('duplicate detection — isBookAdded', () => {
    it('detects book already in library by asin match', () => {
      const libraryBooks = [makeLibraryBook({ asin: 'B001' })];
      const book = makeBook({ asin: 'B001', title: 'Different Title', authors: [{ name: 'Different Author' }] });

      const { result } = renderHook(
        () => useAddBooksToLibrary(libraryBooks),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.isBookAdded(book)).toBe(true);
    });

    it('detects book already in library by title + author (case-insensitive)', () => {
      const libraryBooks = [makeLibraryBook({ title: 'My Book', asin: undefined, author: { id: 1, name: 'John Smith', slug: 'john-smith' } })];
      const book = makeBook({ title: 'my book', authors: [{ name: 'john smith' }], asin: undefined });

      const { result } = renderHook(
        () => useAddBooksToLibrary(libraryBooks),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.isBookAdded(book)).toBe(true);
    });

    it('title match alone is NOT sufficient', () => {
      const libraryBooks = [makeLibraryBook({ title: 'My Book', asin: undefined, author: { id: 1, name: 'John Smith', slug: 'john-smith' } })];
      const book = makeBook({ title: 'My Book', authors: [{ name: 'Different Author' }], asin: undefined });

      const { result } = renderHook(
        () => useAddBooksToLibrary(libraryBooks),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.isBookAdded(book)).toBe(false);
    });

    it('reports not added when library is empty', () => {
      const book = makeBook({ asin: 'B001' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.isBookAdded(book)).toBe(false);
    });

    it('reports not added when libraryBooks is undefined', () => {
      const book = makeBook({ asin: 'B001' });

      const { result } = renderHook(
        () => useAddBooksToLibrary(undefined),
        { wrapper: createWrapper(queryClient) },
      );

      expect(result.current.isBookAdded(book)).toBe(false);
    });
  });

  describe('addBook', () => {
    it('calls api.addBook, invalidates queries, and shows success toast', async () => {
      vi.mocked(api.addBook).mockResolvedValue({} as BookWithAuthor);
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      const book = makeBook({ asin: 'B002', title: 'New Book' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Added 'New Book' to library");
      });

      expect(api.addBook).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
    });

    it('tracks adding state via addingAsins keyed on asin', async () => {
      let resolveAdd: (v: BookWithAuthor) => void;
      vi.mocked(api.addBook).mockImplementation(() => new Promise((r) => { resolveAdd = r; }));

      const book = makeBook({ asin: 'B003', title: 'Pending Book' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      // mutationFn sets addingAsins synchronously before the await
      await waitFor(() => {
        expect(result.current.addingAsins.has('B003')).toBe(true);
      });

      await act(async () => {
        resolveAdd!({} as BookWithAuthor);
      });

      // After success, removed from adding
      await waitFor(() => {
        expect(result.current.addingAsins.has('B003')).toBe(false);
      });
    });

    it('uses title as key when asin is absent', async () => {
      let resolveAdd: (v: BookWithAuthor) => void;
      vi.mocked(api.addBook).mockImplementation(() => new Promise((r) => { resolveAdd = r; }));

      const book = makeBook({ asin: undefined, title: 'No ASIN Book' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      await waitFor(() => {
        expect(result.current.addingAsins.has('No ASIN Book')).toBe(true);
      });

      await act(async () => {
        resolveAdd!({} as BookWithAuthor);
      });
    });

    it('marks book as added after success (in-session tracking)', async () => {
      vi.mocked(api.addBook).mockResolvedValue({} as BookWithAuthor);
      const book = makeBook({ asin: 'B004', title: 'Added Book' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      await waitFor(() => {
        expect(result.current.isBookAdded(book)).toBe(true);
      });
    });

    it('does not add book that is already added', async () => {
      const libraryBooks = [makeLibraryBook({ asin: 'B001' })];
      const book = makeBook({ asin: 'B001' });

      const { result } = renderHook(
        () => useAddBooksToLibrary(libraryBooks),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      expect(api.addBook).not.toHaveBeenCalled();
    });

    it('shows error toast and cleans up adding state on failure', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new Error('Network error'));
      const book = makeBook({ asin: 'B005', title: 'Failing Book' });

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith("Failed to add 'Failing Book': Network error");
      });

      // Key should be removed from addingAsins
      expect(result.current.addingAsins.has('B005')).toBe(false);
    });
  });

  describe('quality defaults', () => {
    it('passes qualityDefaults overrides to api.addBook', async () => {
      vi.mocked(api.addBook).mockResolvedValue({} as BookWithAuthor);
      const book = makeBook({ asin: 'B099', title: 'Quality Book' });
      const defaults = { searchImmediately: true, monitorForUpgrades: true };

      const { result } = renderHook(
        () => useAddBooksToLibrary([], defaults),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book);
      });

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(
          expect.objectContaining({
            searchImmediately: true,
            monitorForUpgrades: true,
          }),
        );
      });
    });

    it('allows per-book overrides to override hook defaults', async () => {
      vi.mocked(api.addBook).mockResolvedValue({} as BookWithAuthor);
      const book = makeBook({ asin: 'B100', title: 'Override Book' });
      const hookDefaults = { searchImmediately: false, monitorForUpgrades: false };
      const perBookOverrides = { searchImmediately: true, monitorForUpgrades: true };

      const { result } = renderHook(
        () => useAddBooksToLibrary([], hookDefaults),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addBook(book, perBookOverrides);
      });

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledWith(
          expect.objectContaining({
            searchImmediately: true,
            monitorForUpgrades: true,
          }),
        );
      });
    });
  });

  describe('addAllInSeries', () => {
    it('filters out already-added books and adds the rest', async () => {
      vi.mocked(api.addBook).mockResolvedValue({} as BookWithAuthor);

      const libraryBooks = [makeLibraryBook({ asin: 'B001' })];
      const books = [
        makeBook({ asin: 'B001', title: 'Already In Library' }),
        makeBook({ asin: 'B006', title: 'New Series Book 1' }),
        makeBook({ asin: 'B007', title: 'New Series Book 2' }),
      ];

      const { result } = renderHook(
        () => useAddBooksToLibrary(libraryBooks),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addAllInSeries(books);
      });

      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledTimes(2);
      });
    });

    it('continues adding remaining books when one mutation fails — no rollback', async () => {
      // Second call fails, first and third should still succeed
      vi.mocked(api.addBook)
        .mockResolvedValueOnce({} as BookWithAuthor)   // Book 1 succeeds
        .mockRejectedValueOnce(new Error('DB error'))  // Book 2 fails
        .mockResolvedValueOnce({} as BookWithAuthor);  // Book 3 succeeds

      const books = [
        makeBook({ asin: 'B010', title: 'Series Book 1' }),
        makeBook({ asin: 'B011', title: 'Series Book 2' }),
        makeBook({ asin: 'B012', title: 'Series Book 3' }),
      ];

      const { result } = renderHook(
        () => useAddBooksToLibrary([]),
        { wrapper: createWrapper(queryClient) },
      );

      act(() => {
        result.current.addAllInSeries(books);
      });

      // All three mutations fired — no early exit on failure
      await waitFor(() => {
        expect(api.addBook).toHaveBeenCalledTimes(3);
      });

      // First and third succeed
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith("Added 'Series Book 1' to library");
        expect(toast.success).toHaveBeenCalledWith("Added 'Series Book 3' to library");
      });

      // Second shows error toast
      expect(toast.error).toHaveBeenCalledWith("Failed to add 'Series Book 2': DB error");
    });
  });
});
