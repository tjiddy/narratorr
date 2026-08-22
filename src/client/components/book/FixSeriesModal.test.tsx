import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FixSeriesModal } from './FixSeriesModal';
import { queryKeys } from '@/lib/queryKeys';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      searchBookSeries: vi.fn(),
      bindBookSeries: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';

function renderModal(currentSeriesName = 'The Earthsea Cycle') {
  const onClose = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FixSeriesModal bookId={1} currentSeriesName={currentSeriesName} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, queryClient };
}

const quartet = { id: 4242, name: 'The Earthsea Quartet', slug: 'q', authorName: 'Ursula K. Le Guin', booksCount: 4, imageUrl: null };

describe('FixSeriesModal', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('auto-searches with the current series name and renders the returned candidates', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [quartet] });
    renderModal();

    expect(await screen.findByText('The Earthsea Quartet')).toBeInTheDocument();
    await waitFor(() => expect(api.searchBookSeries).toHaveBeenCalledWith(1, 'The Earthsea Cycle'));
  });

  it('submits a new query and searches with it', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [] });
    const user = userEvent.setup();
    renderModal();

    const input = await screen.findByTestId('fix-series-search-input');
    await user.clear(input);
    await user.type(input, 'earthsea');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(api.searchBookSeries).toHaveBeenCalledWith(1, 'earthsea'));
  });

  it('selecting a candidate fires the bind mutation with its id and closes on success', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [quartet] });
    vi.mocked(api.bindBookSeries).mockResolvedValue({
      series: { id: 9, name: 'The Earthsea Quartet', hardcoverSeriesId: 4242, seriesAuthor: 'Ursula K. Le Guin', lastFetchedAt: null, members: [] },
    });
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.click(await screen.findByTestId('fix-series-candidate'));

    await waitFor(() => expect(api.bindBookSeries).toHaveBeenCalledWith(1, 4242));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an empty-state message when the search returns no candidates', async () => {
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [] });
    renderModal();
    expect(await screen.findByText(/No matching Hardcover series found/i)).toBeInTheDocument();
  });
});

describe('FixSeriesModal — the spinner gates on no-data-yet, not on any fetch (#2592)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  /** The DOM lags the cache by a macrotask, and a bare negative assertion does not retry. */
  async function settleNotify() {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it('keeps the rendered candidates during a background refetch of the same key', async () => {
    vi.mocked(api.searchBookSeries)
      .mockResolvedValueOnce({ candidates: [quartet] })
      .mockReturnValue(new Promise(() => { /* held open for the whole assertion window */ }));
    const { queryClient } = renderModal();
    expect(await screen.findByText('The Earthsea Quartet')).toBeInTheDocument();

    // Not awaited: invalidateQueries resolves with the refetch, which is held open on purpose.
    const searchKey = queryKeys.bookSeriesSearch(1, 'The Earthsea Cycle');
    act(() => { void queryClient.invalidateQueries({ queryKey: searchKey }); });

    // The refetch is genuinely in flight — without this pin the assertions below are satisfied by
    // a component that simply never re-rendered.
    await waitFor(() => expect(queryClient.getQueryState(searchKey)?.fetchStatus).toBe('fetching'));
    await settleNotify();
    expect(queryClient.getQueryState(searchKey)?.fetchStatus).toBe('fetching');

    expect(screen.getByText('The Earthsea Quartet')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).toBeNull();
  });

  it('shows the spinner and drops the old rows while a genuinely new query is pending', async () => {
    vi.mocked(api.searchBookSeries)
      .mockResolvedValueOnce({ candidates: [quartet] })
      .mockReturnValue(new Promise(() => { /* held open for the whole assertion window */ }));
    const user = userEvent.setup();
    const { queryClient } = renderModal();
    expect(await screen.findByText('The Earthsea Quartet')).toBeInTheDocument();

    const input = screen.getByTestId('fix-series-search-input');
    await user.clear(input);
    await user.type(input, 'Tehanu');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    const newKey = queryKeys.bookSeriesSearch(1, 'Tehanu');
    await waitFor(() => expect(queryClient.getQueryState(newKey)?.status).toBe('pending'));
    await settleNotify();

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.queryByText('The Earthsea Quartet')).toBeNull();
  });

  it('renders no spinner and searches nothing when there is no current series name', async () => {
    const { queryClient } = renderModal('');
    await settleNotify();

    // The one state where `isPending` stays true forever: disabled means pending + idle.
    const disabledKey = queryKeys.bookSeriesSearch(1, '');
    expect(queryClient.getQueryState(disabledKey)?.fetchStatus ?? 'idle').toBe('idle');
    expect(api.searchBookSeries).not.toHaveBeenCalled();
    expect(screen.queryByTestId('loading-spinner')).toBeNull();
    expect(screen.getByTestId('fix-series-candidates')).toBeEmptyDOMElement();
  });

  it('still surfaces the error branch when a fresh query rejects', async () => {
    vi.mocked(api.searchBookSeries).mockRejectedValue(new Error('hardcover down'));
    const { queryClient } = renderModal();

    await waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.bookSeriesSearch(1, 'The Earthsea Cycle'))?.status).toBe('error'),
    );
    expect(await screen.findByText('Search failed. Try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).toBeNull();
  });
});
describe('height-capped card layout', () => {
  it('constrains the dialog wrapper and lets the body scroll within the card', async () => {
    renderModal();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveClass('flex', 'flex-col', 'min-h-0', 'flex-1');
    const scrollBody = dialog.querySelector('.overflow-y-auto');
    expect(scrollBody).not.toBeNull();
    expect(scrollBody).toHaveClass('flex-1', 'min-h-0');
  });
});
