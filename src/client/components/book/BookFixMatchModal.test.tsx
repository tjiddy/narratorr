import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookFixMatchModal } from './BookFixMatchModal';
import { createMockBook, createMockBookMetadata } from '@/__tests__/factories';
import { ApiError } from '@/lib/api';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
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
});
