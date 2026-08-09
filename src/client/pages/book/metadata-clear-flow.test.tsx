import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor, UpdateBookPayload } from '@/lib/api';
import type { ClearableBookField } from '@shared/schemas.js';
import { BookPage } from './BookPage';

// Preserve runtime exports for transitive children; the network guard catches any unstubbed real method.
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

// This client E2E uses an in-memory tombstone model so invalidation, refetch, and re-render execute for real.
// The Node-side persistence half lives in metadata-clear-flow.e2e.test.ts; both pin the same PUT payload.
describe('Provider-only metadata clear — client E2E (#2069)', () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>;
  // Mutable fake-server row returned by each refetch.
  let storedBook: BookWithAuthor;

  function providerOnlyBook(): BookWithAuthor {
    return createMockBook({
      id: 1,
      title: 'Tress of the Emerald Sea',
      authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
      narrators: [],
      status: 'imported',
      enrichmentStatus: 'enriched',
      // useBook is ASIN-keyed; without this the provider fallback never exists.
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

    // Return the mutable row so invalidation observes writes.
    vi.mocked(api.getBookById).mockImplementation(async () => storedBook);
    vi.mocked(api.getBook).mockResolvedValue(metadataBook);
    vi.mocked(api.updateBook).mockImplementation(async (_id: number, payload: UpdateBookPayload) => {
      // Mirror server tombstone recomputation for this flow.
      const cleared = new Set<ClearableBookField>(storedBook.userClearedFields ?? []);
      if ('seriesName' in payload) {
        if (payload.seriesName == null || payload.seriesName.trim() === '') {
          cleared.add('seriesName');
          storedBook = { ...storedBook, seriesName: null };
        } else {
          cleared.delete('seriesName');
          storedBook = { ...storedBook, seriesName: payload.seriesName };
        }
      }
      // Position has its own tombstone; a live name reasserts the pair, while a name tombstone nulls position.
      if ('seriesPosition' in payload) {
        if (payload.seriesPosition == null) {
          cleared.add('seriesPosition');
          storedBook = { ...storedBook, seriesPosition: null };
        } else {
          cleared.delete('seriesPosition');
          storedBook = { ...storedBook, seriesPosition: payload.seriesPosition };
        }
      } else if (payload.seriesName) {
        cleared.delete('seriesPosition');
      }
      if (cleared.has('seriesName') && ('seriesName' in payload || 'seriesPosition' in payload)) {
        storedBook = { ...storedBook, seriesPosition: null };
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

    await waitFor(() => expect(screen.getByText('Tress of the Emerald Sea')).toBeInTheDocument());
    // Provider metadata is a separate query; wait past the library-only first paint.
    await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

    // The modal must prefill from the same resolver decision or this clear is not expressible.
    await openEditModal(user);
    const seriesInput = screen.getByLabelText(/series$/i);
    expect(seriesInput).toHaveValue('Secret Projects');

    await user.clear(seriesInput);
    await user.click(screen.getByText('Save'));

    await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
    expect(api.updateBook).toHaveBeenCalledWith(1, { seriesName: null });

    await waitFor(() => expect(screen.queryByText(/Secret Projects/)).not.toBeInTheDocument());

    // A refetched tombstone, not a stale empty string, must suppress the fallback.
    expect(storedBook.userClearedFields).toEqual(['seriesName']);
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

    // Scope to the header; SeriesCard also renders the restored name.
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
    expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument();
  });

  describe('clearing the position alone (#2152 AC14)', () => {
    async function clearPosition(user: ReturnType<typeof userEvent.setup>) {
      await openEditModal(user);
      expect(screen.getByLabelText(/^position$/i)).toHaveValue('1');
      await user.clear(screen.getByLabelText(/^position$/i));
      await user.click(screen.getByText('Save'));
    }

    it('sends exactly { seriesPosition: null } and the header keeps the series with no #n', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

      await clearPosition(user);

      await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
      expect(api.updateBook).toHaveBeenCalledWith(1, { seriesPosition: null });
      expect(vi.mocked(api.updateBook).mock.calls[0]![1]).not.toHaveProperty('seriesName');

      await waitFor(() => expect(screen.queryByText(/Secret Projects #1/)).not.toBeInTheDocument());
      expect(screen.getByText(/Secret Projects/)).toBeInTheDocument();
      expect(storedBook.userClearedFields).toEqual(['seriesPosition']);
      expect(storedBook.seriesName).toBeNull();
    });

    it('the reopened modal shows Position BLANK and the Series still filled', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

      await clearPosition(user);
      await waitFor(() => expect(screen.queryByText(/Secret Projects #1/)).not.toBeInTheDocument());
      await openEditModal(user);

      expect(screen.getByLabelText(/^position$/i)).toHaveValue('');
      expect(screen.getByLabelText(/series$/i)).toHaveValue('Secret Projects');
    });

    it('saving the reopened modal untouched does not resurrect the position', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

      await clearPosition(user);
      await waitFor(() => expect(screen.queryByText(/Secret Projects #1/)).not.toBeInTheDocument());

      vi.mocked(api.updateBook).mockClear();
      await openEditModal(user);
      await user.click(screen.getByText('Save'));

      await waitFor(() => expect(api.updateBook).toHaveBeenCalled());
      expect(api.updateBook).toHaveBeenCalledWith(1, {});
      expect(storedBook.userClearedFields).toEqual(['seriesPosition']);
      expect(screen.queryByText(/Secret Projects #1/)).not.toBeInTheDocument();
    });

    it('typing a number back re-asserts: the tombstone lifts and the header shows it again', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByText(/Secret Projects #1/)).toBeInTheDocument());

      await clearPosition(user);
      await waitFor(() => expect(screen.queryByText(/Secret Projects #1/)).not.toBeInTheDocument());

      await openEditModal(user);
      await user.type(screen.getByLabelText(/^position$/i), '12');
      await user.click(screen.getByText('Save'));

      await waitFor(() => expect(screen.getByText(/Secret Projects #12/)).toBeInTheDocument());
      expect(storedBook.userClearedFields).toEqual([]);
    });
  });

  // Preserved barrel exports can reach real fetchApi; this guard catches unstubbed methods.
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
