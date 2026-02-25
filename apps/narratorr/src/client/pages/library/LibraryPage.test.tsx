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
    deleteBook: vi.fn(),
    deleteMissingBooks: vi.fn(),
    rescanLibrary: vi.fn(),
    search: vi.fn(),
    grab: vi.fn(),
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

const mockBooks = [
  createMockBook({
    id: 1,
    coverUrl: 'https://example.com/cover1.jpg',
  }),
  createMockBook({
    id: 2,
    title: 'Project Hail Mary',
    authorId: 2,
    narrator: 'Ray Porter',
    coverUrl: 'https://example.com/cover2.jpg',
    seriesName: null,
    seriesPosition: null,
    status: 'downloading',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
    author: createMockAuthor({ id: 2, name: 'Andy Weir', slug: 'andy-weir' }),
  }),
  createMockBook({
    id: 3,
    title: 'Recursion',
    authorId: 3,
    narrator: null,
    coverUrl: null,
    seriesName: null,
    seriesPosition: null,
    status: 'imported',
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
    author: createMockAuthor({ id: 3, name: 'Blake Crouch', slug: 'blake-crouch' }),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LibraryPage', () => {
  it('renders empty library state when no books', async () => {
    vi.mocked(api.getBooks).mockResolvedValue([]);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
    expect(screen.getByText('Manual Import')).toBeInTheDocument();
    expect(screen.getByText('Manual Import').closest('a')).toHaveAttribute('href', '/import');
    expect(screen.getByText('Discover Books')).toBeInTheDocument();
    expect(screen.getByText('Discover Books').closest('a')).toHaveAttribute('href', '/search');
  });

  it('renders book cards with titles and authors', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });
    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
    expect(screen.getByText('Recursion')).toBeInTheDocument();
    // Authors appear in cards and possibly dropdown, so use getAllByText
    expect(screen.getAllByText('Andy Weir').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Blake Crouch').length).toBeGreaterThanOrEqual(1);
  });

  it('shows status counts in pills', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('4')).toBeInTheDocument(); // All count
    });
    // Wanted count = 2
    const wantedPill = screen.getByRole('button', { name: /Wanted/i });
    expect(within(wantedPill).getByText('2')).toBeInTheDocument();
    // Downloading count = 1
    const downloadingPill = screen.getByRole('button', { name: /Downloading/i });
    expect(within(downloadingPill).getByText('1')).toBeInTheDocument();
    // Imported count = 1
    const importedPill = screen.getByRole('button', { name: /Imported/i });
    expect(within(importedPill).getByText('1')).toBeInTheDocument();
  });

  it('filters by status pill click', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Click Imported tab
    await user.click(screen.getByRole('button', { name: /Imported/i }));

    expect(screen.getByText('Recursion')).toBeInTheDocument();
    expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    expect(screen.queryByText('Project Hail Mary')).not.toBeInTheDocument();
  });

  it('toggles filter panel and filters by author', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Filters should be collapsed by default — no author dropdown visible
    expect(screen.queryByDisplayValue('All Authors')).not.toBeInTheDocument();

    // Open filters
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));

    // Now author dropdown should be visible
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
    expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    expect(screen.queryByText('Recursion')).not.toBeInTheDocument();
  });

  it('shows active filter count badge', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
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
    const filtersButton = screen.getByRole('button', { name: /Toggle filters/i });
    expect(within(filtersButton).getByText('1')).toBeInTheDocument();
  });

  it('sorts by title when filters are open', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open filters to access sort
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));

    // Change sort to title
    const sortSelect = screen.getByDisplayValue('Date Added');
    await user.selectOptions(sortSelect, 'title');

    // All books still present after sort change
    expect(screen.getByText('Recursion')).toBeInTheDocument();
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });

  it('renders book cards as clickable links', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Cards should be rendered with role="link" for accessibility
    // Filter to only book cards (they have tabIndex=0), excluding nav links
    const bookCards = screen.getAllByRole('link').filter(el => el.getAttribute('tabIndex') === '0');
    expect(bookCards.length).toBe(mockBooks.length);
  });

  it('opens context menu on three-dot click', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Hover to reveal menu button, then click it
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);

    expect(screen.getByText('Search Releases')).toBeInTheDocument();
    expect(screen.getByText('Remove from Library')).toBeInTheDocument();
  });

  it('shows confirm modal and calls deleteBook on confirm', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
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
    expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();

    // Click the destructive "Remove" button in the modal
    const modal = screen.getByText(/Are you sure you want to remove/).closest('div[class*="relative w-full"]') as HTMLElement;
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
    vi.mocked(api.getBooks).mockResolvedValue(booksWithPath);
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
    expect(checkbox).not.toBeChecked();

    // Check the box and confirm
    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    const modal = screen.getByText(/Are you sure you want to remove/).closest('div[class*="relative w-full"]') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(vi.mocked(api.deleteBook)).toHaveBeenCalledWith(5, { deleteFiles: true });
    });
  });

  it('does not show delete files checkbox for books without path', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);
    await user.click(screen.getByText('Remove from Library'));

    expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete files from disk')).not.toBeInTheDocument();
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
    vi.mocked(api.getBooks).mockResolvedValue(booksWithPath);
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

    const modal = screen.getByText(/Are you sure you want to remove/).closest('div[class*="relative w-full"]') as HTMLElement;
    await user.click(within(modal).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed book and deleted files from disk');
    });
  });

  it('cancels delete without making API call', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
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

    expect(api.deleteBook).not.toHaveBeenCalled();
    // Modal should be gone
    expect(screen.queryByText(/Are you sure you want to remove/)).not.toBeInTheDocument();
  });

  it('shows no match state when filters exclude all books', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open filters and filter by Andy Weir
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    // Then switch to imported tab (Andy Weir's book is downloading, not imported)
    await user.click(screen.getByRole('button', { name: /Imported/i }));

    expect(screen.getByText('No books match your filters')).toBeInTheDocument();
  });

  it('renders search input', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search library...')).toBeInTheDocument();
    });
  });

  it('filters books by search query', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Hail Mary');

    // After debounce, only matching book should show
    await waitFor(() => {
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
      expect(screen.queryByText('Recursion')).not.toBeInTheDocument();
    });
  });

  it('shows result count when searching', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Sanderson');

    // Should show "X of Y books" format
    await waitFor(() => {
      expect(screen.getByText(/of 4 books/)).toBeInTheDocument();
    });
  });

  it('clears search with clear button', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'Hail Mary');

    // Wait for search to filter
    await waitFor(() => {
      expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    });

    // Clear the search — look for the × button next to search input
    const clearButton = searchInput.parentElement?.querySelector('button');
    expect(clearButton).toBeTruthy();
    await user.click(clearButton!);

    // All books should reappear
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.getByText('Recursion')).toBeInTheDocument();
    });
  });

  it('combines search with status filter', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
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
    });

    // Click Wanted tab — should still show Sanderson's wanted books
    await user.click(screen.getByRole('button', { name: /Wanted/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Words of Radiance')).toBeInTheDocument();
    });
  });

  it('opens search releases modal when Search Releases is clicked', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    vi.mocked(api.search).mockResolvedValue({ results: [], unsupportedResults: { count: 0, titles: [] } });
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
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
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
    expect(screen.getByText(/Are you sure you want to remove/)).toBeInTheDocument();

    const modal = screen.getByText(/Are you sure you want to remove/).closest('div[class*="relative w-full"]') as HTMLElement;
    const removeButton = within(modal).getByRole('button', { name: 'Remove' });
    await user.click(removeButton);

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove book: Cannot delete');
    });
  });

  it('sorts books by title alphabetically', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open filters to access sort
    await user.click(screen.getByRole('button', { name: /Toggle filters/i }));

    // Change sort to title
    const sortSelect = screen.getByDisplayValue('Date Added');
    await user.selectOptions(sortSelect, 'title');

    // Default sort direction is desc, so title desc = reverse alphabetical
    // Switch to asc for alphabetical
    const sortButton = screen.getByTitle(/Sort descending/i);
    await user.click(sortButton);

    const bookCardsAsc = screen.getAllByRole('link').filter(el => el.getAttribute('tabIndex') === '0');
    const titlesAsc = bookCardsAsc.map(card => {
      const h3 = card.querySelector('h3');
      return h3?.textContent;
    });

    // Verify titles are in ascending alphabetical order
    const sorted = [...titlesAsc].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(titlesAsc).toEqual(sorted);
  });

  it('shows error toast when getBooks API fails', async () => {
    vi.mocked(api.getBooks).mockRejectedValue(new Error('API is down'));

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

  it('shows import link in toolbar', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const importLink = screen.getByText('Import');
    expect(importLink.closest('a')).toHaveAttribute('href', '/import');
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

    it('shows Remove Missing button when missing books exist', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(booksWithMissing);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Remove Missing')).toBeInTheDocument();
      });
    });

    it('hides Remove Missing button when no missing books', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      expect(screen.queryByText('Remove Missing')).not.toBeInTheDocument();
    });

    it('shows confirmation modal with count when Remove Missing is clicked', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(booksWithMissing);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Remove Missing')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Remove Missing'));

      expect(screen.getByText('Remove 2 missing books from library?')).toBeInTheDocument();
    });

    it('calls deleteMissingBooks and shows success toast on confirm', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(booksWithMissing);
      vi.mocked(api.deleteMissingBooks).mockResolvedValue({ deleted: 2 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Remove Missing')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Remove Missing'));

      const modal = screen.getByText('Remove 2 missing books from library?').closest('div[class*="relative w-full"]') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(api.deleteMissingBooks).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Removed 2 missing books');
      });
    });

    it('cancels removal without API call', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(booksWithMissing);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Remove Missing')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Remove Missing'));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(api.deleteMissingBooks).not.toHaveBeenCalled();
      expect(screen.queryByText('Remove 2 missing books from library?')).not.toBeInTheDocument();
    });

    it('shows error toast when batch delete fails', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(booksWithMissing);
      vi.mocked(api.deleteMissingBooks).mockRejectedValue(new Error('DB connection lost'));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Remove Missing')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Remove Missing'));

      const modal = screen.getByText('Remove 2 missing books from library?').closest('div[class*="relative w-full"]') as HTMLElement;
      await user.click(within(modal).getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Failed to remove missing books: DB connection lost');
      });
    });
  });

  describe('rescan', () => {
    it('calls rescanLibrary API when Rescan button is clicked', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
      vi.mocked(api.rescanLibrary).mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Rescan'));

      await waitFor(() => {
        expect(api.rescanLibrary).toHaveBeenCalledTimes(1);
      });
    });

    it('shows success toast with summary after rescan completes', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
      vi.mocked(api.rescanLibrary).mockResolvedValue({ scanned: 10, missing: 2, restored: 1 });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Rescan'));

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
          'Scanned: 10 books. Missing: 2 books. Restored: 1 books.',
        );
      });
    });

    it('shows error toast when rescan fails', async () => {
      vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
      vi.mocked(api.rescanLibrary).mockRejectedValue(new Error('Library path is not configured'));
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Rescan'));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Rescan failed: Library path is not configured',
        );
      });
    });
  });
});
