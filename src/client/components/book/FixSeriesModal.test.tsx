import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FixSeriesModal } from './FixSeriesModal';

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
