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
    addBook: vi.fn(),
    markDiscoverSuggestionAdded: vi.fn(),
    dismissDiscoverSuggestion: vi.fn(),
    refreshDiscover: vi.fn(),
    getDiscoverStats: vi.fn(),
    getBookStats: vi.fn(),
    getSettings: vi.fn(),
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
  addBook: ReturnType<typeof vi.fn>;
  markDiscoverSuggestionAdded: ReturnType<typeof vi.fn>;
  dismissDiscoverSuggestion: ReturnType<typeof vi.fn>;
  refreshDiscover: ReturnType<typeof vi.fn>;
  getDiscoverStats: ReturnType<typeof vi.fn>;
  getBookStats: ReturnType<typeof vi.fn>;
  getSettings: ReturnType<typeof vi.fn>;
};

function makeSuggestion(overrides: Partial<SuggestionRow> = {}): SuggestionRow {
  return {
    id: 1,
    asin: 'B001',
    title: 'Test Book',
    authorName: 'Test Author',
    authorAsin: null,
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
    snoozeUntil: null,
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

function makeSettings(overrides?: { languages?: string[]; rejectWords?: string }) {
  return {
    quality: {
      grabFloor: 0,
      protocolPreference: 'none' as const,
      minSeeders: 1,
      searchImmediately: false,
      monitorForUpgrades: false,
      rejectWords: overrides?.rejectWords ?? '',
      requiredWords: '',
    },
    metadata: {
      audibleRegion: 'us' as const,
      languages: overrides?.languages ?? ['english'],
    },
    general: { urlBase: '', port: 3000, logLevel: 'info' },
    download: {},
    naming: {},
    network: {},
    search: {},
    import: {},
    processing: {},
    library: {},
    discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 },
    notifications: {},
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockApi.getDiscoverStats.mockResolvedValue({});
  mockApi.getSettings.mockResolvedValue(makeSettings());
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
    it('add keeps card visible, shows success toast and checkmark on resolve', async () => {
      const { toast } = await import('sonner');
      mockApi.addBook.mockResolvedValue({ id: 10, title: 'Add Me' });
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 42, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 42, title: 'Add Me' }),
        makeSuggestion({ id: 43, title: 'Keep Me' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Add Me')).toBeInTheDocument();
      });

      // Click Add to open popover, then confirm
      const addButtons = screen.getAllByRole('button', { name: /^add book$/i });
      await userEvent.click(addButtons[0]);
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      // Card stays visible (no optimistic remove)
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Added to library');
      });
      expect(screen.getByText('Add Me')).toBeInTheDocument();
      expect(screen.getByText('Keep Me')).toBeInTheDocument();
    });

    it('add shows error toast on mutation failure', async () => {
      const { toast } = await import('sonner');
      mockApi.addBook.mockRejectedValue(new Error('network'));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Fail Add' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Fail Add')).toBeInTheDocument();
      });

      // Click Add to open popover, then confirm
      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to add book'));
      });
      // Card should still be visible
      expect(screen.getByText('Fail Add')).toBeInTheDocument();
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

  // --- #501: Client-side language and reject word filtering ---

  describe('language filtering', () => {
    it('hides suggestions with language not in user configured languages', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ languages: ['english'] }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'English Book', language: 'english' }),
        makeSuggestion({ id: 2, title: 'German Book', language: 'german' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('English Book')).toBeInTheDocument();
      });
      expect(screen.queryByText('German Book')).not.toBeInTheDocument();
    });

    it('shows suggestions with null language (not filtered out)', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ languages: ['english'] }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Unknown Language Book', language: null }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Unknown Language Book')).toBeInTheDocument();
      });
    });

    it('shows all suggestions when language settings array is empty', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ languages: [] }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Any Language Book', language: 'french' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Any Language Book')).toBeInTheDocument();
      });
    });
  });

  describe('reject word filtering', () => {
    it('hides suggestions whose title contains a reject word (case-insensitive)', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ rejectWords: 'abridged, demo' }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Good Book' }),
        makeSuggestion({ id: 2, title: 'The Abridged Version' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Good Book')).toBeInTheDocument();
      });
      expect(screen.queryByText('The Abridged Version')).not.toBeInTheDocument();
    });

    it('shows all suggestions when reject words setting is empty', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ rejectWords: '' }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Any Book' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Any Book')).toBeInTheDocument();
      });
    });

    it('renders all suggestions when settings query fails (no filtering)', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings fetch failed'));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'French Book', language: 'french' }),
        makeSuggestion({ id: 2, title: 'English Book', language: 'english' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      // Both should render — no filtering when settings unavailable
      await waitFor(() => {
        expect(screen.getByText('French Book')).toBeInTheDocument();
      });
      expect(screen.getByText('English Book')).toBeInTheDocument();
      // Should NOT show error state
      expect(screen.queryByTestId('discover-error')).not.toBeInTheDocument();
    });

    it('combines language filter + reject word filter (AND logic)', async () => {
      mockApi.getSettings.mockResolvedValue(makeSettings({ languages: ['english'], rejectWords: 'abridged' }));
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Good English Book', language: 'english' }),
        makeSuggestion({ id: 2, title: 'Abridged English Book', language: 'english' }),
        makeSuggestion({ id: 3, title: 'Good German Book', language: 'german' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Good English Book')).toBeInTheDocument();
      });
      expect(screen.queryByText('Abridged English Book')).not.toBeInTheDocument();
      expect(screen.queryByText('Good German Book')).not.toBeInTheDocument();
    });
  });

  describe('add mutation with overrides', () => {
    it('card stays visible after add — suggestions query not refetched', async () => {
      mockApi.addBook.mockResolvedValue({ id: 10, title: 'Added Book' });
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 42, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 42, title: 'Added Book' }),
        makeSuggestion({ id: 43, title: 'Other Book' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Added Book')).toBeInTheDocument();
      });

      // Record call count before add
      const callsBefore = mockApi.getDiscoverSuggestions.mock.calls.length;

      // Click Add to open popover, then confirm
      const addButtons = screen.getAllByRole('button', { name: /^add book$/i });
      await userEvent.click(addButtons[0]);
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      // Card should still be visible with checkmark state
      await waitFor(() => {
        expect(screen.getByText('Added Book')).toBeInTheDocument();
      });
      expect(screen.getByText('Other Book')).toBeInTheDocument();

      // The added card shows the "In library" checkmark and no longer has an Add button
      expect(screen.getByLabelText('In library')).toBeInTheDocument();
      // Other Book should still have its Add button
      const remainingAddButtons = screen.getAllByRole('button', { name: /^add book$/i });
      expect(remainingAddButtons).toHaveLength(1); // only Other Book's Add button

      // Suggestions query should NOT have been re-fetched after add
      expect(mockApi.getDiscoverSuggestions.mock.calls.length).toBe(callsBefore);
    });
  });

  // -------------------------------------------------------------------------
  // Diversity filter (#407)
  // -------------------------------------------------------------------------

  describe('diversity filter option', () => {
    it('renders Diversity option in filter dropdown', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Diversity' })).toBeInTheDocument();
      });
    });

    it('filters suggestions to only diversity reason when Diversity selected', async () => {
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({ id: 1, title: 'Author Book', reason: 'author' }),
        makeSuggestion({ id: 2, title: 'Diverse Book', reason: 'diversity', reasonContext: 'Something different — explore Mystery' }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);

      await waitFor(() => {
        expect(screen.getByText('Author Book')).toBeInTheDocument();
      });
      expect(screen.getByText('Diverse Book')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Diversity' }));

      expect(screen.getByText('Diverse Book')).toBeInTheDocument();
      expect(screen.queryByText('Author Book')).not.toBeInTheDocument();
    });
  });

  // --- #524: unified add flow via api.addBook + mark-added ---
  describe('unified add flow', () => {
    it('calls api.addBook with full inline payload including authorAsin, publishedDate, and overrides', async () => {
      mockApi.addBook.mockResolvedValue({ id: 10 });
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 1, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([
        makeSuggestion({
          id: 1, title: 'ASIN Book', authorName: 'Joe', authorAsin: 'A123',
          asin: 'B001', duration: 3600, publishedDate: '2024-06-15',
          narratorName: 'Narrator', seriesName: 'Epic', seriesPosition: 2, genres: ['Fantasy'],
        }),
      ]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('ASIN Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(mockApi.addBook).toHaveBeenCalledWith(expect.objectContaining({
          title: 'ASIN Book',
          authors: [{ name: 'Joe', asin: 'A123' }],
          asin: 'B001',
          duration: 3600,
          publishedDate: '2024-06-15',
          narrators: ['Narrator'],
          seriesName: 'Epic',
          seriesPosition: 2,
          genres: ['Fantasy'],
          searchImmediately: expect.any(Boolean),
          monitorForUpgrades: expect.any(Boolean),
        }));
      });
    });

    it('calls mark-added endpoint after successful addBook', async () => {
      mockApi.addBook.mockResolvedValue({ id: 10 });
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 1, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion({ id: 1 })]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('Test Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(mockApi.markDiscoverSuggestionAdded).toHaveBeenCalledWith(1);
      });
    });

    it('treats addBook 409 as success and marks suggestion added', async () => {
      const { ApiError: MockApiError } = await import('@/lib/api');
      const { toast } = await import('sonner');
      mockApi.addBook.mockRejectedValue(new MockApiError(409, {}));
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 1, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion({ id: 1 })]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('Test Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith('Already in library');
      });
      expect(mockApi.markDiscoverSuggestionAdded).toHaveBeenCalledWith(1);
    });

    it('does not call mark-added on addBook non-409 failure', async () => {
      const { toast } = await import('sonner');
      mockApi.addBook.mockRejectedValue(new Error('server error'));
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion({ id: 1 })]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('Test Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to add book'));
      });
      expect(mockApi.markDiscoverSuggestionAdded).not.toHaveBeenCalled();
    });
  });

  // #547: markAdded fire-and-forget error logging
  describe('markAdded error logging (#547)', () => {
    it('logs console.warn when markDiscoverSuggestionAdded rejects and preserves optimistic added state', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockApi.addBook.mockResolvedValue({ id: 10 });
      mockApi.markDiscoverSuggestionAdded.mockRejectedValue(new Error('Network error'));
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion({ id: 1 })]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('Test Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith('mark-added failed:', expect.any(Error));
      });

      // Optimistic added state is preserved despite rejection
      expect(screen.getByText('Test Book')).toBeInTheDocument();
      expect(screen.getByLabelText('In library')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^add book$/i })).not.toBeInTheDocument();

      warnSpy.mockRestore();
    });

    it('does not log warnings on successful markAdded', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockApi.addBook.mockResolvedValue({ id: 10 });
      mockApi.markDiscoverSuggestionAdded.mockResolvedValue({ suggestion: { id: 1, status: 'added' } });
      mockApi.getDiscoverSuggestions.mockResolvedValue([makeSuggestion({ id: 1 })]);
      mockApi.getBookStats.mockResolvedValue(makeStats());

      renderWithProviders(<DiscoverPage />);
      await waitFor(() => { expect(screen.getByText('Test Book')).toBeInTheDocument(); });

      await userEvent.click(screen.getByRole('button', { name: /^add book$/i }));
      await userEvent.click(screen.getByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(mockApi.markDiscoverSuggestionAdded).toHaveBeenCalledWith(1);
      });
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
