import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderHook, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BulkActionToolbar } from './BulkActionToolbar';
import { useLibraryBulkActions } from './useLibraryBulkActions';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor, SingleBookSearchResult } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    deleteBook: vi.fn(),
    searchBook: vi.fn(),
    updateBook: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

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

function renderToolbar(overrides: Partial<Parameters<typeof BulkActionToolbar>[0]> = {}) {
  const queryClient = createQueryClient();
  const props = {
    selectedCount: 3,
    onDelete: vi.fn(),
    isDeleting: false,
    onSearch: vi.fn(),
    isSearching: false,
    onSetStatus: vi.fn(),
    isSettingStatus: false,
    hasPath: true,
    ...overrides,
  };
  const result = render(
    <QueryClientProvider client={queryClient}>
      <BulkActionToolbar {...props} />
    </QueryClientProvider>,
  );
  return { props, result };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkActionToolbar', () => {
  it('shows delete, search, and set status buttons when books are selected', () => {
    renderToolbar({ selectedCount: 2 });
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Set Status')).toBeInTheDocument();
  });

  it('hides when no books are selected', () => {
    const { result } = renderToolbar({ selectedCount: 0 });
    expect(result.container.innerHTML).toBe('');
  });

  it('displays correct count of selected books', () => {
    renderToolbar({ selectedCount: 7 });
    expect(screen.getByText('7 selected')).toBeInTheDocument();
  });
});

describe('bulk delete', () => {
  it('shows confirmation modal with selected book count', async () => {
    const user = userEvent.setup();
    renderToolbar({ selectedCount: 5 });

    await user.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete 5 selected books? This will cancel any active downloads.')).toBeInTheDocument();
  });

  it('modal includes delete-files checkbox', async () => {
    const user = userEvent.setup();
    renderToolbar({ selectedCount: 2, hasPath: true });

    await user.click(screen.getByText('Delete'));
    expect(screen.getByLabelText('Delete files from disk')).toBeInTheDocument();
  });

  it('on confirm, fans out DELETE calls for each selected book', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'wanted' }),
      createMockBook({ id: 3, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    // Select all books
    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(api.deleteBook).toHaveBeenCalledTimes(3);
    });

    expect(api.deleteBook).toHaveBeenCalledWith(1, undefined);
    expect(api.deleteBook).toHaveBeenCalledWith(2, undefined);
    expect(api.deleteBook).toHaveBeenCalledWith(3, undefined);
  });

  it('all-success shows toast "Deleted N books" and clears selection', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Deleted 2 books');
    });

    expect(result.current.selectedIds.size).toBe(0);
  });

  it('partial failure shows toast "Deleted X of N books — Y failed"', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.deleteBook)
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('Not found'))
      .mockResolvedValueOnce({ success: true });

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
      createMockBook({ id: 3 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Deleted 2 of 3 books — 1 failed');
    });
  });

  it('complete failure shows error toast with first error message', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.deleteBook)
      .mockRejectedValueOnce(new Error('Server error'))
      .mockRejectedValueOnce(new Error('Server error'));

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('All deletions failed');
    });
  });

  it('invalidates queryKeys.books() after completion', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });

    const books = [createMockBook({ id: 1 })];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    await act(async () => {
      result.current.bulkDeleteMutation.mutate({ deleteFiles: false });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
    });
  });
});

