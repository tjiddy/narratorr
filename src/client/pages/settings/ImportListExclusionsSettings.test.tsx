import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
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
    kind: 'deleted' as const,
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
    kind: 'deleted' as const,
    createdAt: '2026-06-16T12:00:00Z',
  },
];

const mockAdded = [
  {
    id: 10,
    asin: null,
    title: 'General Thinking Concepts',
    authorName: 'Shane Parrish',
    authorSlug: 'shane-parrish',
    importListId: 7,
    importListName: 'Hardcover - Self Help',
    kind: 'added' as const,
    createdAt: '2026-08-13T12:00:00Z',
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
      expect(screen.getByText('No deleted books')).toBeInTheDocument();
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
      expect(screen.queryByText('No deleted books')).not.toBeInTheDocument();
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
      expect(api.getImportListExclusions).toHaveBeenCalledWith({ limit: 100, offset: 0, kind: 'deleted' });
    });
  });
});

type Page = { data: typeof mockExclusions; total: number };

/** Answer per kind, so a request can be held for one tab while the other stays settled. */
function byKind(answers: {
  deleted?: Page | Promise<Page> | (() => Promise<Page>);
  added?: Page | Promise<Page> | (() => Promise<Page>);
}): void {
  vi.mocked(api.getImportListExclusions).mockImplementation((params) => {
    const answer = params?.kind === 'added' ? answers.added : answers.deleted;
    if (typeof answer === 'function') return answer();
    return Promise.resolve(answer as Page) as Promise<Page>;
  });
}

const addedTab = () => screen.getByRole('tab', { name: 'Added by a list' });
const deletedTab = () => screen.getByRole('tab', { name: 'Deleted' });

