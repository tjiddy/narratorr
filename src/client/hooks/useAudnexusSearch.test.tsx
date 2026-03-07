import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useAudnexusSearch } from './useAudnexusSearch';

vi.mock('@/lib/api', () => ({
  api: {
    searchMetadata: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockApi = api as unknown as { searchMetadata: ReturnType<typeof vi.fn> };

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useAudnexusSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with empty state', () => {
    const { result } = renderHook(() => useAudnexusSearch(), { wrapper: createWrapper() });

    expect(result.current.searchResults).toEqual([]);
    expect(result.current.hasSearched).toBe(false);
    expect(result.current.searchError).toBeNull();
    expect(result.current.isPending).toBe(false);
  });

  it('accepts initial results', () => {
    const initialResults = [{ title: 'Test Book', authors: [{ name: 'Author' }] }];
    const { result } = renderHook(
      () => useAudnexusSearch({ initialResults: initialResults as never }),
      { wrapper: createWrapper() },
    );

    expect(result.current.searchResults).toEqual(initialResults);
    expect(result.current.hasSearched).toBe(false);
  });

  it('calls api.searchMetadata and sets results on success', async () => {
    const books = [{ title: 'Found Book', authors: [{ name: 'Author' }] }];
    mockApi.searchMetadata.mockResolvedValue({ books, authors: [], series: [] });

    const { result } = renderHook(() => useAudnexusSearch(), { wrapper: createWrapper() });

    act(() => {
      result.current.search('test query');
    });

    await waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    expect(mockApi.searchMetadata).toHaveBeenCalledWith('test query');
    expect(result.current.searchResults).toEqual(books);
    expect(result.current.searchError).toBeNull();
  });

  it('sets searchError on failure and preserves prior results', async () => {
    const books = [{ title: 'Prior Book', authors: [{ name: 'Author' }] }];
    mockApi.searchMetadata.mockResolvedValueOnce({ books, authors: [], series: [] });

    const { result } = renderHook(() => useAudnexusSearch(), { wrapper: createWrapper() });

    // First search succeeds
    act(() => {
      result.current.search('good query');
    });

    await waitFor(() => {
      expect(result.current.searchResults).toEqual(books);
    });

    // Second search fails — prior results preserved
    mockApi.searchMetadata.mockRejectedValueOnce(new Error('API error'));

    act(() => {
      result.current.search('bad query');
    });

    await waitFor(() => {
      expect(result.current.searchError).toBe('Search failed. Please try again.');
    });

    expect(result.current.searchResults).toEqual(books);
    expect(result.current.hasSearched).toBe(true);
  });

  it('ignores empty/whitespace queries', () => {
    const { result } = renderHook(() => useAudnexusSearch(), { wrapper: createWrapper() });

    act(() => {
      result.current.search('   ');
    });

    expect(mockApi.searchMetadata).not.toHaveBeenCalled();
  });

  it('trims query before sending', async () => {
    mockApi.searchMetadata.mockResolvedValue({ books: [], authors: [], series: [] });

    const { result } = renderHook(() => useAudnexusSearch(), { wrapper: createWrapper() });

    act(() => {
      result.current.search('  padded query  ');
    });

    await waitFor(() => {
      expect(result.current.hasSearched).toBe(true);
    });

    expect(mockApi.searchMetadata).toHaveBeenCalledWith('padded query');
  });
});
