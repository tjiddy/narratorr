import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { DiscoverPage } from './DiscoverPage';
import type { SuggestionRow, BookStats } from '@/lib/api';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getDiscoverSuggestions: vi.fn(),
    addDiscoverSuggestion: vi.fn(),
    dismissDiscoverSuggestion: vi.fn(),
    refreshDiscover: vi.fn(),
    getDiscoverStats: vi.fn(),
    getBookStats: vi.fn(),
  },
  ApiError: class extends Error {
    status: number;
    body: unknown;
    constructor(s: number, b: unknown) { super(`HTTP ${s}`); this.status = s; this.body = b; }
  },
}));

import { api } from '@/lib/api';
const mockApi = api as unknown as {
  getDiscoverSuggestions: ReturnType<typeof vi.fn>;
  addDiscoverSuggestion: ReturnType<typeof vi.fn>;
  dismissDiscoverSuggestion: ReturnType<typeof vi.fn>;
  refreshDiscover: ReturnType<typeof vi.fn>;
  getDiscoverStats: ReturnType<typeof vi.fn>;
  getBookStats: ReturnType<typeof vi.fn>;
};

function makeSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: 1,
    asin: 'B001',
    title: 'Test Book',
    authorName: 'Test Author',
    narratorName: 'Test Narrator',
    coverUrl: null,
    duration: 3600,
    publishedDate: null,
    language: null,
    genres: null,
    seriesName: null,
    seriesPosition: null,
    reason: 'author',
    reasonContext: 'Because you like Test Author',
    score: 80,
    status: 'pending',
    refreshedAt: '2026-01-01T00:00:00Z',
    dismissedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeStats(overrides: Partial<BookStats['counts']> = {}): BookStats {
  return {
    counts: { wanted: 5, downloading: 0, imported: 10, failed: 0, missing: 0, ...overrides },
    authors: ['Author A'],
    series: [],
    narrators: ['Narrator A'],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockApi.getDiscoverStats.mockResolvedValue({});
});