describe('bulk search', () => {
  it('fans out POST /api/books/:id/search for each selected wanted book', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook).mockResolvedValue({ result: 'grabbed', title: 'Test' });

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(api.searchBook).toHaveBeenCalledTimes(2);
    });

    expect(api.searchBook).toHaveBeenCalledWith(1);
    expect(api.searchBook).toHaveBeenCalledWith(2);
  });

  it('skips non-wanted books and folds them into the skipped count in toast', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook).mockResolvedValue({ result: 'grabbed', title: 'Test' });

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'imported' }),
      createMockBook({ id: 3, status: 'imported' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(api.searchBook).toHaveBeenCalledTimes(1);
      expect(api.searchBook).toHaveBeenCalledWith(1);
    });

    // Non-wanted books (2) are folded into the single "skipped" count per issue contract
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Searched 1 book, 1 grabbed, 2 skipped');
    });
  });

  it('all non-wanted selection shows warning toast "No wanted books selected"', async () => {
    const queryClient = createQueryClient();

    const books = [
      createMockBook({ id: 1, status: 'imported' }),
      createMockBook({ id: 2, status: 'imported' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('No wanted books selected');
    });

    expect(api.searchBook).not.toHaveBeenCalled();
  });

  it('counts grabbed results from result: grabbed responses', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook)
      .mockResolvedValueOnce({ result: 'grabbed', title: 'Book 1' })
      .mockResolvedValueOnce({ result: 'grabbed', title: 'Book 2' });

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2 grabbed'));
    });
  });

  it('counts skipped results from result: skipped responses', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook)
      .mockResolvedValueOnce({ result: 'skipped', reason: 'quality cutoff met' })
      .mockResolvedValueOnce({ result: 'skipped', reason: 'quality cutoff met' });

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('2 skipped'));
    });
  });

  it('counts no_results as failed', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook)
      .mockResolvedValueOnce({ result: 'no_results' } as SingleBookSearchResult);

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('1 failed'));
    });
  });

  it('shows toast "Searched N: G grabbed, S skipped, F failed"', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.searchBook)
      .mockResolvedValueOnce({ result: 'grabbed', title: 'Book 1' })
      .mockResolvedValueOnce({ result: 'skipped', reason: 'cutoff' })
      .mockResolvedValueOnce({ result: 'no_results' } as SingleBookSearchResult);

    const books = [
      createMockBook({ id: 1, status: 'wanted' }),
      createMockBook({ id: 2, status: 'wanted' }),
      createMockBook({ id: 3, status: 'wanted' }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Searched 3 books, 1 grabbed, 1 skipped, 1 failed');
    });
  });

  it('invalidates queryKeys.books() and queryKeys.activity() after completion', async () => {
    const queryClient = createQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    vi.mocked(api.searchBook).mockResolvedValue({ result: 'grabbed', title: 'Test' });

    const books = [createMockBook({ id: 1, status: 'wanted' })];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1]));
    });

    await act(async () => {
      result.current.bulkSearchMutation.mutate();
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['books'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['activity'] });
    });
  });
});

describe('bulk set status', () => {
  it('dropdown shows Wanted and Owned labels', async () => {
    const user = userEvent.setup();
    renderToolbar({ selectedCount: 2 });

    await user.click(screen.getByText('Set Status'));

    expect(screen.getByText('Wanted')).toBeInTheDocument();
    expect(screen.getByText('Owned')).toBeInTheDocument();
  });

  it('Owned sends status: imported to API', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({ selectedCount: 2 });

    await user.click(screen.getByText('Set Status'));
    await user.click(screen.getByText('Owned'));

    expect(props.onSetStatus).toHaveBeenCalledWith('imported', 'Owned');
  });

  it('Wanted sends status: wanted to API', async () => {
    const user = userEvent.setup();
    const { props } = renderToolbar({ selectedCount: 2 });

    await user.click(screen.getByText('Set Status'));
    await user.click(screen.getByText('Wanted'));

    expect(props.onSetStatus).toHaveBeenCalledWith('wanted', 'Wanted');
  });

  it('fans out PUT calls for each selected book', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.updateBook).mockResolvedValue({} as BookWithAuthor);

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
      createMockBook({ id: 3 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkSetStatusMutation.mutate({ status: 'wanted', label: 'Wanted' });
    });

    await waitFor(() => {
      expect(api.updateBook).toHaveBeenCalledTimes(3);
    });

    expect(api.updateBook).toHaveBeenCalledWith(1, { status: 'wanted' });
    expect(api.updateBook).toHaveBeenCalledWith(2, { status: 'wanted' });
    expect(api.updateBook).toHaveBeenCalledWith(3, { status: 'wanted' });
  });

  it('shows toast "Updated N of M books to [label]"', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.updateBook)
      .mockResolvedValueOnce({} as BookWithAuthor)
      .mockResolvedValueOnce({} as BookWithAuthor)
      .mockRejectedValueOnce(new Error('fail'));

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
      createMockBook({ id: 3 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2, 3]));
    });

    await act(async () => {
      result.current.bulkSetStatusMutation.mutate({ status: 'imported', label: 'Owned' });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Updated 2 of 3 books to Owned');
    });
  });

  it('clears selection after completion', async () => {
    const queryClient = createQueryClient();
    vi.mocked(api.updateBook).mockResolvedValue({} as BookWithAuthor);

    const books = [
      createMockBook({ id: 1 }),
      createMockBook({ id: 2 }),
    ];

    const { result } = renderHook(
      () => useLibraryBulkActions(books),
      { wrapper: createWrapper(queryClient) },
    );

    act(() => {
      result.current.setSelectedIds(new Set([1, 2]));
    });

    expect(result.current.selectedIds.size).toBe(2);

    await act(async () => {
      result.current.bulkSetStatusMutation.mutate({ status: 'wanted', label: 'Wanted' });
    });

    await waitFor(() => {
      expect(result.current.selectedIds.size).toBe(0);
    });
  });
});
