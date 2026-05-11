import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SeriesCard } from './SeriesCard';

vi.mock('@/lib/api', () => ({
  api: {
    getBookSeries: vi.fn(),
    refreshBookSeries: vi.fn(),
  },
}));

import { api } from '@/lib/api';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderCard(props: { bookId?: number; fallbackSeriesName?: string | null; fallbackSeriesPosition?: number | null } = {}) {
  const queryClient = createQueryClient();
  const { bookId = 1, fallbackSeriesName, fallbackSeriesPosition } = props;
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SeriesCard
        bookId={bookId}
        fallbackSeriesName={fallbackSeriesName ?? null}
        fallbackSeriesPosition={fallbackSeriesPosition ?? null}
      />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

describe('SeriesCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when no backend data and no fallback', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    const { container } = renderCard();
    await waitFor(() => {
      expect(api.getBookSeries).toHaveBeenCalled();
    });
    // After the query resolves and the card sees null/null, nothing renders
    expect(container.querySelector('[data-testid="series-card"]')).toBeNull();
  });

  it('renders local-only card from fallback when backend returns null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    renderCard({ fallbackSeriesName: 'The Band', fallbackSeriesPosition: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('The Band');
    });
  });

  it('renders cached members in provider order with In Library / Missing badges', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [
          { id: 1, providerBookId: 'A1', title: 'Kings of the Wyld', positionRaw: '1', position: 1, isCurrent: true, libraryBookId: 1, coverUrl: null },
          { id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, isCurrent: false, libraryBookId: null, coverUrl: null },
        ],
      },
    });

    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });

    await waitFor(() => {
      expect(screen.getByText('Kings of the Wyld')).toBeInTheDocument();
      expect(screen.getByText('Bloody Rose')).toBeInTheDocument();
    });

    expect(screen.getByText('In Library')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });

  it('shows rate-limited banner with nextFetchAfter after a rate-limited refresh', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [],
      },
    });
    vi.mocked(api.refreshBookSeries).mockResolvedValueOnce({
      status: 'rate_limited',
      series: null,
      nextFetchAfter: '2026-05-11T01:00:00.000Z',
    });

    const user = userEvent.setup();
    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /refresh series/i }));

    await waitFor(() => {
      expect(screen.getByTestId('series-card-banner')).toHaveTextContent(/rate-limited/i);
    });
  });

  it('updates the card in place when refresh returns refreshed', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'Old Name',
        providerSeriesId: null,
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [],
      },
    });
    vi.mocked(api.refreshBookSeries).mockResolvedValueOnce({
      status: 'refreshed',
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [
          { id: 1, providerBookId: 'A1', title: 'Kings of the Wyld', positionRaw: '1', position: 1, isCurrent: true, libraryBookId: 1, coverUrl: null },
        ],
      },
    });

    const user = userEvent.setup();
    renderCard({ bookId: 1, fallbackSeriesName: 'Old Name' });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('Old Name');
    });
    await user.click(screen.getByRole('button', { name: /refresh series/i }));
    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('The Band');
    });
    expect(screen.getByText('Kings of the Wyld')).toBeInTheDocument();
  });
});