describe('DiscoverPage', () => {
  describe('suggestion grid', () => {
    it('renders suggestion cards when API returns suggestions', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Book One' }),
        makeSuggestion({ id: 2, title: 'Book Two', reason: 'series' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Book One')).toBeInTheDocument();
      });
      expect(screen.getByText('Book Two')).toBeInTheDocument();
    });

    it('shows loading skeleton during initial fetch', () => {
      mockApi.getDiscoverSuggestions.mockReturnValue(new Promise(() => {})); // never resolves
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      expect(screen.getByTestId('discover-skeleton')).toBeInTheDocument();
    });

    it('shows "no library books" empty state when useBookStats returns zero total', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([]);
      mockApi.getBookStats.mockResolvedValue(makeStats({
        wanted: 0, downloading: 0, imported: 0, failed: 0, missing: 0,
      }));

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByTestId('discover-empty')).toBeInTheDocument();
      });
      expect(screen.getByText(/add some books to your library/i)).toBeInTheDocument();
    });

    it('shows "no suggestions" empty state when library has books but suggestions array is empty', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByTestId('discover-empty')).toBeInTheDocument();
      });
      expect(screen.getByText(/no new suggestions right now/i)).toBeInTheDocument();
    });

    it('shows error fallback when API request rejects', async () => {
      mockApi.getDiscoverSuggestions.mockRejectedValue(new Error('Network error'));
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByTestId('discover-error')).toBeInTheDocument();
      });
    });
  });

  describe('filter chips', () => {
    it('selecting "Author" filters cards to reason === "author" only', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Author Book', reason: 'author' }),
        makeSuggestion({ id: 2, title: 'Series Book', reason: 'series' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Author Book')).toBeInTheDocument();
      });
      expect(screen.getByText('Series Book')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Author' }));

      expect(screen.getByText('Author Book')).toBeInTheDocument();
      expect(screen.queryByText('Series Book')).not.toBeInTheDocument();
    });

    it('selecting "All" resets filter to show all suggestions', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Author Book', reason: 'author' }),
        makeSuggestion({ id: 2, title: 'Series Book', reason: 'series' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Author Book')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: 'Author' }));
      expect(screen.queryByText('Series Book')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(screen.getByText('Series Book')).toBeInTheDocument();
    });

    it('selecting a filter with zero matches shows inline "no matches" message', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, reason: 'author' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: 'Genre' }));

      expect(screen.getByTestId('no-filter-matches')).toBeInTheDocument();
    });
  });

  describe('hero section', () => {
    it('shows "Showing X suggestions" where X matches visible card count after filter', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, reason: 'author' }),
        makeSuggestion({ id: 2, reason: 'series' }),
        makeSuggestion({ id: 3, reason: 'author' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByTestId('suggestion-count')).toHaveTextContent('Showing 3 suggestions');
      });

      await userEvent.click(screen.getByRole('button', { name: 'Author' }));

      expect(screen.getByTestId('suggestion-count')).toHaveTextContent('Showing 2 suggestions');
    });
  });

  describe('refresh', () => {
    it('refresh button calls refreshDiscover() and shows loading indicator', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion()]);
      mockApi.getBookStats.mockResolvedValue(makeStats());
      mockApi.refreshDiscover.mockReturnValue(new Promise(() => {})); // never resolves

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Refresh'));

      expect(mockApi.refreshDiscover).toHaveBeenCalled();
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });

    it('refresh success clears optimistic removals, shows success toast', async () => {
      const { toast } = await import('sonner');
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Will Dismiss' }),
        makeSuggestion({ id: 2, title: 'Stays' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());
      // Dismiss will succeed and hide the card
      mockApi.dismissDiscoverSuggestion.mockResolvedValue({ id: 1, status: 'dismissed' });
      mockApi.refreshDiscover.mockResolvedValue({});

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Will Dismiss')).toBeInTheDocument();
      });

      // Dismiss a card — it disappears optimistically
      await userEvent.click(screen.getByLabelText(/dismiss.*will dismiss/i));
      expect(screen.queryByText('Will Dismiss')).not.toBeInTheDocument();

      // Click Refresh — should clear removedIds and show the card again
      await userEvent.click(screen.getByText('Refresh'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Suggestions refreshed');
      });
      // Card visible again since removedIds was cleared
      expect(screen.getByText('Will Dismiss')).toBeInTheDocument();
    });

    it('refresh failure shows error toast', async () => {
      const { toast } = await import('sonner');
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion()]);
      mockApi.getBookStats.mockResolvedValue(makeStats());
      mockApi.refreshDiscover.mockRejectedValue(new Error('server error'));

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Refresh')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByText('Refresh'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to refresh suggestions');
      });
    });

    it('no-suggestions empty state renders Refresh button and hero count', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByTestId('discover-empty')).toBeInTheDocument();
      });
      // Verify header affordances are present in no-suggestions state
      expect(screen.getByText('Refresh')).toBeInTheDocument();
      expect(screen.getByTestId('suggestion-count')).toHaveTextContent('Showing 0 suggestions');
    });
  });

  describe('mutations', () => {
    it('add optimistically removes card, shows success toast on resolve', async () => {
      const { toast } = await import('sonner');
      let resolveAdd!: (value: unknown) => void;
      mockApi.addDiscoverSuggestion.mockReturnValue(new Promise((r) => { resolveAdd = r; }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 42, title: 'Add Me' }),
        makeSuggestion({ id: 43, title: 'Keep Me' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Add Me')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByLabelText(/add.*add me.*to library/i));

      // Card disappears optimistically before mutation resolves
      expect(screen.queryByText('Add Me')).not.toBeInTheDocument();
      expect(screen.getByText('Keep Me')).toBeInTheDocument();
      expect(mockApi.addDiscoverSuggestion).toHaveBeenCalledWith(42);

      // Resolve the mutation
      resolveAdd({ suggestion: { id: 42, status: 'added' }, book: { id: 10 } });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Added to library');
      });
    });

    it('add restores card on mutation failure and shows error toast', async () => {
      const { toast } = await import('sonner');
      let rejectAdd!: (reason: Error) => void;
      mockApi.addDiscoverSuggestion.mockReturnValue(new Promise((_r, rej) => { rejectAdd = rej; }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Fail Add' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Fail Add')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByLabelText(/add.*to library/i));

      // Card disappears optimistically (mutation still pending)
      expect(screen.queryByText('Fail Add')).not.toBeInTheDocument();

      // Now reject the mutation
      rejectAdd(new Error('network'));

      // Card reappears after error
      await waitFor(() => {
        expect(screen.getByText('Fail Add')).toBeInTheDocument();
      });
      expect(toast.error).toHaveBeenCalledWith('Failed to add suggestion');
    });

    it('dismiss optimistically removes card, shows success toast on resolve', async () => {
      const { toast } = await import('sonner');
      let resolveDismiss!: (value: unknown) => void;
      mockApi.dismissDiscoverSuggestion.mockReturnValue(new Promise((r) => { resolveDismiss = r; }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 7, title: 'Dismiss Me' }),
        makeSuggestion({ id: 8, title: 'Stay Here' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Dismiss Me')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByLabelText(/dismiss.*dismiss me/i));

      // Card disappears optimistically
      expect(screen.queryByText('Dismiss Me')).not.toBeInTheDocument();
      expect(screen.getByText('Stay Here')).toBeInTheDocument();
      expect(mockApi.dismissDiscoverSuggestion).toHaveBeenCalledWith(7);

      // Resolve
      resolveDismiss({ id: 7, status: 'dismissed' });

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Suggestion dismissed');
      });
    });

    it('dismiss restores card on mutation failure and shows error toast', async () => {
      const { toast } = await import('sonner');
      let rejectDismiss!: (reason: Error) => void;
      mockApi.dismissDiscoverSuggestion.mockReturnValue(new Promise((_r, rej) => { rejectDismiss = rej; }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Fail Dismiss' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Fail Dismiss')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByLabelText(/dismiss.*fail dismiss/i));

      // Card disappears optimistically (mutation still pending)
      expect(screen.queryByText('Fail Dismiss')).not.toBeInTheDocument();

      // Now reject the mutation
      rejectDismiss(new Error('network'));

      // Card reappears after error
      await waitFor(() => {
        expect(screen.getByText('Fail Dismiss')).toBeInTheDocument();
      });
      expect(toast.error).toHaveBeenCalledWith('Failed to dismiss suggestion');
    });
  });
});