describe('ImportListExclusionsSettings — the kind tabs (#2530)', () => {
  it('sends an explicit kind for each tab and keeps the two views apart', async () => {
    byKind({
      deleted: { data: mockExclusions, total: 2 },
      added: { data: mockAdded as unknown as typeof mockExclusions, total: 1 },
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(addedTab());

    await waitFor(() => expect(screen.getByText('General Thinking Concepts')).toBeInTheDocument());
    expect(screen.queryByText('The Reckoning')).not.toBeInTheDocument();
    expect(api.getImportListExclusions).toHaveBeenCalledWith({ limit: 100, offset: 0, kind: 'added' });
  });

  it('never renders the previous kind while the newly selected kind is still in flight', async () => {
    let resolveAdded!: (page: Page) => void;
    const heldAdded = new Promise<Page>((resolve) => { resolveAdded = resolve; });
    byKind({ deleted: { data: mockExclusions, total: 250 }, added: heldAdded });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    renderWithProviders(<ImportListExclusionsSettings />, { queryClient });
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());
    expect(screen.getByText(/of 250/)).toBeInTheDocument();

    await user.click(addedTab());

    // Observation point is the held query's own state, not a bare tick: a loading assertion is
    // true at t=0 under the broken implementation too, so the absent-stale half below is what
    // actually carries this test.
    await waitFor(() => {
      const key = queryKeys.importListExclusions({ limit: 100, offset: 0, kind: 'added' });
      expect(queryClient.getQueryState(key)?.status).toBe('pending');
    });
    expect(screen.queryByText('The Reckoning')).not.toBeInTheDocument();
    expect(screen.queryByText('A Nameless Source')).not.toBeInTheDocument();
    expect(screen.queryByText(/of 250/)).not.toBeInTheDocument();
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

    await act(async () => {
      resolveAdded({ data: mockAdded as unknown as typeof mockExclusions, total: 1 });
    });

    await waitFor(() => expect(screen.getByText('General Thinking Concepts')).toBeInTheDocument());
    expect(screen.queryByText('The Reckoning')).not.toBeInTheDocument();
  });

  it('keeps the previous page on screen while the NEXT page of the same kind loads', async () => {
    // The counter-test: deleting `placeholderData` outright satisfies the case above while
    // silently regressing page-to-page navigation, and nothing else would catch it.
    let resolvePage2!: (page: Page) => void;
    const heldPage2 = new Promise<Page>((resolve) => { resolvePage2 = resolve; });
    const page2 = [{ ...mockExclusions[0]!, id: 3, title: 'Page Two Row' }];
    vi.mocked(api.getImportListExclusions)
      .mockResolvedValueOnce({ data: mockExclusions, total: 250 })
      .mockReturnValueOnce(heldPage2);
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /next page/i }));

    expect(screen.getByText('The Reckoning')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();

    await act(async () => { resolvePage2({ data: page2, total: 250 }); });

    await waitFor(() => expect(screen.getByText('Page Two Row')).toBeInTheDocument());
    expect(screen.queryByText('The Reckoning')).not.toBeInTheDocument();
  });

  it('renders per-kind empty copy', async () => {
    byKind({ deleted: { data: [], total: 0 }, added: { data: [], total: 0 } });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('No deleted books')).toBeInTheDocument());

    await user.click(addedTab());

    await waitFor(() => expect(screen.getByText('No books added by a list')).toBeInTheDocument());
    expect(screen.queryByText('No deleted books')).not.toBeInTheDocument();
  });

  it('shows the error state with no prior-kind rows behind it when the kind switch fails', async () => {
    byKind({
      deleted: { data: mockExclusions, total: 2 },
      added: () => Promise.reject(new Error('database is locked')),
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(addedTab());

    await waitFor(() => expect(screen.getByText('Failed to load exclusions.')).toBeInTheDocument());
    expect(screen.queryByText('The Reckoning')).not.toBeInTheDocument();
    expect(screen.queryByText('No books added by a list')).not.toBeInTheDocument();
  });

  it('words the remove confirmation for the kind of the row being removed', async () => {
    byKind({
      deleted: { data: mockExclusions, total: 2 },
      added: { data: mockAdded as unknown as typeof mockExclusions, total: 1 },
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Remove exclusion for The Reckoning'));
    expect(screen.getByText(/An import list may add it again on its next sync\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(addedTab());
    await waitFor(() => expect(screen.getByText('General Thinking Concepts')).toBeInTheDocument());

    await user.click(screen.getByLabelText('Remove exclusion for General Thinking Concepts'));
    expect(screen.getByText(/The import list will treat this book as new/)).toBeInTheDocument();
  });

  it('clamps an out-of-range page when the newly selected kind is shorter', async () => {
    byKind({
      deleted: { data: mockExclusions, total: 250 },
      added: { data: mockAdded as unknown as typeof mockExclusions, total: 1 },
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /next page/i }));
    await user.click(screen.getByRole('button', { name: /next page/i }));
    await waitFor(() => expect(screen.getByText(/Page 3 of 3/)).toBeInTheDocument());

    await user.click(addedTab());

    await waitFor(() => expect(screen.getByText('General Thinking Concepts')).toBeInTheDocument());
    // One page of results, so the pagination bar is gone entirely rather than showing an empty page 3.
    expect(screen.queryByText(/Page 3/)).not.toBeInTheDocument();
    expect(api.getImportListExclusions).toHaveBeenLastCalledWith({ limit: 100, offset: 0, kind: 'added' });
  });

  it('returns to the deleted view with its own rows', async () => {
    byKind({
      deleted: { data: mockExclusions, total: 2 },
      added: { data: mockAdded as unknown as typeof mockExclusions, total: 1 },
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportListExclusionsSettings />);
    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());

    await user.click(addedTab());
    await waitFor(() => expect(screen.getByText('General Thinking Concepts')).toBeInTheDocument());

    await user.click(deletedTab());

    await waitFor(() => expect(screen.getByText('The Reckoning')).toBeInTheDocument());
    expect(screen.queryByText('General Thinking Concepts')).not.toBeInTheDocument();
  });
});
