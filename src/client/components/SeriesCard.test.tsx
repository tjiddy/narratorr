import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SeriesCard } from './SeriesCard';
import type { BookSeriesMemberCard } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      getBookSeries: vi.fn(),
      refreshBookSeries: vi.fn(),
      searchBookSeries: vi.fn(),
      bindBookSeries: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

  // #2144: on a Hardcover-canonical card, an owned book Hardcover does not list
  // arrives with `hardcoverBookId: null` and `inLibrary: true`. It must render
  // exactly like any other owned member — a link to the book, the In Library
  // badge, no '+ Add'. The `library-N` key branch it depends on is pinned
  // separately below, since a React key is not observable in the DOM.
  it('renders an owned member with no hardcoverBookId as an In Library link', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1,
        name: 'Exploring Azeroth',
        hardcoverSeriesId: 25106,
        seriesAuthor: 'Christie Golden',
        lastFetchedAt: '2026-08-05T00:00:00.000Z',
        members: [
          makeMember({ hardcoverBookId: 8001, title: 'The Eastern Kingdoms', position: 1, inLibrary: false }),
          makeMember({ hardcoverBookId: null, title: 'Kalimdor', position: 2, inLibrary: true, libraryBookId: 77 }),
        ],
      },
    });

    renderCard({ bookId: 77 });

    const link = await screen.findByRole('link', { name: 'Kalimdor' });
    expect(link).toHaveAttribute('href', '/books/77');
    expect(screen.getByText('In Library')).toBeInTheDocument();
    // Exactly one '+ Add' on the card — the Hardcover member the operator does
    // NOT own. The owned entry must not have produced a second one.
    expect(screen.getAllByTestId('series-card-add')).toHaveLength(1);
    expect(screen.getAllByTestId('series-card-member')).toHaveLength(2);
  });

  /**
   * F2 (PR review) — a React key never reaches the DOM, so no query can assert it
   * directly. What a key IS observable through is reconciliation: a row whose key
   * is stable across a re-render keeps its DOM node when the list reorders, and a
   * row whose key changes is unmounted and remounted as a fresh node.
   *
   * `memberKeyFor` keys a provider-null owned member on `library-${libraryBookId}`
   * — stable — and falls through to `t-${title}-${index}` when that is null too,
   * which is index-dependent and therefore NOT stable across a reorder. Deleting
   * the `library-` branch makes Kalimdor's key move from `t-Kalimdor-1` to
   * `t-Kalimdor-0`, React discards the node, and the identity assertion fails.
   *
   * The Hardcover row is the CONTROL: its `hardcover-8001` key is stable under
   * both implementations, so its surviving node proves the reorder itself does
   * not force a wholesale remount — without it, a framework-level change that
   * remounted everything would make the real assertion vacuously green.
   */
  it('F2: a provider-null owned row keeps its DOM node across a reorder, so its key is not index-derived', async () => {
    const eastern = makeMember({ hardcoverBookId: 8001, title: 'The Eastern Kingdoms', position: 1, inLibrary: false });
    const kalimdor = makeMember({ hardcoverBookId: null, title: 'Kalimdor', position: 2, inLibrary: true, libraryBookId: 77 });
    const card = (members: BookSeriesMemberCard[]) => ({
      id: 1,
      name: 'Exploring Azeroth',
      hardcoverSeriesId: 25106,
      seriesAuthor: 'Christie Golden',
      lastFetchedAt: null,
      members,
    });

    vi.mocked(api.getBookSeries).mockResolvedValueOnce({ series: card([eastern, kalimdor]) });
    // A refresh reorders the two members — the position-2 owned book now sorts
    // first. Same two members, same identities, different order.
    vi.mocked(api.refreshBookSeries).mockResolvedValueOnce({ series: card([kalimdor, eastern]) });

    const user = userEvent.setup();
    renderCard({ bookId: 77 });

    const ownedBefore = (await screen.findByRole('link', { name: 'Kalimdor' })).closest('li');
    const hardcoverBefore = screen.getByText('The Eastern Kingdoms').closest('li');
    expect(ownedBefore).not.toBeNull();

    await user.click(screen.getByRole('button', { name: /refresh series/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId('series-card-member')[0]).toHaveTextContent('Kalimdor');
    });

    // Control: the Hardcover row keeps its node, so the reorder alone remounts nothing.
    expect(screen.getByText('The Eastern Kingdoms').closest('li')).toBe(hardcoverBefore);
    // The assertion under test: the owned row's key is stable too.
    expect(screen.getByRole('link', { name: 'Kalimdor' }).closest('li')).toBe(ownedBefore);
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

  it('renders the Fix-series pencil unconditionally (not hover-gated)', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1, name: 'The Band', hardcoverSeriesId: 5523, seriesAuthor: 'Nicholas Eames', lastFetchedAt: null,
        members: [makeMember({ title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 1 })],
      },
    });
    renderCard({ bookId: 1 });
    expect(await screen.findByRole('button', { name: /fix series match/i })).toBeInTheDocument();
  });

  it('opens the Fix Series modal with the search box prefilled with the current series name', async () => {
    vi.mocked(api.getBookSeries).mockResolvedValueOnce({
      series: {
        id: 1, name: 'The Band', hardcoverSeriesId: 5523, seriesAuthor: 'Nicholas Eames', lastFetchedAt: null, members: [],
      },
    });
    vi.mocked(api.searchBookSeries).mockResolvedValue({ candidates: [] });

    const user = userEvent.setup();
    renderCard({ bookId: 1 });

    await user.click(await screen.findByRole('button', { name: /fix series match/i }));
    const input = await screen.findByTestId('fix-series-search-input');
    expect(input).toHaveValue('The Band');
  });

  it('does not render a cover image when imageUrl is null', async () => {
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

  it('does not render a cover image even when imageUrl is non-null', async () => {
    // #1139 Bug 5: the card no longer renders thumbnails. The imageUrl field
    // stays in the data model — backend still populates it from Hardcover —
    // but the component does not consume it.
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
    expect(row.querySelector('img')).toBeNull();
  });
});
