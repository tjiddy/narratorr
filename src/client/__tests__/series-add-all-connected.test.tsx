/**
 * Connected Add All flow: the real SeriesCard renders against the real `api` client, whose fetch is
 * routed into a real Fastify app backed by a real migrated libSQL database.
 *
 * Nothing on the client↔server seam is mocked. The component suite stubs `api.addAllInSeries` and
 * the server E2E suite injects HTTP directly, so neither can see a broken request path, a wrong
 * request body, or a missing cache invalidation — this test covers exactly that gap (#2200 F3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SeriesCard } from '@/components/SeriesCard';
import { createE2EApp, type E2EApp } from '../../server/__tests__/e2e-helpers.js';
import { books, bookAuthors, authors } from '@db/schema.js';
import { generatePublicId } from '../../server/utils/public-id.js';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'sonner';

/**
 * The batch resolves each member before creating it (#2231), so the server's outbound metadata
 * provider is stubbed alongside its outbound Hardcover call. Only the provider is replaced — the
 * client↔server seam this suite exists for stays entirely real.
 */
const RESOLVED_COVERS: Record<string, string> = {
  "Caliban's War": 'https://example.test/caliban.jpg',
  "Abaddon's Gate": 'https://example.test/abaddon.jpg',
};

const mockAudibleProvider = {
  name: 'Audible.com',
  type: 'audible',
  searchBooks: vi.fn().mockImplementation((query: string) => {
    const hit = Object.entries(RESOLVED_COVERS).find(([title]) => query.startsWith(title));
    return Promise.resolve({
      books: hit
        ? [{
            asin: `B_${hit[0].replace(/[^A-Za-z]/g, '').toUpperCase()}`,
            title: hit[0],
            authors: [{ name: 'James S. A. Corey' }],
            narrators: ['Jefferson Mays'],
            // books.duration is MINUTES.
            duration: 1230,
            coverUrl: hit[1],
          }]
        : [],
    });
  }),
  searchSeries: vi.fn().mockResolvedValue([]),
  getBook: vi.fn().mockResolvedValue(null),
  getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
  test: vi.fn().mockResolvedValue({ success: true }),
};

vi.mock('@core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/index.js')>();
  return {
    ...actual,
    METADATA_SEARCH_PROVIDER_FACTORIES: {
      audible: vi.fn().mockImplementation(function () { return mockAudibleProvider; }),
    },
    AudnexusProvider: vi.fn().mockImplementation(function () {
      return {
        name: 'Audnexus', type: 'audnexus',
        getBook: vi.fn().mockResolvedValue(null),
        getBookDetailed: vi.fn().mockResolvedValue({ kind: 'not_found' }),
        getAuthor: vi.fn().mockResolvedValue(null),
        getChapterRuntime: vi.fn().mockResolvedValue({ kind: 'not_found' }),
      };
    }),
  };
});

const ORIGINAL_FETCH = globalThis.fetch;

const HARDCOVER_MEMBERS = [
  { id: 7001, position: 1, title: 'Leviathan Wakes' },
  { id: 7002, position: 2, title: "Caliban's War" },
  { id: 7003, position: 2.5, title: 'Gods of Risk' },
  { id: 7004, position: 3, title: "Abaddon's Gate" },
];

