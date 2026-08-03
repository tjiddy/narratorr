import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor, UpdateBookPayload } from '@/lib/api';
import type { ClearableBookField } from '@shared/schemas.js';
import { BookPage } from './BookPage';

// importOriginal form, NOT a bare replacement factory — BookDetails transitively
// loads CompanionEbookSection, which reads named exports at RUNTIME
// (`vimock-barrel-replace-drops-named-exports`). The reciprocal hazard applies too:
// every method left unstubbed stays REAL and issues a genuine relative-URL fetch, so
// the standing `issues no real network request` guard below is what keeps this suite
// honest as child components change.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getBookById: vi.fn(),
      getBook: vi.fn(),
      updateBook: vi.fn(),
      getBookSeries: vi.fn(),
      getBookFiles: vi.fn(),
      getCompanionEbookState: vi.fn(),
      getCompanionEbookMetadata: vi.fn(),
      getFfmpegStatus: vi.fn(),
      mintStreamToken: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { api } from '@/lib/api';

/**
 * The CLIENT half of the #2069 provider-only clear workflow (AC20/AC25), end to end
 * across the real page: `BookPage` → `BookDetails` → `resolveDisplayedFields` →
 * `BookMetadataModal` → `useBookActions` → the API call → cache invalidation →
 * refetch → the re-rendered header.
 *
 * The `api` layer is backed by an in-memory fake that models the SERVER's tombstone
 * semantics (recompute on `seriesName: null`, hydrate the parsed array on read), so
 * the invalidation/refetch loop is exercised for real rather than asserted about.
 *
 * The server half — the same PUT payload against the real Fastify app, real
 * BookService and a real migrated DB, plus the persistence, series-card and
 * post-enrichment assertions — is
 * `src/server/__tests__/metadata-clear-flow.e2e.test.ts`. The two meet at the PUT
 * payload, which both assert on literally (`{ seriesName: null }`); they cannot be
 * one test because client suites run in jsdom and server suites in node.
 */
