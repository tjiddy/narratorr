import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLibrarySearch } from './useLibrarySearch';
import { createMockBook, createMockAuthor } from '@/__tests__/factories';
import type { BookWithAuthor } from '@/lib/api';

const mockBooks: BookWithAuthor[] = [
  createMockBook({
    id: 1,
    genres: ['Fantasy', 'Epic Fantasy'],
    status: 'imported',
  }),
  createMockBook({
    id: 2,
    title: 'Words of Radiance',
    genres: ['Fantasy'],
    status: 'wanted',
    createdAt: '2024-01-02',
    updatedAt: '2024-01-02',
  }),
  createMockBook({
    id: 3,
    title: 'Dune',
    narrator: 'Scott Brick',
    seriesName: 'Dune Saga',
    genres: ['Science Fiction'],
    status: 'imported',
    createdAt: '2024-01-03',
    updatedAt: '2024-01-03',
    author: createMockAuthor({ id: 2, name: 'Frank Herbert', slug: 'frank-herbert' }),
  }),
];

describe('useLibrarySearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all books when query is empty', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    expect(result.current.results).toHaveLength(3);
    expect(result.current.isSearching).toBe(false);
  });

  it('fuzzy matches on title', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('way of kings');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.isSearching).toBe(true);
    expect(result.current.results.length).toBeGreaterThanOrEqual(1);
    expect(result.current.results[0].title).toBe('The Way of Kings');
  });

  it('fuzzy matches on author name', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('sanderson');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBe(2);
    expect(result.current.results.every((b) => b.author?.name === 'Brandon Sanderson')).toBe(true);
  });

  it('fuzzy matches on series name', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('stormlight');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBe(2);
    expect(result.current.results.every((b) => b.seriesName === 'The Stormlight Archive')).toBe(true);
  });

  it('fuzzy matches on narrator', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('kramer');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBe(2);
    expect(result.current.results.every((b) => b.narrator === 'Michael Kramer')).toBe(true);
  });

  it('fuzzy matches on genres', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('science fiction');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBeGreaterThanOrEqual(1);
    expect(result.current.results[0].title).toBe('Dune');
  });

  it('handles partial matches', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('sand');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty results when nothing matches', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('xyznonexistent');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results).toHaveLength(0);
    expect(result.current.isSearching).toBe(true);
  });

  it('clears search and returns all books', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('dune');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBe(1);

    act(() => {
      result.current.clearQuery();
    });

    expect(result.current.query).toBe('');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.results).toHaveLength(3);
  });

  it('debounces the query', () => {
    const { result } = renderHook(() => useLibrarySearch(mockBooks));

    act(() => {
      result.current.setQuery('dune');
    });

    // Before debounce fires, should still show all books
    expect(result.current.results).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    // After debounce, should show filtered results
    expect(result.current.results.length).toBe(1);
  });

  it('handles empty books array', () => {
    const { result } = renderHook(() => useLibrarySearch([]));

    expect(result.current.results).toHaveLength(0);

    act(() => {
      result.current.setQuery('test');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results).toHaveLength(0);
  });

  it('handles books with null genres', () => {
    const booksWithNullGenres: BookWithAuthor[] = [
      { ...mockBooks[0], genres: null },
    ];

    const { result } = renderHook(() => useLibrarySearch(booksWithNullGenres));

    act(() => {
      result.current.setQuery('way of kings');
      vi.advanceTimersByTime(300);
    });

    expect(result.current.results.length).toBe(1);
  });
});
