import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SeriesCard } from './SeriesCard';
import type { BookSeriesMemberCard } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getBookSeries: vi.fn(),
      refreshBookSeries: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderCard(props: { bookId?: number } = {}) {
  const queryClient = createQueryClient();
  const { bookId = 1 } = props;
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/books/${bookId}`]}>
        <Routes>
          <Route path="/books/:id" element={<SeriesCard bookId={bookId} />} />
          <Route path="/search" element={<div data-testid="search-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

function makeMember(overrides: Partial<BookSeriesMemberCard> & { title: string }): BookSeriesMemberCard {
  return {
    hardcoverBookId: null,
    slug: null,
    position: null,
    imageUrl: null,
    inLibrary: false,
    libraryBookId: null,
    ...overrides,
  };
}

describe('SeriesCard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders nothing when the API returns series: null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: null });
    const { container } = renderCard();
    await waitFor(() => {
      expect(api.getBookSeries).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="series-card"]')).toBeNull();
  });

  it('renders in-library title as a link to /books/:id', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        members: [
          makeMember({ hardcoverBookId: 1001, title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 42 }),
          makeMember({ hardcoverBookId: 1002, title: 'Bloody Rose', position: 2, inLibrary: false, libraryBookId: null }),
        ],
      },
    });

    renderCard({ bookId: 42 });

    const link = await screen.findByRole('link', { name: 'Kings of the Wyld' });
    expect(link).toHaveAttribute('href', '/books/42');
    // Non-in-library row renders title as text, not a /books/:id link
    expect(screen.queryByRole('link', { name: 'Bloody Rose' })).toBeNull();
    expect(screen.getByText('Bloody Rose')).toBeInTheDocument();
  });

  it('renders + Add link with /search?q=<title>+<seriesAuthor> for missing members', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: null,
        members: [
          makeMember({ hardcoverBookId: 1002, title: 'Bloody Rose', position: 2, inLibrary: false }),
        ],
      },
    });

    renderCard({ bookId: 1 });
    const addLink = await screen.findByTestId('series-card-add');
    expect(addLink).toHaveAttribute('href', '/search?q=Bloody%20Rose%20Nicholas%20Eames');
  });

  it('renders empty-members message when members list is empty', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: null,
        seriesAuthor: null,
        lastFetchedAt: null,
        members: [],
      },
    });
    renderCard({ bookId: 1 });
    await waitFor(() => {
      expect(screen.getByText('No members known yet.')).toBeInTheDocument();
    });
  });

  it('renders library-only card with In Library affordance and no + Add rows', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: null,
        name: 'The Band',
        hardcoverSeriesId: null,
        seriesAuthor: null,
        lastFetchedAt: null,
        members: [
          makeMember({ title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 42 }),
        ],
      },
    });

    renderCard({ bookId: 42 });

    await screen.findByText('Kings of the Wyld');
    expect(screen.queryByTestId('series-card-add')).toBeNull();
    expect(screen.getByText('In Library')).toBeInTheDocument();
  });

  it('updates the card in place on refresh', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'Old Name',
        hardcoverSeriesId: null,
        seriesAuthor: null,
        lastFetchedAt: null,
        members: [],
      },
    });
    vi.mocked(api.refreshBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        members: [
          makeMember({ hardcoverBookId: 1001, title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 1 }),
        ],
      },
    });

    const user = userEvent.setup();
    renderCard({ bookId: 1 });

    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('Old Name');
    });
    await user.click(screen.getByRole('button', { name: /refresh series/i }));
    await waitFor(() => {
      expect(screen.getByTestId('series-card-name')).toHaveTextContent('The Band');
    });
    expect(screen.getByText('Kings of the Wyld')).toBeInTheDocument();
  });

  it('skips the cover slot when imageUrl is null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: null,
        members: [
          makeMember({ hardcoverBookId: 1001, title: 'Kings of the Wyld', position: 1, inLibrary: false, imageUrl: null }),
        ],
      },
    });

    renderCard({ bookId: 1 });
    await screen.findByText('Kings of the Wyld');
    const row = screen.getByTestId('series-card-member');
    expect(row.querySelector('img')).toBeNull();
  });

  it('renders the cover image when imageUrl is non-null', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: null,
        members: [
          makeMember({ hardcoverBookId: 1001, title: 'Kings of the Wyld', position: 1, inLibrary: false, imageUrl: 'https://example.test/kw.jpg' }),
        ],
      },
    });

    renderCard({ bookId: 1 });
    await screen.findByText('Kings of the Wyld');
    const row = screen.getByTestId('series-card-member');
    expect(row.querySelector('img')).not.toBeNull();
    expect(row.querySelector('img')!.getAttribute('src')).toBe('https://example.test/kw.jpg');
  });
});