describe('Provider-only metadata clear — client E2E (#2069)', () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>;
  /** The fake server's row for book 1, mutated by the PUT the way the service would. */
  let storedBook: BookWithAuthor;

  /** A post-import book: `enriched`, no stored series — the series is provider-only. */
  function providerOnlyBook(): BookWithAuthor {
    return createMockBook({
      id: 1,
      title: 'Tress of the Emerald Sea',
      authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
      narrators: [],
      status: 'imported',
      enrichmentStatus: 'enriched',
      // `useBook` is keyed off the ASIN — without one the provider query never fires
      // and the fallback under test could not exist.
      asin: 'B0BTRESS01',
      seriesName: null,
      seriesPosition: null,
      publisher: 'Dragonsteel',
      path: '/library/Brandon Sanderson/Tress of the Emerald Sea',
      userClearedFields: [],
    });
  }

  const metadataBook = {
    title: 'Tress of the Emerald Sea',
    authors: [{ name: 'Brandon Sanderson' }],
    seriesPrimary: { name: 'Secret Projects', position: 1 },
    series: [{ name: 'Secret Projects', position: 1 }],
    publisher: 'Dragonsteel',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    storedBook = providerOnlyBook();

    // The fake server: `getBookById` always returns CURRENT state, so a refetch after
    // invalidation observes the write — the loop this test exists to cover.
    vi.mocked(api.getBookById).mockImplementation(async () => storedBook);
    vi.mocked(api.getBook).mockResolvedValue(metadataBook);
    vi.mocked(api.updateBook).mockImplementation(async (_id: number, payload: UpdateBookPayload) => {
      // Mirror the server's AC6 recompute for the one field this flow touches: a
      // blank value adds the tombstone and normalizes the stored column to NULL; a
      // non-blank value removes it.
      const cleared = new Set<ClearableBookField>(storedBook.userClearedFields ?? []);
      if ('seriesName' in payload) {
        if (payload.seriesName == null || payload.seriesName.trim() === '') {
          cleared.add('seriesName');
          storedBook = { ...storedBook, seriesName: null, seriesPosition: null };
        } else {
          cleared.delete('seriesName');
          storedBook = { ...storedBook, seriesName: payload.seriesName };
        }
      }
      storedBook = { ...storedBook, userClearedFields: [...cleared].sort() };
      return storedBook;
    });

    vi.mocked(api.getBookSeries).mockImplementation(async () =>
      storedBook.seriesName ? { series: { id: 1, name: storedBook.seriesName, hardcoverSeriesId: null, seriesAuthor: null, lastFetchedAt: null, members: [] } } : { series: null },
    );
    vi.mocked(api.getBookFiles).mockResolvedValue([]);
    vi.mocked(api.getFfmpegStatus).mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
    vi.mocked(api.mintStreamToken).mockRejectedValue(new Error('no stream token in this suite'));
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/books/1']}>
          <Routes>
            <Route path="books/:id" element={<BookPage />} />
            <Route path="library" element={<div>Library Page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function openEditModal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText('More actions'));
    await user.click(screen.getByRole('menuitem', { name: /Edit/ }));
  }

  it('clears a provider-only series through the real UI and the header updates without a reload', async () => {
    const user = userEvent.setup();
    renderPage();

    // 1. The header shows the series from the PROVIDER fallback — nothing is stored.
    await waitFor(() => expect(screen.getByText('Tress of the Emerald Sea')).toBeInTheDocument());
    // The provider metadata is a separate query from the library book — wait for it
    // to settle rather than asserting on the library-only first paint.
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    // 2. The modal pre-fills from the SAME resolver decision (AC18/AC25) — this is
    //    what makes the clear expressible at all for this book.
    await openEditModal(user);
    const seriesInput = screen.getByLabelText(/series$/i);
    expect(seriesInput).toHaveValue('Secret Projects');

    // 3. Blank it and save.
    await user.clear(seriesInput);
    await user.click(screen.getByText('Save'));

    // 4. The exact payload the server half consumes.
    await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
    expect(api.updateBook).toHaveBeenCalledWith(1, { seriesName: null });

    // 5. Invalidation → refetch → re-render. No remount, no reload: the same tree
    //    that rendered the dot must stop rendering it.
    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    // 6. The tombstone came back on the refetched detail and is what suppresses the
    //    provider fallback — the header is not merely showing a stale empty string.
    expect(storedBook.userClearedFields).toEqual(['seriesName']);
    // Untouched neighbours still render, so this is a targeted suppression.
    expect(screen.getByText(/Dragonsteel/)).toBeInTheDocument();
  });

  it('reopening the modal after the clear shows the series BLANK, not the provider value', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    await openEditModal(user);
    await user.clear(screen.getByLabelText(/series$/i));
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    await openEditModal(user);

    // The operator never sees the value they just removed reappear.
    expect(screen.getByLabelText(/series$/i)).toHaveValue('');
  });

  it('saving the reopened modal untouched does not resurrect the series', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    await openEditModal(user);
    await user.clear(screen.getByLabelText(/series$/i));
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    vi.mocked(api.updateBook).mockClear();
    await openEditModal(user);
    await user.click(screen.getByText('Save'));

    await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
    expect(api.updateBook).toHaveBeenCalledWith(1, {});
    expect(storedBook.userClearedFields).toEqual(['seriesName']);
    expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument();
  });

  it('AC22: typing a new series removes the tombstone and the header shows it', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    await openEditModal(user);
    await user.clear(screen.getByLabelText(/series$/i));
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    await openEditModal(user);
    await user.type(screen.getByLabelText(/series$/i), 'Cosmere');
    await user.click(screen.getByText('Save'));

    // Scope to the header meta line — the series card sidebar also renders the name
    // once the tombstone is gone, and `getByText` would ambiguously match both.
    await waitFor(() => expect(screen.getByText(/^Cosmere #1 ·/)).toBeInTheDocument());
    expect(storedBook.userClearedFields).toEqual([]);
  });

  it('AC21 control: an unrelated edit never promotes the provider series into the payload', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    await openEditModal(user);
    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), 'Renamed Book');
    await user.click(screen.getByText('Save'));

    await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
    const payload = vi.mocked(api.updateBook).mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).toEqual({ title: 'Renamed Book' });
    expect(payload).not.toHaveProperty('seriesName');
    // The header keeps showing the provider fallback — nothing was tombstoned.
    expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument();
  });

  // Standing guard (`vimock-barrel-replace-drops-named-exports`): a method left real
  // by the preserved barrel reaches `fetchApi`, which resolves a relative `/api/...`
  // URL against jsdom's base and issues a genuine request.
  it('issues no real network request across the whole clear flow', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Tress of the Emerald Sea')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    await openEditModal(user);
    await user.clear(screen.getByLabelText(/series$/i));
    await user.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([]);
  });
});