describe('Add All — connected client → route → database → rerender (#2200)', () => {
  let e2e: E2EApp;
  let anchorId: number;
  /** Every request the client actually put on the wire, so the seam itself is assertable. */
  let apiCalls: Array<{ method: string; url: string; body: string | undefined }>;

  beforeEach(async () => {
    // The sonner double is module-scoped, so its call history would otherwise accumulate across tests.
    vi.clearAllMocks();
    e2e = await createE2EApp();
    apiCalls = [];
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: 'TEST_KEY' } });
    await e2e.services.settings.update({ quality: { searchImmediately: false } });
    anchorId = await seedAnchorBook();
    installConnectedFetch();
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  async function seedAnchorBook(): Promise<number> {
    const [book] = await e2e.db.insert(books).values({
      publicId: generatePublicId('bk'),
      title: 'Leviathan Wakes',
      seriesName: 'The Expanse',
      seriesPosition: 1,
    }).returning();
    const [author] = await e2e.db.insert(authors).values({
      publicId: generatePublicId('au'), name: 'James S. A. Corey', slug: 'james-s-a-corey',
    }).returning();
    await e2e.db.insert(bookAuthors).values({ bookId: book!.id, authorId: author!.id, position: 0 });
    return book!.id;
  }

  /**
   * `/api/*` is the client's own relative path, so it goes to the real route via inject; anything
   * else is the server's outbound Hardcover call.
   */
  function installConnectedFetch(): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('/api')) return hardcoverResponse();

      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      apiCalls.push({ method, url, body });

      const injected = await e2e.app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: init?.headers as Record<string, string>,
        ...(body !== undefined && { payload: body }),
      });
      return new Response(injected.payload, {
        status: injected.statusCode,
        headers: { 'Content-Type': injected.headers['content-type'] as string ?? 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  function hardcoverResponse(): Response {
    return new Response(JSON.stringify({
      data: {
        series: [{
          id: 4242,
          name: 'The Expanse',
          slug: 'the-expanse',
          author: { name: 'James S. A. Corey' },
          book_series: HARDCOVER_MEMBERS.map((m) => ({
            position: m.position,
            book: { id: m.id, slug: `s-${m.id}`, title: m.title, image: null, users_count: 100 },
          })),
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  function renderCard() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/books/${anchorId}`]}>
          <Routes>
            <Route path="/books/:id" element={<SeriesCard bookId={anchorId} />} />
            <Route path="/search" element={<div data-testid="search-page" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { queryClient };
  }

  const rowsByTitle = async () =>
    Object.fromEntries((await e2e.db.select().from(books)).map((b) => [b.title, b]));

  it('adds every unowned major member and rerenders them as In Library', async () => {
    const user = userEvent.setup();
    renderCard();

    // The card itself hydrates over the real GET before Add All is reachable.
    const trigger = await screen.findByRole('button', { name: 'Add all books in series' }, { timeout: 5000 });
    expect(trigger).toHaveTextContent('Add All (2)');

    await user.click(trigger);
    await user.click(await screen.findByRole('button', { name: 'Add 2 books' }));

    // The rows the user asked for exist in the database, resolved by the batch itself.
    await waitFor(async () => {
      expect(Object.keys(await rowsByTitle()).sort()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
    }, { timeout: 5000 });
    const rows = await rowsByTitle();
    expect(Object.keys(rows).sort()).toEqual(["Abaddon's Gate", "Caliban's War", 'Leviathan Wakes']);
    for (const title of ["Caliban's War", "Abaddon's Gate"]) {
      expect(rows[title]).toMatchObject({
        seriesName: 'The Expanse',
        status: 'wanted',
        // No grey placeholder waiting on the cron: the user's click produced a row with its cover,
        // duration and narrators already on it. SeriesCard renders no artwork of its own, so the
        // durable row after the real round-trip is where this is observable at this seam.
        coverUrl: RESOLVED_COVERS[title],
        duration: 1230,
        enrichmentStatus: 'pending',
      });
      expect(rows[title]!.asin).not.toBeNull();
    }
    expect(rows["Caliban's War"]!.seriesPosition).toBe(2);
    expect(rows["Abaddon's Gate"]!.seriesPosition).toBe(3);
    // The excluded novella never became a row.
    expect(rows['Gods of Risk']).toBeUndefined();

    // The summary the user sees comes from the real response body.
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(vi.mocked(toast.success).mock.calls[0]?.[0] as string).toContain('2 added');

    // Invalidation refetched the card, and the new members now read In Library.
    await waitFor(() => {
      expect(screen.getAllByText('In Library')).toHaveLength(3);
    }, { timeout: 5000 });
    const memberRows = screen.getAllByTestId('series-card-member');
    const owned = memberRows
      .filter((row) => within(row).queryByText('In Library') !== null)
      .map((row) => row.textContent);
    expect(owned.some((t) => t?.includes("Caliban's War"))).toBe(true);
    expect(owned.some((t) => t?.includes("Abaddon's Gate"))).toBe(true);
    // The control disappears once nothing unowned and major remains.
    expect(screen.queryByRole('button', { name: 'Add all books in series' })).toBeNull();
  });

  it('puts the popover\'s searchImmediately choice on the wire as the real request body', async () => {
    const user = userEvent.setup();
    renderCard();

    const trigger = await screen.findByRole('button', { name: 'Add all books in series' }, { timeout: 5000 });
    await user.click(trigger);
    // The checkbox default comes from the real GET /api/settings, which seeded false above.
    const checkbox = await screen.findByRole('checkbox');
    await waitFor(() => expect(checkbox).not.toBeChecked());
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Add 2 books' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    const batchCalls = apiCalls.filter((c) => c.url.includes('/series/add-all'));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toMatchObject({
      method: 'POST',
      url: `/api/books/${anchorId}/series/add-all`,
      body: JSON.stringify({ searchImmediately: true }),
    });
  });

  it('reports an all-owned rerun as a success and creates nothing the second time', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Add all books in series' }, { timeout: 5000 }));
    await user.click(await screen.findByRole('button', { name: 'Add 2 books' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    const titlesAfterFirst = Object.keys(await rowsByTitle()).sort();

    // The card re-renders with no unowned major members, so drive the second run through the route
    // exactly as a stale second tab would.
    const rerun = await e2e.app.inject({
      method: 'POST',
      url: `/api/books/${anchorId}/series/add-all`,
      payload: { searchImmediately: false },
    });

    expect(rerun.statusCode).toBe(200);
    expect(rerun.json()).toMatchObject({ created: 0, failed: 0 });
    expect(Object.keys(await rowsByTitle()).sort()).toEqual(titlesAfterFirst);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
