import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMetadataSearch, useAuthor, useAuthorBooks, useBook } from '@/hooks/useMetadata';

vi.mock('@/lib/api', () => ({
  api: {
    searchMetadata: vi.fn(),
    getAuthor: vi.fn(),
    getAuthorBooks: vi.fn(),
    getBook: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useMetadataSearch', () => {
  it('is disabled when query is too short', () => {
    const { result } = renderHook(() => useMetadataSearch('a'), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('is enabled when query has 2+ characters', async () => {
    const { api } = await import('@/lib/api');
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      books: [],
      authors: [],
      series: [],
    });

    const { result } = renderHook(() => useMetadataSearch('ab'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.searchMetadata).toHaveBeenCalledWith('ab');
  });

  it('is disabled for empty query', () => {
    const { result } = renderHook(() => useMetadataSearch(''), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useAuthor', () => {
  it('is disabled when asin is undefined', () => {
    const { result } = renderHook(() => useAuthor(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches when asin is provided', async () => {
    const { api } = await import('@/lib/api');
    const mockAuthor = { name: 'Brandon Sanderson', asin: 'B001' };
    (api.getAuthor as ReturnType<typeof vi.fn>).mockResolvedValue(mockAuthor);

    const { result } = renderHook(() => useAuthor('B001'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockAuthor);
  });
});

describe('useAuthorBooks', () => {
  it('is disabled when asin is undefined', () => {
    const { result } = renderHook(() => useAuthorBooks(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches when asin is provided', async () => {
    const { api } = await import('@/lib/api');
    const mockBooks = [{ title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] }];
    (api.getAuthorBooks as ReturnType<typeof vi.fn>).mockResolvedValue(mockBooks);

    const { result } = renderHook(() => useAuthorBooks('B001'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockBooks);
  });
});

describe('useBook', () => {
  it('is disabled when asin is undefined', () => {
    const { result } = renderHook(() => useBook(undefined), {
      wrapper: createWrapper(),
    });
    expect(result.current.fetchStatus).toBe('idle');
  });

  it('fetches when asin is provided', async () => {
    const { api } = await import('@/lib/api');
    const mockBook = { title: 'The Way of Kings', authors: [{ name: 'Brandon Sanderson' }] };
    (api.getBook as ReturnType<typeof vi.fn>).mockResolvedValue(mockBook);

    const { result } = renderHook(() => useBook('B002'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockBook);
  });
});
