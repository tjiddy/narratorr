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
});
