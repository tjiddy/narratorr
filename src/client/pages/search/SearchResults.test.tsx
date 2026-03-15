import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SearchResults } from './SearchResults';
import { createMockBookMetadata, createMockAuthorMetadata } from '@/__tests__/factories';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      getBooks: vi.fn().mockResolvedValue([]),
      addBook: vi.fn(),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

function renderResults(props: Partial<Parameters<typeof SearchResults>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const defaultProps = {
    results: undefined as { books: ReturnType<typeof createMockBookMetadata>[]; authors: ReturnType<typeof createMockAuthorMetadata>[] } | undefined,
    searchTerm: '',
    isLoading: false,
    queryClient,
    ...props,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SearchResults {...defaultProps} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SearchResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Start your search empty state when no search term', () => {
    renderResults({ searchTerm: '' });
    expect(screen.getByText('Start your search')).toBeInTheDocument();
  });

  it('shows No results empty state when search has no results', () => {
    renderResults({
      searchTerm: 'nonexistent',
      results: { books: [], authors: [] },
    });
    expect(screen.getByText('No results for "nonexistent"')).toBeInTheDocument();
  });

  it('returns null when results is undefined but searchTerm exists', () => {
    renderResults({
      searchTerm: 'searching',
      results: undefined,
      isLoading: true,
    });
    // Should not show empty state while loading
    expect(screen.queryByText('Start your search')).not.toBeInTheDocument();
    expect(screen.queryByText(/No results/)).not.toBeInTheDocument();
  });

  it('renders tab buttons with result counts', () => {
    const results = {
      books: [createMockBookMetadata()],
      authors: [createMockAuthorMetadata(), createMockAuthorMetadata({ name: 'Author 2', asin: 'B00OTHER' })],
    };
    renderResults({ searchTerm: 'fantasy', results });
    expect(screen.getByText('(1)')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('switches to Authors tab on click', async () => {
    const user = userEvent.setup();
    const results = {
      books: [createMockBookMetadata()],
      authors: [createMockAuthorMetadata()],
    };
    renderResults({ searchTerm: 'fantasy', results });

    // Books tab shown by default — book title visible
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();

    // Click Authors tab
    await user.click(screen.getByText('Authors', { exact: false }));

    // Author content now visible, book content hidden
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders BooksTabContent by default', () => {
    const results = {
      books: [createMockBookMetadata()],
      authors: [],
    };
    renderResults({ searchTerm: 'fantasy', results });
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });

  describe('tab ARIA roles and keyboard navigation', () => {
    const resultsWithBoth = {
      books: [createMockBookMetadata()],
      authors: [createMockAuthorMetadata()],
    };

    it('renders tab container with role="tablist" and aria-label', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tablist = screen.getByRole('tablist');
      expect(tablist).toHaveAttribute('aria-label');
    });

    it('renders each tab button with role="tab"', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
    });

    it('sets aria-selected="true" on active tab and "false" on inactive', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    });

    it('renders tab panel with role="tabpanel" and aria-labelledby', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const panel = screen.getByRole('tabpanel');
      const tabs = screen.getAllByRole('tab');
      expect(panel).toHaveAttribute('aria-labelledby', tabs[0].id);
    });

    it('tab buttons have non-empty ids for ARIA linkage', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0].id).toBeTruthy();
      expect(tabs[1].id).toBeTruthy();
      expect(tabs[0].id).not.toBe(tabs[1].id);
    });

    it('switching to Authors swaps tabpanel linkage to Authors tab', async () => {
      const user = userEvent.setup();
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');

      await user.click(tabs[1]);

      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-authors');
    });

    it('ArrowRight auto-activates Authors tab and swaps panel', async () => {
      const user = userEvent.setup();
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');

      tabs[0].focus();
      await user.keyboard('{ArrowRight}');

      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'false');
      expect(document.activeElement).toBe(tabs[1]);
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-authors');
    });

    it('ArrowLeft from Authors activates Books tab and swaps panel back', async () => {
      const user = userEvent.setup();
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');

      // Switch to Authors first
      await user.click(tabs[1]);
      tabs[1].focus();
      await user.keyboard('{ArrowLeft}');

      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
      expect(document.activeElement).toBe(tabs[0]);
      const panel = screen.getByRole('tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', 'tab-books');
    });

    it('arrow keys wrap around — Right on Authors wraps to Books, Left on Books wraps to Authors', async () => {
      const user = userEvent.setup();
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');

      // Right on last (Authors) → wraps to first (Books)
      await user.click(tabs[1]);
      tabs[1].focus();
      await user.keyboard('{ArrowRight}');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(tabs[0]);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-books');

      // Left on first (Books) → wraps to last (Authors)
      tabs[0].focus();
      await user.keyboard('{ArrowLeft}');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(tabs[1]);
      expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'tab-authors');
    });

    it('tab count badges do not interfere with ARIA attributes', () => {
      renderResults({ searchTerm: 'fantasy', results: resultsWithBoth });
      const tabs = screen.getAllByRole('tab');
      expect(tabs[0]).toHaveAttribute('role', 'tab');
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('role', 'tab');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
      expect(screen.getAllByText('(1)')).toHaveLength(2);
    });
  });
});
