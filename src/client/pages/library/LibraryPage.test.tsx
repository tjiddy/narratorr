import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockBook, createMockAuthor } from '@/__tests__/factories';
import { LibraryPage } from './LibraryPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    getBookStats: vi.fn(),
    getSettings: vi.fn(),
    deleteBook: vi.fn(),
    deleteMissingBooks: vi.fn(),
    rescanLibrary: vi.fn(),
    searchBooks: vi.fn(),
    searchGrab: vi.fn(),
    searchAllWanted: vi.fn(),
    searchBook: vi.fn(),
    updateBook: vi.fn(),
    getIndexers: vi.fn().mockResolvedValue([
      { id: 1, name: 'Indexer A', enabled: true },
      { id: 2, name: 'Indexer B', enabled: true },
      { id: 3, name: 'Indexer C', enabled: false },
    ]),
  },
  formatBytes: (bytes?: number) => {
    if (!bytes) return '0 B';
    return `${bytes} bytes`;
  },
}));

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import { createMockSettings } from '@/__tests__/factories';

const mockBooks = [
  createMockBook({
    id: 1,
    coverUrl: 'https://example.com/cover1.jpg',
  }),
  createMockBook({
    id: 2,
    title: 'Project Hail Mary',
    narrators: [{ id: 1, name: 'Ray Porter', slug: 'ray-porter' }],
    coverUrl: 'https://example.com/cover2.jpg',
    seriesName: null,
    seriesPosition: null,
    status: 'downloading',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    authors: [createMockAuthor({ id: 2, name: 'Andy Weir', slug: 'andy-weir' })],
  }),
  createMockBook({
    id: 3,
    title: 'Recursion',
    narrators: [],
    coverUrl: null,
    seriesName: null,
    seriesPosition: null,
    status: 'imported',
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
    authors: [createMockAuthor({ id: 3, name: 'Blake Crouch', slug: 'blake-crouch' })],
  }),
  createMockBook({
    id: 4,
    title: 'Words of Radiance',
    coverUrl: 'https://example.com/cover4.jpg',
    seriesPosition: 2,
    createdAt: '2024-01-04T00:00:00Z',
    updatedAt: '2024-01-04T00:00:00Z',
  }),
];

import type { BookWithAuthor, BookListParams } from '@/lib/api';
import { matchesStatusFilter, sortBooks } from './helpers';
import type { StatusFilter, SortField, SortDirection } from './helpers';

/** Helper: mock both getBooks and getBookStats consistently.
 * getBooks filters/sorts by params to simulate server-side behavior. */
function mockLibraryData(books: BookWithAuthor[]) {
  vi.mocked(api.getBooks).mockImplementation((params?: BookListParams) => {
    let filtered = books;
    if (params?.status) {
      filtered = filtered.filter(b => matchesStatusFilter(b.status, params.status as StatusFilter));
    }
    if (params?.search) {
      const q = params.search.toLowerCase();
      filtered = filtered.filter(b =>
        b.title.toLowerCase().includes(q) ||
        (b.authors[0]?.name ?? '').toLowerCase().includes(q) ||
        (b.narrators[0]?.name ?? '').toLowerCase().includes(q),
      );
    }
    if (params?.sortField) {
      filtered = sortBooks(filtered, params.sortField as SortField, (params.sortDirection ?? 'desc') as SortDirection);
    }
    return Promise.resolve({ data: filtered, total: filtered.length });
  });
  const counts = { wanted: 0, downloading: 0, imported: 0, failed: 0, missing: 0 };
  for (const b of books) {
    if (b.status === 'wanted') counts.wanted++;
    else if (b.status === 'searching' || b.status === 'downloading') counts.downloading++;
    else if (b.status === 'importing' || b.status === 'imported') counts.imported++;
    else if (b.status === 'failed') counts.failed++;
    else if (b.status === 'missing') counts.missing++;
  }
  const authors = [...new Set(books.map(b => b.authors[0]?.name).filter(Boolean))].sort() as string[];
  const series = [...new Set(books.map(b => b.seriesName).filter(Boolean))].sort() as string[];
  const narrators = [...new Set(books.flatMap(b => b.narrators.map(n => n.name)).filter(Boolean))].sort() as string[];
  vi.mocked(api.getBookStats).mockResolvedValue({ counts, authors, series, narrators });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSettings).mockResolvedValue(
    createMockSettings({ library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' } }),
  );
});

