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
      addAllInSeries: vi.fn(),
      getSettings: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';
import { createMockSettings } from '@/__tests__/factories';

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
    expect(screen.queryByRole('link', { name: 'Bloody Rose' })).toBeNull();
    expect(screen.getByText('Bloody Rose')).toBeInTheDocument();
  });

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
    expect(screen.getAllByTestId('series-card-add')).toHaveLength(1);
    expect(screen.getAllByTestId('series-card-member')).toHaveLength(2);
  });

  // React keys are observable only through reconciliation. Preserving the Hardcover
  // control node proves the reorder did not remount the entire list.
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

    expect(screen.getByText('The Eastern Kingdoms').closest('li')).toBe(hardcoverBefore);
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
    // imageUrl remains in API data, but SeriesCard intentionally ignores it.
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

describe('SeriesCard — Add All (#2200)', () => {
  const ADD_ALL = 'Add all books in series';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getSettings).mockResolvedValue(
      createMockSettings({ quality: { searchImmediately: true } }) as unknown as Awaited<ReturnType<typeof api.getSettings>>,
    );
  });

  function cardWith(members: BookSeriesMemberCard[]) {
    return {
      series: {
        id: 7,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: null,
        members,
      },
    };
  }

  function showCard(members: BookSeriesMemberCard[]) {
    vi.mocked(api.getBookSeries).mockResolvedValue(cardWith(members));
    return renderCard({ bookId: 42 });
  }

  const batch = (overrides: Partial<{ requested: number; created: number; owned: number; held: number; failed: number }> = {}) => ({
    requested: 1, created: 1, owned: 0, held: 0, failed: 0,
    members: [{ title: 'Bloody Rose', position: 2, disposition: 'created' as const, bookId: 9 }],
    ...overrides,
  });

  describe('count and visibility', () => {
    it('counts only unowned major members in the label', async () => {
      showCard([
        makeMember({ title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 42 }),
        makeMember({ title: 'Bloody Rose', position: 2 }),
        makeMember({ title: 'Outlaw Empire', position: 3 }),
        makeMember({ title: 'A Novella', position: 2.5 }),
        makeMember({ title: 'Unplaced', position: null }),
        makeMember({ title: '   ', position: 4 }),
      ]);

      const trigger = await screen.findByRole('button', { name: ADD_ALL });
      expect(trigger).toHaveTextContent('Add All (2)');
    });

    it('renders the singular boundary count of 1', async () => {
      showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);

      expect(await screen.findByRole('button', { name: ADD_ALL })).toHaveTextContent('Add All (1)');
    });

    it.each([
      ['every unowned member is minor', [makeMember({ title: 'A Novella', position: 1.5 }), makeMember({ title: 'Prequel', position: 0 })]],
      ['the member list is empty', []],
      ['every member is already in the library', [makeMember({ title: 'Kings of the Wyld', position: 1, inLibrary: true, libraryBookId: 42 })]],
    ])('omits the control entirely when %s', async (_label, members) => {
      showCard(members as BookSeriesMemberCard[]);

      await screen.findByTestId('series-card');
      expect(screen.queryByRole('button', { name: ADD_ALL })).toBeNull();
    });

    it('leaves the per-row + Add link of an excluded member unchanged', async () => {
      showCard([makeMember({ title: 'A Novella', position: 1.5 }), makeMember({ title: 'Bloody Rose', position: 2 })]);

      await screen.findByRole('button', { name: ADD_ALL });
      const links = screen.getAllByTestId('series-card-add');
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute('href', '/search?q=A%20Novella%20Nicholas%20Eames');
    });
  });

  describe('popover', () => {
    it('names the count on the confirm button', async () => {
      const user = userEvent.setup();
      showCard([makeMember({ title: 'Bloody Rose', position: 2 }), makeMember({ title: 'Outlaw Empire', position: 3 })]);

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));

      expect(await screen.findByRole('button', { name: 'Add 2 books' })).toBeInTheDocument();
    });

    it('uses the singular noun for a single book', async () => {
      const user = userEvent.setup();
      showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));

      expect(await screen.findByRole('button', { name: 'Add 1 book' })).toBeInTheDocument();
    });

    it('shows exactly one checkbox, defaulted from the quality setting', async () => {
      const user = userEvent.setup();
      showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));

      const boxes = await screen.findAllByRole('checkbox');
      expect(boxes).toHaveLength(1);
      await waitFor(() => expect(boxes[0]).toBeChecked());
      expect(screen.getByText('Search immediately')).toBeInTheDocument();
    });

    it('defaults the checkbox off when the quality setting is off', async () => {
      const user = userEvent.setup();
      vi.mocked(api.getSettings).mockResolvedValue(
        createMockSettings({ quality: { searchImmediately: false } }) as unknown as Awaited<ReturnType<typeof api.getSettings>>,
      );
      showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));

      await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    });
  });

  describe('mutation lifecycle', () => {
    async function confirmAddAll(members: BookSeriesMemberCard[] = [makeMember({ title: 'Bloody Rose', position: 2 })]) {
      const user = userEvent.setup();
      const rendered = showCard(members);
      await user.click(await screen.findByRole('button', { name: ADD_ALL }));
      await user.click(await screen.findByRole('button', { name: /^Add \d+ books?$/ }));
      return { user, ...rendered };
    }

    it('posts once with the derived searchImmediately flag', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch());

      await confirmAddAll();

      await waitFor(() => expect(api.addAllInSeries).toHaveBeenCalledTimes(1));
      expect(api.addAllInSeries).toHaveBeenCalledWith(42, true);
    });

    it('posts the unchecked flag when the user clears the checkbox', async () => {
      const user = userEvent.setup();
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch());
      showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));
      await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
      await user.click(screen.getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Add 1 book' }));

      await waitFor(() => expect(api.addAllInSeries).toHaveBeenCalledWith(42, false));
    });

    it('invalidates books, identifiers and the book-series card on success', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch());
      const { queryClient } = showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));
      await user.click(await screen.findByRole('button', { name: 'Add 1 book' }));

      await waitFor(() => expect(api.addAllInSeries).toHaveBeenCalled());
      const keys = () => invalidate.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey));
      await waitFor(() => expect(keys()).toContain(JSON.stringify(queryKeys.bookSeries(42))));
      expect(keys()).toContain(JSON.stringify(queryKeys.books()));
      expect(keys()).toContain(JSON.stringify(queryKeys.bookIdentifiers()));
    });

    it('disables the control while the request is in flight, so a second click issues nothing', async () => {
      let release!: (value: ReturnType<typeof batch>) => void;
      vi.mocked(api.addAllInSeries).mockReturnValue(new Promise((res) => { release = res; }));
      const { user } = await confirmAddAll();

      const trigger = await screen.findByRole('button', { name: ADD_ALL });
      await waitFor(() => expect(trigger).toBeDisabled());
      await user.click(trigger);
      expect(api.addAllInSeries).toHaveBeenCalledTimes(1);

      release(batch());
      await waitFor(() => expect(trigger).not.toBeDisabled());
    });

    it('surfaces the per-disposition summary rather than a generic success', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 6, created: 3, owned: 1, held: 1, failed: 1 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      const message = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
      expect(message).toContain('3 added');
      expect(message).toContain('1 already owned');
      expect(message).toContain('1 held for review');
      expect(message).toContain('1 failed');
    });

    it('reports a clean run without naming the empty buckets', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 2, created: 2 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      const message = vi.mocked(toast.success).mock.calls[0]?.[0] as string;
      expect(message).toContain('2 added');
      expect(message).not.toContain('owned');
      expect(message).not.toContain('failed');
    });

    it('surfaces an error-shaped summary when nothing was created', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 2, created: 0, failed: 2 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(toast.success).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error).mock.calls[0]?.[0] as string).toContain('2 failed');
    });

    /**
     * `owned` and `held` are durable successes, so a rerun or a stale card that creates nothing is
     * not an error — only a run that added nothing AND failed something is.
     */
    it('reports an all-owned rerun as a success, not an error', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 3, created: 0, owned: 3 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(toast.success).mock.calls[0]?.[0] as string).toContain('3 already owned');
    });

    it('reports an all-held run as a success, not an error', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 2, created: 0, held: 2 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(toast.success).mock.calls[0]?.[0] as string).toContain('2 held for review');
    });

    it('reports a mixed owned-and-failed run with nothing created as an error', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 3, created: 0, owned: 2, failed: 1 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(toast.success).not.toHaveBeenCalled();
      expect(vi.mocked(toast.error).mock.calls[0]?.[0] as string).toContain('1 failed');
    });

    it('keeps a partly-failed run that still created rows on the success path', async () => {
      vi.mocked(api.addAllInSeries).mockResolvedValue(batch({ requested: 3, created: 2, failed: 1 }));

      await confirmAddAll();

      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('surfaces an error notification when the request itself fails', async () => {
      vi.mocked(api.addAllInSeries).mockRejectedValue(new Error('network down'));

      const { queryClient } = await confirmAddAll();

      await waitFor(() => {
        const states = queryClient.getMutationCache().getAll().map((m) => m.state.status);
        expect(states).toContain('error');
      });
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('still reconciles caches but raises no toast when the card unmounts mid-request', async () => {
      let release!: (value: ReturnType<typeof batch>) => void;
      vi.mocked(api.addAllInSeries).mockReturnValue(new Promise((res) => { release = res; }));
      const user = userEvent.setup();
      const { unmount, queryClient } = showCard([makeMember({ title: 'Bloody Rose', position: 2 })]);
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

      await user.click(await screen.findByRole('button', { name: ADD_ALL }));
      await user.click(await screen.findByRole('button', { name: 'Add 1 book' }));
      await waitFor(() => expect(api.addAllInSeries).toHaveBeenCalled());

      unmount();
      release(batch());

      await waitFor(() => {
        const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify((arg as { queryKey: unknown }).queryKey));
        expect(keys).toContain(JSON.stringify(queryKeys.books()));
      });
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});
