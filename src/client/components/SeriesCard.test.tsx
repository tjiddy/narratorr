import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SeriesCard } from './SeriesCard';
import type { BookSeriesMemberCard } from '@/lib/api';
import { createMockSettings } from '@/__tests__/factories';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getBookSeries: vi.fn(),
      refreshBookSeries: vi.fn(),
      addBook: vi.fn(),
      getSettings: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';

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
      <MemoryRouter initialEntries={[`/books/${bookId}`]}>
        <Routes>
          <Route
            path="/books/:id"
            element={
              <SeriesCard
                bookId={bookId}
                fallbackSeriesName={fallbackSeriesName ?? null}
                fallbackSeriesPosition={fallbackSeriesPosition ?? null}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

function makeMember(overrides: Partial<BookSeriesMemberCard> & { id: number; title: string }): BookSeriesMemberCard {
  return {
    providerBookId: null,
    positionRaw: null,
    position: null,
    isCurrent: false,
    libraryBookId: null,
    coverUrl: null,
    authorName: null,
    publishedDate: null,
    duration: null,
    ...overrides,
  };
}

const settingsFixture = createMockSettings({
  quality: { grabFloor: 0, protocolPreference: 'none' as const, minSeeders: 0, searchImmediately: true, monitorForUpgrades: true, rejectWords: '', requiredWords: '' },
});

describe('SeriesCard', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) drains *Once queues — per CLAUDE.md
    // gotcha, clearAllMocks only clears call history and would leak queued
    // mockResolvedValueOnce responses across tests.
    vi.resetAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(settingsFixture);
  });

  it('renders nothing when no backend data and no fallback', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    const { container } = renderCard();
    await waitFor(() => {
      expect(api.getBookSeries).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="series-card"]')).toBeNull();
  });

  it('renders local-only card from fallback when backend returns null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    renderCard({ fallbackSeriesName: 'The Band', fallbackSeriesPosition: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('The Band');
    });
  });

  it('renders in-library title as a link to /books/:id and missing title not as a link', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [
          makeMember({ id: 1, providerBookId: 'A1', title: 'Kings of the Wyld', positionRaw: '1', position: 1, isCurrent: true, libraryBookId: 42, authorName: 'Nicholas Eames' }),
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });

    renderCard({ bookId: 42, fallbackSeriesName: 'The Band' });

    const link = await screen.findByRole('link', { name: 'Kings of the Wyld' });
    expect(link).toHaveAttribute('href', '/books/42');

    // Missing row title is NOT a link
    expect(screen.queryByRole('link', { name: 'Bloody Rose' })).toBeNull();
    expect(screen.getByText('Bloody Rose')).toBeInTheDocument();
  });

  it('renders Add trigger for missing member rows instead of Missing text', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });

    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });

    await screen.findByText('Bloody Rose');
    // No passive "Missing" badge for an addable row
    const memberRow = screen.getByTestId('series-card-member');
    expect(memberRow).not.toHaveTextContent(/^Missing$/);
    // Has the Add control
    expect(screen.getByRole('button', { name: /add book/i })).toBeInTheDocument();
  });

  it('renders a disabled Add control with tooltip (not the Missing badge) when providerBookId is null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: null,
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: null, title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });

    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    const disabled = await screen.findByTestId('series-card-add-disabled');
    // The affordance is a disabled Add button — not a Missing badge
    expect(disabled.tagName).toBe('BUTTON');
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveTextContent(/^Add$/);
    expect(disabled).toHaveAttribute('title', expect.stringMatching(/provider id/i));
    expect(disabled).toHaveAttribute('aria-label', expect.stringMatching(/unavailable/i));
    // The clickable popover trigger ("Add book", exact) must NOT exist
    expect(screen.queryByRole('button', { name: 'Add book' })).toBeNull();
    // No passive Missing badge for this row
    const memberRow = screen.getByTestId('series-card-member');
    expect(memberRow).not.toHaveTextContent(/^Missing$/);
  });

  it('renders a disabled Add control with tooltip (not the Missing badge) when authorName is null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: null,
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: null }),
        ],
      },
    });

    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    const disabled = await screen.findByTestId('series-card-add-disabled');
    expect(disabled.tagName).toBe('BUTTON');
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveTextContent(/^Add$/);
    expect(disabled).toHaveAttribute('title', expect.stringMatching(/author/i));
    expect(disabled).toHaveAttribute('aria-label', expect.stringMatching(/unavailable/i));
    expect(screen.queryByRole('button', { name: 'Add book' })).toBeNull();
    const memberRow = screen.getByTestId('series-card-member');
    expect(memberRow).not.toHaveTextContent(/^Missing$/);
  });

  it('calls addBook with the assembled CreateBookPayload including search/monitor overrides and duration passed through unchanged', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({
            id: 2,
            providerBookId: 'A2',
            title: 'Bloody Rose',
            positionRaw: '2',
            position: 2,
            libraryBookId: null,
            authorName: 'Nicholas Eames',
            publishedDate: '2018-08-28',
            duration: 1300,
            coverUrl: 'https://example.test/br.jpg',
          }),
        ],
      },
    });
    vi.mocked(api.addBook).mockResolvedValue({} as never);

    const user = userEvent.setup();
    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });

    await user.click(await screen.findByRole('button', { name: /add book/i }));
    // Wait for settings to sync defaults so the search-immediately box reflects true
    await waitFor(() => {
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    });

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledWith({
        title: 'Bloody Rose',
        asin: 'A2',
        authors: [{ name: 'Nicholas Eames' }],
        seriesName: 'The Band',
        seriesPosition: 2,
        seriesAsin: 'B07DHQY7DX',
        seriesProvider: 'audible',
        coverUrl: 'https://example.test/br.jpg',
        publishedDate: '2018-08-28',
        duration: 1300,
        searchImmediately: true,
        monitorForUpgrades: true,
      });
    });
  });

  it('invalidates books list, book stats, and the series query on successful add', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });
    vi.mocked(api.addBook).mockResolvedValue({} as never);

    const user = userEvent.setup();
    const { queryClient } = renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByRole('button', { name: /add book/i }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalled();
    });

    const calls = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['books']);
    expect(calls).toContainEqual(['books', 'stats']);
    expect(calls).toContainEqual(['book', 1, 'series']);
  });

  it('shows a success toast naming the book on successful add', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });
    vi.mocked(api.addBook).mockResolvedValue({} as never);

    const user = userEvent.setup();
    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });

    await user.click(await screen.findByRole('button', { name: /add book/i }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Added 'Bloody Rose' to library");
    });
  });

  it('on 409 duplicate, shows an Already in library info toast and still invalidates caches', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });
    vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { id: 7 }));

    const user = userEvent.setup();
    const { queryClient } = renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByRole('button', { name: /add book/i }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith("'Bloody Rose' is already in library");
    });
    expect(toast.error).not.toHaveBeenCalled();

    const calls = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).toContainEqual(['books']);
    expect(calls).toContainEqual(['books', 'stats']);
    expect(calls).toContainEqual(['book', 1, 'series']);
  });

  it('on non-409 failure, shows an error toast and does NOT invalidate caches', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });
    vi.mocked(api.addBook).mockRejectedValue(new Error('Network down'));

    const user = userEvent.setup();
    const { queryClient } = renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(await screen.findByRole('button', { name: /add book/i }));
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeChecked());
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to add 'Bloody Rose': Network down");
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    // No cache invalidation on transient failures — the row should stay missing
    // so the user can retry from the same Add affordance.
    const calls = invalidate.mock.calls.map((c) => c[0]?.queryKey);
    expect(calls).not.toContainEqual(['books']);
    expect(calls).not.toContainEqual(['books', 'stats']);
    expect(calls).not.toContainEqual(['book', 1, 'series']);
  });

  it('synthesized current-member fallback renders as In Library link, never as Add', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    renderCard({ bookId: 7, fallbackSeriesName: 'The Band', fallbackSeriesPosition: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('The Band');
    });
    // The synthesized row uses libraryBookId=bookId so it appears as In Library and links to the current book
    const link = screen.getByRole('link', { name: 'The Band' });
    expect(link).toHaveAttribute('href', '/books/7');
    expect(screen.queryByRole('button', { name: /add book/i })).toBeNull();
    expect(screen.queryByTestId('series-card-add-disabled')).toBeNull();
  });

  it('renders mixed in-library / missing list in position order with correct treatment', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [
          makeMember({ id: 1, providerBookId: 'A1', title: 'Kings of the Wyld', positionRaw: '1', position: 1, libraryBookId: 42, authorName: 'Nicholas Eames' }),
          makeMember({ id: 2, providerBookId: 'A2', title: 'Bloody Rose', positionRaw: '2', position: 2, libraryBookId: null, authorName: 'Nicholas Eames' }),
        ],
      },
    });

    renderCard({ bookId: 42, fallbackSeriesName: 'The Band' });

    await screen.findByText('Kings of the Wyld');
    const rows = screen.getAllByTestId('series-card-member');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-in-library', 'true');
    expect(rows[1]).toHaveAttribute('data-in-library', 'false');
  });

  it('renders empty-members message when members list is empty', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: null,
        lastFetchStatus: null,
        nextFetchAfter: null,
        members: [],
      },
    });
    renderCard({ bookId: 1, fallbackSeriesName: 'The Band' });
    await waitFor(() => {
      expect(screen.getByText('No members known yet.')).toBeInTheDocument();
    });
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
          makeMember({ id: 1, providerBookId: 'A1', title: 'Kings of the Wyld', positionRaw: '1', position: 1, isCurrent: true, libraryBookId: 1, authorName: 'Nicholas Eames' }),
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