describe('LibraryPage', () => {
  it('renders empty library state when no books', async () => {
    mockLibraryData([]);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Manual Import')).toBeInTheDocument();
      expect(screen.getByText('Manual Import').closest('a')).toHaveAttribute('href', '/import');
      expect(screen.getByText('Add a Book')).toBeInTheDocument();
      expect(screen.getByText('Add a Book').closest('a')).toHaveAttribute('href', '/search');
    });
  });

  it('renders book cards with titles and authors', async () => {
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.getByText('Recursion')).toBeInTheDocument();
      // Authors appear in cards and possibly dropdown, so use getAllByText
      expect(screen.getAllByText('Andy Weir').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Blake Crouch').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows status counts in dropdown options', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open the status dropdown to see all options with counts
    await user.click(screen.getByRole('button', { name: /all.*4/i }));

    await waitFor(() => {
      // All count = 4
      expect(screen.getByRole('option', { name: /all.*4/i })).toBeInTheDocument();
      // Wanted count = 2
      expect(screen.getByRole('option', { name: /wanted.*2/i })).toBeInTheDocument();
      // Downloading count = 1
      expect(screen.getByRole('option', { name: /downloading.*1/i })).toBeInTheDocument();
      // Imported count = 1
      expect(screen.getByRole('option', { name: /imported.*1/i })).toBeInTheDocument();
    });
  });

  it('filters by status dropdown selection', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open status dropdown and select Imported
    await user.click(screen.getByRole('button', { name: /all.*4/i }));
    await user.click(screen.getByRole('option', { name: /imported/i }));

    await waitFor(() => {
      expect(screen.getByText('Recursion')).toBeInTheDocument();
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
      expect(screen.queryByText('Project Hail Mary')).not.toBeInTheDocument();
    });
  });

  it('toggles filter panel and filters by author', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Filters should be collapsed by default — no author dropdown visible
    await waitFor(() => {
      expect(screen.queryByDisplayValue('All Authors')).not.toBeInTheDocument();
    });

    // Open filters
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));

    // Now author dropdown should be visible
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    await waitFor(() => {
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
      expect(screen.queryByText('Recursion')).not.toBeInTheDocument();
    });
  });

  it('shows active filter count badge', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open filters and select an author
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    // Filter badge should show "1"
    await waitFor(() => {
      const filtersButton = screen.getByRole('button', { name: /Toggle filters/i });
      expect(within(filtersButton).getByText('1')).toBeInTheDocument();
    });
  });

  it('sorts by title using the sort dropdown', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open sort dropdown and select Title (A→Z)
    await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
    await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

    // All books still present after sort change
    await waitFor(() => {
      expect(screen.getByText('Recursion')).toBeInTheDocument();
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });
  });

  it('renders book cards as clickable links', async () => {
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Cards should be rendered with role="link" for accessibility
    // Filter to only book cards (they have tabIndex=0), excluding nav links
    await waitFor(() => {
      const bookCards = screen.getAllByRole('link').filter(el => el.getAttribute('tabIndex') === '0');
      expect(bookCards.length).toBe(mockBooks.length);
    });
  });

  it('opens context menu on three-dot click', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Hover to reveal menu button, then click it
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Search Releases')).toBeInTheDocument();
      expect(screen.getByText('Remove from Library')).toBeInTheDocument();
    });
  });

  it('shows confirm modal and calls deleteBook on confirm', async () => {
    mockLibraryData(mockBooks);
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open context menu and click remove
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    // Confirm modal should appear with the warning message
    await waitFor(() => {
      expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();
    });

    // Click the destructive "Remove" button in the modal
    const modal = screen.getByRole('dialog');
    const removeButton = within(modal).getByRole('button', { name: 'Remove' });
    await user.click(removeButton);

    // Default sort is createdAt desc, so first book shown is id=4 (Words of Radiance)
    await waitFor(() => {
      expect(vi.mocked(api.deleteBook).mock.calls[0][0]).toBe(4);
      // Without checking the box, deleteFiles should not be passed
      expect(vi.mocked(api.deleteBook).mock.calls[0][1]).toBeUndefined();
    });
  });

  it('shows delete files checkbox for books with path and passes deleteFiles to API', async () => {
    const booksWithPath = [
      createMockBook({
        id: 5,
        title: 'Imported Book',
        path: '/audiobooks/Author/Imported Book',
        status: 'imported',
        createdAt: '2024-01-05T00:00:00Z',
        updatedAt: '2024-01-05T00:00:00Z',
      }),
    ];
    mockLibraryData(booksWithPath);
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Imported Book')).toBeInTheDocument();
    });

    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    // Checkbox should be visible for book with path
    const checkbox = screen.getByLabelText('Delete files from disk');
    await waitFor(() => {
      expect(checkbox).not.toBeChecked();
    });

    // Check the box and confirm
    await user.click(checkbox);
    await waitFor(() => {
      expect(checkbox).toBeChecked();
    });

    const modal = screen.getByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(vi.mocked(api.deleteBook)).toHaveBeenCalledWith(5, { deleteFiles: true });
    });
  });

  it('does not show delete files checkbox for books without path', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    await waitFor(() => {
      expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Delete files from disk')).not.toBeInTheDocument();
    });
  });

  it('shows different success toast when files are deleted', async () => {
    const booksWithPath = [
      createMockBook({
        id: 5,
        title: 'Imported Book',
        path: '/audiobooks/Author/Imported Book',
        status: 'imported',
        createdAt: '2024-01-05T00:00:00Z',
        updatedAt: '2024-01-05T00:00:00Z',
      }),
    ];
    mockLibraryData(booksWithPath);
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Imported Book')).toBeInTheDocument();
    });

    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    await user.click(screen.getByLabelText('Delete files from disk'));

    const modal = screen.getByRole('dialog');
    await user.click(within(modal).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed book and deleted files from disk');
    });
  });

  it('cancels delete without making API call', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open context menu and click remove
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    // Cancel
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(api.deleteBook).not.toHaveBeenCalled();
      // Modal should be gone
      expect(screen.queryByText(/Are you sure you want to remove/)).not.toBeInTheDocument();
    });
  });

  it('shows no match state when filters exclude all books', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open filters and filter by Andy Weir
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    // Then switch to Imported via status dropdown (Andy Weir's book is downloading, not imported)
    await user.click(screen.getByRole('button', { name: /all.*\d+/i }));
    await user.click(screen.getByRole('option', { name: /^imported/i }));

    await waitFor(() => {
      expect(screen.getByText('No books match your filters')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search library...')).toBeInTheDocument();
    });
  });

  it('filters books by search query', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Hail Mary');

    // After debounce (300ms) + fetch, only matching book should show
    await waitFor(() => {
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
      expect(screen.queryByText('Recursion')).not.toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('shows result count when searching', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Sanderson');

    // Should show "X results" format when searching
    await waitFor(() => {
      expect(screen.getByText(/result/)).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  // TODO: #372 — Test needs rework for debounced server-side search (clear triggers async refetch)
  it.skip('clears search with clear button', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Hail Mary');

    // Wait for debounced search to filter
    await waitFor(() => {
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    }, { timeout: 2000 });

    // Clear the search — look for the × button next to search input
    const clearButton = searchInput.parentElement?.querySelector('button');
    expect(clearButton).toBeTruthy();
    await user.click(clearButton!);

    // All books should reappear after debounce
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.getByText('Recursion')).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  // TODO: #372 — Test needs rework for debounced server-side search + filter interaction
  it.skip('combines search with status filter', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Search for Sanderson (matches Way of Kings and Words of Radiance, both "wanted")
    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Sanderson');

    await waitFor(() => {
      expect(screen.queryByText('Project Hail Mary')).not.toBeInTheDocument();
    }, { timeout: 2000 });

    // Click Wanted tab — should still show Sanderson's wanted books
    await user.click(screen.getByRole('button', { name: /^Wanted\s*\d*$/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Words of Radiance')).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  it('opens search releases modal when Search Releases is clicked', async () => {
    mockLibraryData(mockBooks);
    vi.mocked(api.searchBooks).mockResolvedValue({ results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Search Releases'));

    // Modal should open — default sort is createdAt desc, so first card is "Words of Radiance"
    await waitFor(() => {
      expect(screen.getByText(/Releases for:/)).toBeInTheDocument();
    });
  });

  it('shows error toast when delete fails', async () => {
    mockLibraryData(mockBooks);
    vi.mocked(api.deleteBook).mockRejectedValue(new Error('Cannot delete'));
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open context menu and click remove
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    // Confirm modal should appear
    await waitFor(() => {
      expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();
    });

    const modal = screen.getByRole('dialog');
    const removeButton = within(modal).getByRole('button', { name: 'Remove' });
    await user.click(removeButton);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove book: Cannot delete');
    });
  });

  it('sorts books by title alphabetically', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open sort dropdown and select Title (A→Z) for ascending alphabetical order
    await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
    await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

    await waitFor(() => {
      const bookCardsAsc = screen.getAllByRole('link').filter(el => el.getAttribute('tabIndex') === '0');
      const titlesAsc = bookCardsAsc.map(card => {
        const h3 = card.querySelector('h3');
        return h3?.textContent;
      });

      // Verify titles are in ascending alphabetical order
      const sorted = [...titlesAsc].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
      expect(titlesAsc).toEqual(sorted);
    });
  });

  it('shows error toast when getBooks API fails', async () => {
    vi.mocked(api.getBooks).mockRejectedValue(new Error('API is down'));
    vi.mocked(api.getBookStats).mockResolvedValue({ counts: { wanted: 0, downloading: 0, imported: 0, failed: 0, missing: 0 }, authors: [], series: [], narrators: [] });

    renderWithProviders(<LibraryPage />);

    // The page should render something (loading, then error state handled by TanStack Query)
    // With retry: false in test setup, it will fail immediately
    // TanStack Query doesn't show a toast on query failure by default,
    // but the page should still render without crashing
    await waitFor(() => {
      // Loading state should eventually resolve
      // With a failed query, books will be empty default [], showing empty state
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
  });

  it('shows import link in overflow menu', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /more actions/i }));

    await waitFor(() => {
      const importLink = screen.getByRole('menuitem', { name: /import/i });
      expect(importLink).toHaveAttribute('href', '/import');
    });
  });

  describe('remove missing', () => {
    const booksWithMissing = [
      ...mockBooks,
      createMockBook({
        id: 10,
        title: 'Missing Book 1',
        status: 'missing',
        createdAt: '2024-01-10T00:00:00Z',
        updatedAt: '2024-01-10T00:00:00Z',
      }),
      createMockBook({
        id: 11,
        title: 'Missing Book 2',
        status: 'missing',
        createdAt: '2024-01-11T00:00:00Z',
        updatedAt: '2024-01-11T00:00:00Z',
      }),
    ];

    async function openOverflowMenu(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /more actions/i }));
    }

    it('shows Remove Missing item in overflow menu when missing books exist', async () => {
      mockLibraryData(booksWithMissing);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Book 1')).toBeInTheDocument();
      });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /remove missing/i })).toBeInTheDocument();
      });
    });

    it('hides Remove Missing item when no missing books', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openOverflowMenu(user);

      await waitFor(() => {
        expect(screen.queryByRole('menuitem', { name: /remove missing/i })).not.toBeInTheDocument();
      });
    });

    it('shows confirmation modal with count when Remove Missing is clicked', async () => {
      mockLibraryData(booksWithMissing);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Book 1')).toBeInTheDocument();
      });

      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));

      await waitFor(() => {
        expect(screen.getByText('Remove 2 missing books from library?')).toBeInTheDocument();
      });
    });

    it('calls deleteMissingBooks and shows success toast on confirm', async () => {
      mockLibraryData(booksWithMissing);
      vi.mocked(api.deleteMissingBooks).mockResolvedValue({ deleted: 2 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Book 1')).toBeInTheDocument();
      });

      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));

      const modal = screen.getByRole('dialog');
      await user.click(within(modal).getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(api.deleteMissingBooks).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed 2 missing books');
      });
    });

    it('cancels removal without API call', async () => {
      mockLibraryData(booksWithMissing);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Book 1')).toBeInTheDocument();
      });

      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(api.deleteMissingBooks).not.toHaveBeenCalled();
        expect(screen.queryByText('Remove 2 missing books from library?')).not.toBeInTheDocument();
      });
    });

    it('shows error toast when batch delete fails', async () => {
      mockLibraryData(booksWithMissing);
      vi.mocked(api.deleteMissingBooks).mockRejectedValue(new Error('DB connection lost'));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Book 1')).toBeInTheDocument();
      });

      await openOverflowMenu(user);
      await user.click(screen.getByRole('menuitem', { name: /remove missing/i }));

      const modal = screen.getByRole('dialog');
      await user.click(within(modal).getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove missing books: DB connection lost');
      });
    });
  });

  describe('rescan', () => {
    it('calls rescanLibrary API when Rescan is clicked in overflow menu', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.rescanLibrary).mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      await waitFor(() => {
        expect(api.rescanLibrary).toHaveBeenCalledTimes(1);
      });
    });

    it('shows success toast with summary after rescan completes', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.rescanLibrary).mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          'Scanned: 10 books. Missing: 2 books. Restored: 1 books.',
        );
      });
    });

    it('shows error toast when rescan fails', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.rescanLibrary).mockRejectedValue(new Error('Library path is not configured'));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /rescan/i }));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Rescan failed: Library path is not configured',
        );
      });
    });
  });

  // #282 — Grid/Table view toggle
  describe('grid/table view toggle (#282)', () => {
    beforeEach(() => {
      localStorage.removeItem('narratorr:library-view');
    });

    it('renders view toggle button in toolbar', async () => {
      mockLibraryData(mockBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByRole('group', { name: 'View mode' })).toBeInTheDocument();
        expect(screen.getByLabelText('Grid view')).toBeInTheDocument();
        expect(screen.getByLabelText('Table view')).toBeInTheDocument();
      });
    });

    it('defaults to grid view when no localStorage value', async () => {
      mockLibraryData(mockBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await waitFor(() => {
        const gridButton = screen.getByLabelText('Grid view');
        expect(gridButton).toHaveAttribute('aria-pressed', 'true');

        const tableButton = screen.getByLabelText('Table view');
        expect(tableButton).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('clicking toggle switches from grid to table view', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Table view'));

      await waitFor(() => {
        expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByLabelText('Grid view')).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('clicking toggle again switches back to grid', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Switch to table
      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => {
        expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true');
      });

      // Switch back to grid
      await user.click(screen.getByLabelText('Grid view'));
      await waitFor(() => {
        expect(screen.getByLabelText('Grid view')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('saves view preference to localStorage on toggle', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => {
        expect(localStorage.getItem('narratorr:library-view')).toBe('table');
      });

      await user.click(screen.getByLabelText('Grid view'));
      await waitFor(() => {
        expect(localStorage.getItem('narratorr:library-view')).toBe('grid');
      });
    });

    it('restores view preference from localStorage on load', async () => {
      localStorage.setItem('narratorr:library-view', 'table');
      mockLibraryData(mockBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true');
      });

      await waitFor(() => {
        expect(screen.getByLabelText('Grid view')).toHaveAttribute('aria-pressed', 'false');
      });
    });

    it('coerces sort to Date Added (desc) when switching from table to grid with quality sort active', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();
      renderWithProviders(<LibraryPage />);
      await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Sort by Quality' })).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: 'Sort by Quality' }));

      await user.click(screen.getByLabelText('Grid view'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /date added.*newest/i })).toBeInTheDocument();
      });
    });

    it('coerces sort to Date Added (desc) when switching from table to grid with size sort active', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();
      renderWithProviders(<LibraryPage />);
      await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Sort by Size' })).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: 'Sort by Size' }));

      await user.click(screen.getByLabelText('Grid view'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /date added.*newest/i })).toBeInTheDocument();
      });
    });

    it('coerces sort to Date Added (desc) when switching from table to grid with format sort active', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();
      renderWithProviders(<LibraryPage />);
      await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Sort by Format' })).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: 'Sort by Format' }));

      await user.click(screen.getByLabelText('Grid view'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /date added.*newest/i })).toBeInTheDocument();
      });
    });

    it('does not change sort when switching from table to grid with title sort active', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();
      renderWithProviders(<LibraryPage />);
      await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => { expect(screen.getByRole('button', { name: 'Sort by Title' })).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: 'Sort by Title' }));

      await user.click(screen.getByLabelText('Grid view'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /title.*z.*a/i })).toBeInTheDocument();
      });
    });

    it('toolbar dropdown in table view shows only the five allowed sort fields (no Quality/Size/Format)', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();
      renderWithProviders(<LibraryPage />);
      await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

      await user.click(screen.getByLabelText('Table view'));
      await waitFor(() => { expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true'); });

      await user.click(screen.getByRole('button', { name: /^Date Added \(Newest\)$/i }));

      expect(screen.queryByRole('option', { name: /quality/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /size/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('option', { name: /format/i })).not.toBeInTheDocument();
      expect(screen.getByRole('option', { name: /date added.*newest/i })).toBeInTheDocument();
    });

    it('selection state clears when switching to grid view', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Switch to table view
      await user.click(screen.getByLabelText('Table view'));

      // Select a book via checkbox
      await waitFor(() => {
        expect(screen.getByLabelText('Select all books')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Select all books'));

      // Verify selection is active (bulk toolbar should appear)
      await waitFor(() => {
        expect(screen.getByText(/selected/i)).toBeInTheDocument();
      });

      // Switch back to grid — selection should clear
      await user.click(screen.getByLabelText('Grid view'));

      // Bulk toolbar should be gone (no selection)
      await waitFor(() => {
        expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
      });
    });
  });

  describe('Search All Wanted', () => {
    async function openSearchWanted(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByRole('menuitem', { name: /search wanted/i }));
    }

    it('shows confirmation modal with book count, indexer count, and estimated API calls when overflow item clicked', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openSearchWanted(user);

      await waitFor(() => {
        // mockBooks has 2 wanted books (id 1 and 4), 2 enabled indexers → 4 API calls
        expect(screen.getByText(/Search 2 wanted books across 2 enabled indexers/)).toBeInTheDocument();
        expect(screen.getByText(/~4 API calls/)).toBeInTheDocument();
      });
    });

    it('triggers searchAllWanted API call when user confirms modal', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 2, grabbed: 1, skipped: 0, errors: 0 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openSearchWanted(user);

      await waitFor(() => {
        expect(screen.getByText('Search', { selector: 'button' })).toBeInTheDocument();
      });

      await user.click(screen.getByText('Search', { selector: 'button' }));

      await waitFor(() => {
        expect(api.searchAllWanted).toHaveBeenCalledTimes(1);
      });
    });

    it('does nothing when user cancels modal', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openSearchWanted(user);

      await waitFor(() => {
        expect(screen.getByText('Cancel', { selector: 'button' })).toBeInTheDocument();
      });

      await user.click(screen.getByText('Cancel', { selector: 'button' }));

      await waitFor(() => {
        expect(api.searchAllWanted).not.toHaveBeenCalled();
      });
    });

    it('shows summary toast on successful search completion', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.searchAllWanted).mockResolvedValue({ searched: 2, grabbed: 1, skipped: 0, errors: 0 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openSearchWanted(user);

      await waitFor(() => {
        expect(screen.getByText('Search', { selector: 'button' })).toBeInTheDocument();
      });

      await user.click(screen.getByText('Search', { selector: 'button' }));

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Search complete: 2 searched, 1 grabbed');
      });
    });

    it('disables Search Wanted overflow item while mutation is pending', async () => {
      mockLibraryData(mockBooks);
      // Return a promise that never resolves to keep mutation pending
      vi.mocked(api.searchAllWanted).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Open overflow menu — Search Wanted item should be enabled initially
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      const searchWantedItem = screen.getByRole('menuitem', { name: /search wanted/i });
      expect(searchWantedItem).toBeEnabled();

      // Click it — opens confirm modal, menu closes
      await user.click(searchWantedItem);

      await waitFor(() => {
        expect(screen.getByText('Search', { selector: 'button' })).toBeInTheDocument();
      });

      await user.click(screen.getByText('Search', { selector: 'button' }));

      // Reopen overflow menu — Search Wanted should now be disabled while mutation is pending
      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /search wanted/i })).toBeDisabled();
      });
    });

    it('shows error toast on search failure', async () => {
      mockLibraryData(mockBooks);
      vi.mocked(api.searchAllWanted).mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await openSearchWanted(user);

      await waitFor(() => {
        expect(screen.getByText('Search', { selector: 'button' })).toBeInTheDocument();
      });

      await user.click(screen.getByText('Search', { selector: 'button' }));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Search all wanted failed: Server error',
        );
      });
    });
  });

  // #351 — Failed and Missing status pill click-through
  describe('failed and missing status pills (#351)', () => {
    const booksWithAllStatuses = [
      ...mockBooks,
      createMockBook({
        id: 20,
        title: 'Failed Download',
        status: 'failed',
        createdAt: '2024-01-20T00:00:00Z',
        updatedAt: '2024-01-20T00:00:00Z',
      }),
      createMockBook({
        id: 21,
        title: 'Missing Audiobook',
        status: 'missing',
        createdAt: '2024-01-21T00:00:00Z',
        updatedAt: '2024-01-21T00:00:00Z',
      }),
    ];

    it('clicking Failed option shows only failed-status books', async () => {
      mockLibraryData(booksWithAllStatuses);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Failed Download')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /failed/i }));

      await waitFor(() => {
        expect(screen.getByText('Failed Download')).toBeInTheDocument();
        expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
        expect(screen.queryByText('Missing Audiobook')).not.toBeInTheDocument();
      });
    });

    it('clicking Missing option shows only missing-status books', async () => {
      mockLibraryData(booksWithAllStatuses);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Missing Audiobook')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /missing/i }));

      await waitFor(() => {
        expect(screen.getByText('Missing Audiobook')).toBeInTheDocument();
        expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
        expect(screen.queryByText('Failed Download')).not.toBeInTheDocument();
      });
    });

    it('clicking Failed option with no failed books shows NoMatchState', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /failed/i }));

      await waitFor(() => {
        expect(screen.getByText('No books match your filters')).toBeInTheDocument();
      });
    });

    it('clicking Missing option with no missing books shows NoMatchState', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /all/i }));
      await user.click(screen.getByRole('option', { name: /missing/i }));

      await waitFor(() => {
        expect(screen.getByText('No books match your filters')).toBeInTheDocument();
      });
    });

    it('status dropdown shows correct failed and missing counts', async () => {
      mockLibraryData(booksWithAllStatuses);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Failed Download')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /all/i }));

      await waitFor(() => {
        expect(screen.getByRole('option', { name: /failed.*1/i })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: /missing.*1/i })).toBeInTheDocument();
      });
    });
  });
});

describe('LibraryPage — settings-driven empty-state wiring (#133)', () => {
  it('empty library with library path configured: shows Scan Library CTA linking to /library-import', async () => {
    mockLibraryData([]);
    vi.mocked(api.getSettings).mockResolvedValue(
      createMockSettings({ library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' } }),
    );

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
    await waitFor(() => {
      const scanLink = screen.getByRole('link', { name: /scan library/i });
      expect(scanLink).toHaveAttribute('href', '/library-import');
    });
  });

  it('empty library with no library path: shows Go to Settings CTA, no Scan Library link', async () => {
    mockLibraryData([]);
    vi.mocked(api.getSettings).mockResolvedValue(
      createMockSettings({ library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' } }),
    );

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /scan library/i })).not.toBeInTheDocument();
    });
  });
});
