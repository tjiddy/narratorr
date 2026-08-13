import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { ImportListExclusionsSettings } from './ImportListExclusionsSettings';

vi.mock('@/lib/api', () => ({
  api: {
    getImportListExclusions: vi.fn(),
    removeImportListExclusion: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockExclusions = [
  {
    id: 1,
    asin: 'B0ABC12345',
    title: 'The Reckoning',
    authorName: 'Jane Doe',
    authorSlug: 'jane-doe',
    importListId: 5,
    importListName: 'NYT Bestsellers',
    createdAt: '2026-06-15T12:00:00Z',
  },
  {
    id: 2,
    asin: null,
    title: 'A Nameless Source',
    authorName: null,
    authorSlug: null,
    importListId: null,
    importListName: null,
    createdAt: '2026-06-16T12:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportListExclusionsSettings', () => {
  it('shows the empty state when nothing is excluded', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<ImportListExclusionsSettings />);

    await waitFor(() => {
      expect(screen.getByText('No exclusions')).toBeInTheDocument();
    });
  });

  it('renders a row per exclusion with title, author and source list', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: mockExclusions, total: 2 });

    renderWithProviders(<ImportListExclusionsSettings />);

    await waitFor(() => {
      expect(screen.getByText('The Reckoning')).toBeInTheDocument();
    });
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('NYT Bestsellers')).toBeInTheDocument();
    expect(screen.getByText('B0ABC12345')).toBeInTheDocument();
    expect(screen.getByText('A Nameless Source')).toBeInTheDocument();
  });

  it('falls back to a readable source when the list name is missing rather than a blank', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: [mockExclusions[1]!], total: 1 });

    renderWithProviders(<ImportListExclusionsSettings />);

    await waitFor(() => {
      expect(screen.getByText('Unknown list')).toBeInTheDocument();
    });
  });

  it('removes the exclusion with the exact id, invalidates the query and reports success', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: mockExclusions, total: 2 });
    vi.mocked(api.removeImportListExclusion).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderWithProviders(<ImportListExclusionsSettings />, { queryClient });

    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Remove exclusion for The Reckoning'));
    expect(screen.getByText(/Remove the exclusion for "The Reckoning"/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    // react-query hands the mutationFn a second (context) argument; assert the id it was given.
    await waitFor(() => {
      expect(vi.mocked(api.removeImportListExclusion).mock.calls[0]![0]).toBe(1);
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.importListExclusions() });
      expect(toast.success).toHaveBeenCalledWith('Exclusion removed');
    });
  });

  it('surfaces an error toast and leaves the row in place when the removal rejects', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: mockExclusions, total: 2 });
    vi.mocked(api.removeImportListExclusion).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Remove exclusion for The Reckoning'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to remove exclusion');
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByText('The Reckoning')).toBeInTheDocument();
  });

  it('cancelling the confirmation removes nothing', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: mockExclusions, total: 2 });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Remove exclusion for The Reckoning'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.removeImportListExclusion).not.toHaveBeenCalled();
  });

  describe('when the list query fails', () => {
    it('shows a read failure instead of claiming there is nothing excluded', async () => {
      vi.mocked(api.getImportListExclusions).mockRejectedValue(new Error('database is locked'));

      renderWithProviders(<ImportListExclusionsSettings />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load exclusions.')).toBeInTheDocument();
      });
      // The distinction the operator needs: a read failure is not an empty exclusion list.
      expect(screen.queryByText('No exclusions')).not.toBeInTheDocument();
    });

    it('retries the read when the operator clicks Retry, and renders the rows once it succeeds', async () => {
      vi.mocked(api.getImportListExclusions)
        .mockRejectedValueOnce(new Error('database is locked'))
        .mockResolvedValue({ data: mockExclusions, total: 2 });
      const user = userEvent.setup();

      renderWithProviders(<ImportListExclusionsSettings />);
      await waitFor(() => expect(screen.getByText('Failed to load exclusions.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry' }));

      await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());
      expect(screen.queryByText('Failed to load exclusions.')).not.toBeInTheDocument();
      expect(api.getImportListExclusions).toHaveBeenCalledTimes(2);
    });
  });

  it('requests the first page at the shared default limit', async () => {
    vi.mocked(api.getImportListExclusions).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<ImportListExclusionsSettings />);

    await waitFor(() => {
      expect(api.getImportListExclusions).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    });
  });
});
