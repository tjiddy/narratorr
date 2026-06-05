import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookFixMatchModal } from './BookFixMatchModal';
import { createMockBook, createMockBookMetadata } from '@/__tests__/factories';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api') as Record<string, unknown>;
  return {
    ...actual,
    api: {
      searchMetadata: vi.fn(),
      fixMatchBook: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

const mockBook = createMockBook({
  id: 7,
  title: 'Wrong Match',
  asin: 'B_OLD',
  seriesName: 'Old Series',
  seriesPosition: 1,
  authors: [{ id: 1, name: 'Author', slug: 'author' }],
  narrators: [{ id: 1, name: 'Old Narrator', slug: 'old-narrator' }],
  path: '/library/x',
});

function renderModal(invalidateSpy?: ReturnType<typeof vi.fn>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (invalidateSpy) {
    queryClient.invalidateQueries = invalidateSpy as unknown as typeof queryClient.invalidateQueries;
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <BookFixMatchModal book={mockBook} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookFixMatchModal (#1129)', () => {
  it('shows search view with prefilled query and renders search results', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [
        createMockBookMetadata({ asin: 'B_NEW', title: 'Right Match', authors: [{ name: 'New Author' }] }),
      ],
      authors: [],
      series: [],
    });
    renderModal();

    expect(screen.getByDisplayValue(/Wrong Match Author/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(screen.getByText('Right Match')).toBeInTheDocument());
  });

  it('confirmation step displays old vs new identity comparison', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [
        createMockBookMetadata({
          asin: 'B_NEW',
          title: 'New Title',
          authors: [{ name: 'New Author' }],
          narrators: ['New Narrator'],
          seriesPrimary: { name: 'New Series', position: 2, asin: 'SERIES_NEW' },
        }),
      ],
      authors: [],
      series: [],
    });
    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('New Title')).toBeInTheDocument());

    await user.click(screen.getByText('New Title'));

    expect(screen.getByText('Confirm match')).toBeInTheDocument();
    expect(screen.getByText('Old Series #1')).toBeInTheDocument();
    expect(screen.getByText('New Series #2')).toBeInTheDocument();
    expect(screen.getAllByText('New Title').length).toBeGreaterThan(0);
    expect(screen.getByText('Old Narrator')).toBeInTheDocument();
    expect(screen.getByText('New Narrator')).toBeInTheDocument();
  });

  // #1226 — the identity comparison must strike through ONLY the field that
  // actually differs, and grey unchanged fields on BOTH sides. We locate each
  // comparison row by its label cell (children[0]) and inspect the old (1) and
  // new (2) value cells directly, avoiding ambiguous text selectors for values
  // that are intentionally identical on both columns (F2).
  function getComparisonRow(label: string): HTMLElement {
    const rows = Array.from(document.body.querySelectorAll<HTMLElement>('div')).filter(
      (el) =>
        el.className.includes('grid-cols-[100px_1fr_1fr]') &&
        el.children.length === 3 &&
        el.children[0]?.textContent === label,
    );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('strikes through only the changed field and greys unchanged rows on both sides (#1226)', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [
        // Title/Author/Narrator/Year identical to mockBook — only Series differs.
        createMockBookMetadata({
          asin: 'B_NEW',
          title: 'Wrong Match',
          authors: [{ name: 'Author' }],
          narrators: ['Old Narrator'],
          publishedDate: '2010-08-31',
          seriesPrimary: { name: 'New Series', position: 2, asin: 'SERIES_NEW' },
          series: undefined,
        }),
      ],
      authors: [],
      series: [],
    });
    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('Wrong Match')).toBeInTheDocument());
    await user.click(screen.getByText('Wrong Match'));

    expect(screen.getByText('Confirm match')).toBeInTheDocument();

    // Changed field (Series): old value struck through + muted, new value amber.
    const seriesRow = getComparisonRow('Series');
    const seriesOld = seriesRow.children[1]!;
    const seriesNew = seriesRow.children[2]!;
    expect(seriesOld.className).toContain('line-through');
    expect(seriesOld.className).toContain('text-muted-foreground');
    expect(seriesOld.className).not.toContain('text-muted-foreground/40');
    expect(seriesNew.className).toContain('text-primary');

    // Unchanged fields: no strikethrough, both sides greyed (text-muted-foreground/40).
    for (const label of ['Title', 'Author', 'Narrator', 'Year']) {
      const row = getComparisonRow(label);
      const oldCell = row.children[1]!;
      const newCell = row.children[2]!;
      expect(oldCell.className).not.toContain('line-through');
      expect(oldCell.className).toContain('text-muted-foreground/40');
      expect(newCell.className).toContain('text-muted-foreground/40');
      expect(newCell.className).not.toContain('text-primary');
    }
  });

  it('greys the entire comparison table with no strikethrough when every field is identical (#1226)', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [
        // Every identity field matches mockBook — the table should fully recede.
        createMockBookMetadata({
          asin: 'B_NEW',
          title: 'Wrong Match',
          authors: [{ name: 'Author' }],
          narrators: ['Old Narrator'],
          publishedDate: '2010-08-31',
          seriesPrimary: { name: 'Old Series', position: 1, asin: 'SERIES_OLD' },
          series: undefined,
        }),
      ],
      authors: [],
      series: [],
    });
    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('Wrong Match')).toBeInTheDocument());
    await user.click(screen.getByText('Wrong Match'));

    expect(screen.getByText('Confirm match')).toBeInTheDocument();

    for (const label of ['Title', 'Author', 'Narrator', 'Series', 'Year']) {
      const row = getComparisonRow(label);
      const oldCell = row.children[1]!;
      const newCell = row.children[2]!;
      expect(oldCell.className).not.toContain('line-through');
      expect(oldCell.className).toContain('text-muted-foreground/40');
      expect(newCell.className).toContain('text-muted-foreground/40');
    }
  });

  it('confirmation step shows Standalone when new record has no series', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [
        createMockBookMetadata({
          asin: 'B_STANDALONE',
          title: 'Standalone Title',
          authors: [{ name: 'Author' }],
          seriesPrimary: undefined,
          series: undefined,
        }),
      ],
      authors: [],
      series: [],
    });
    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('Standalone Title')).toBeInTheDocument());

    await user.click(screen.getByText('Standalone Title'));

    expect(screen.getByText('Standalone')).toBeInTheDocument();
  });

  it('confirm sends fix-match POST and invalidates expected queries on success', async () => {
    const user = userEvent.setup();
    const invalidateSpy = vi.fn();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [createMockBookMetadata({ asin: 'B_NEW', title: 'New Title', authors: [{ name: 'New Author' }] })],
      authors: [],
      series: [],
    });
    (api.fixMatchBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...mockBook, asin: 'B_NEW', title: 'New Title' });

    renderModal(invalidateSpy);
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('New Title')).toBeInTheDocument());
    await user.click(screen.getByText('New Title'));
    await user.click(screen.getByRole('button', { name: /replace match/i }));

    await waitFor(() => {
      expect(api.fixMatchBook).toHaveBeenCalledWith(7, expect.objectContaining({ asin: 'B_NEW' }));
    });
    const calls = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(calls).toContain(JSON.stringify(queryKeys.book(7)));
    expect(calls).toContain(JSON.stringify(queryKeys.books()));
    expect(calls).toContain(JSON.stringify(queryKeys.metadata.book('B_OLD')));
    expect(calls).toContain(JSON.stringify(queryKeys.metadata.book('B_NEW')));
    expect(calls).toContain(JSON.stringify(['book', 7, 'series']));
  });

  it('surfaces 409 collision error without closing modal', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [createMockBookMetadata({ asin: 'B_DUP', title: 'Dup Title', authors: [{ name: 'A' }] })],
      authors: [],
      series: [],
    });
    (api.fixMatchBook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, { error: 'ASIN already in library', conflictBookId: 99, conflictTitle: 'Other Book' }),
    );

    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('Dup Title')).toBeInTheDocument());
    await user.click(screen.getByText('Dup Title'));
    await user.click(screen.getByRole('button', { name: /replace match/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Other Book'));
    expect(screen.getByText('Confirm match')).toBeInTheDocument();
  });

  it('surfaces 503 rate-limit error with retry-after seconds', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [createMockBookMetadata({ asin: 'B_RL', title: 'RL Title', authors: [{ name: 'A' }] })],
      authors: [],
      series: [],
    });
    (api.fixMatchBook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(503, { error: 'Provider rate limited', retryAfterMs: 15_000 }),
    );

    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('RL Title')).toBeInTheDocument());
    await user.click(screen.getByText('RL Title'));
    await user.click(screen.getByRole('button', { name: /replace match/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/15s/));
  });

  it('surfaces 422 / 502 / 404 generic errors without closing modal', async () => {
    const user = userEvent.setup();
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      books: [createMockBookMetadata({ asin: 'B_X', title: 'X Title', authors: [{ name: 'A' }] })],
      authors: [],
      series: [],
    });
    (api.fixMatchBook as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(422, { error: 'Incomplete provider record' }),
    );

    renderModal();
    await user.click(screen.getByRole('button', { name: /search/i }));
    await waitFor(() => expect(screen.getByText('X Title')).toBeInTheDocument());
    await user.click(screen.getByText('X Title'));
    await user.click(screen.getByRole('button', { name: /replace match/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Incomplete provider record'));
  });

  describe('rename/retag checkbox payload wiring (F3)', () => {
    async function selectMatchAndOpenConfirm() {
      const user = userEvent.setup();
      (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        books: [createMockBookMetadata({ asin: 'B_NEW', title: 'New Title', authors: [{ name: 'New Author' }] })],
        authors: [],
        series: [],
      });
      (api.fixMatchBook as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...mockBook, asin: 'B_NEW', title: 'New Title' });
      renderModal();
      await user.click(screen.getByRole('button', { name: /search/i }));
      await waitFor(() => expect(screen.getByText('New Title')).toBeInTheDocument());
      await user.click(screen.getByText('New Title'));
      return user;
    }

    it('default (unchecked) payload omits renameFiles and retagFiles', async () => {
      const user = await selectMatchAndOpenConfirm();
      await user.click(screen.getByRole('button', { name: /replace match/i }));

      await waitFor(() => expect(api.fixMatchBook).toHaveBeenCalled());
      expect(api.fixMatchBook).toHaveBeenCalledWith(7, { asin: 'B_NEW' });
      const payload = (api.fixMatchBook as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(payload).not.toHaveProperty('renameFiles');
      expect(payload).not.toHaveProperty('retagFiles');
    });

    it('checking "Rename files after rematch" adds renameFiles: true to the payload', async () => {
      const user = await selectMatchAndOpenConfirm();
      await user.click(screen.getByLabelText(/rename files after rematch/i));
      await user.click(screen.getByRole('button', { name: /replace match/i }));

      await waitFor(() => expect(api.fixMatchBook).toHaveBeenCalled());
      expect(api.fixMatchBook).toHaveBeenCalledWith(7, { asin: 'B_NEW', renameFiles: true });
    });

    it('checking "Re-tag audio files after rematch" adds retagFiles: true to the payload', async () => {
      const user = await selectMatchAndOpenConfirm();
      await user.click(screen.getByLabelText(/re-tag audio files after rematch/i));
      await user.click(screen.getByRole('button', { name: /replace match/i }));

      await waitFor(() => expect(api.fixMatchBook).toHaveBeenCalled());
      expect(api.fixMatchBook).toHaveBeenCalledWith(7, { asin: 'B_NEW', retagFiles: true });
    });

    it('checking both adds both flags to the payload', async () => {
      const user = await selectMatchAndOpenConfirm();
      await user.click(screen.getByLabelText(/rename files after rematch/i));
      await user.click(screen.getByLabelText(/re-tag audio files after rematch/i));
      await user.click(screen.getByRole('button', { name: /replace match/i }));

      await waitFor(() => expect(api.fixMatchBook).toHaveBeenCalled());
      expect(api.fixMatchBook).toHaveBeenCalledWith(7, {
        asin: 'B_NEW',
        renameFiles: true,
        retagFiles: true,
      });
    });
  });

  describe('dismissal via base Modal (#1219)', () => {
    function renderWithOnClose(onClose: () => void) {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <BookFixMatchModal book={mockBook} onClose={onClose} />
        </QueryClientProvider>,
      );
    }

    it('pressing Escape calls onClose (dismissal centralized in base Modal)', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithOnClose(onClose);

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('clicking the backdrop does NOT call onClose and leaves the dialog open', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithOnClose(onClose);

      await user.click(screen.getByTestId('modal-backdrop'));

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
