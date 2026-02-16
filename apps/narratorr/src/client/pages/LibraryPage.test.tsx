import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryPage } from '@/pages/LibraryPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    deleteBook: vi.fn(),
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

const mockBooks = [
  {
    id: 1,
    title: 'The Way of Kings',
    authorId: 1,
    narrator: 'Michael Kramer',
    coverUrl: 'https://example.com/cover1.jpg',
    seriesName: 'The Stormlight Archive',
    seriesPosition: 1,
    status: 'wanted',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
  },
  {
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
    author: { id: 2, name: 'Andy Weir', slug: 'andy-weir' },
  },
  {
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
    author: { id: 3, name: 'Blake Crouch', slug: 'blake-crouch' },
  },
  {
    id: 4,
    title: 'Words of Radiance',
    authorId: 1,
    narrator: 'Michael Kramer',
    coverUrl: 'https://example.com/cover4.jpg',
    seriesName: 'The Stormlight Archive',
    seriesPosition: 2,
    status: 'wanted',
    createdAt: '2024-01-04T00:00:00Z',
    updatedAt: '2024-01-04T00:00:00Z',
    author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
  },
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
    // Authors appear in both cards and dropdown, so use getAllByText
    expect(screen.getAllByText('Andy Weir').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Blake Crouch').length).toBeGreaterThanOrEqual(1);
  });

  it('shows status counts in tabs', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('(4)')).toBeInTheDocument(); // All
    });
    // Wanted count = 2
    const wantedTab = screen.getByRole('button', { name: /Wanted/i });
    expect(within(wantedTab).getByText('(2)')).toBeInTheDocument();
    // Downloading count = 1
    const downloadingTab = screen.getByRole('button', { name: /Downloading/i });
    expect(within(downloadingTab).getByText('(1)')).toBeInTheDocument();
    // Imported count = 1
    const importedTab = screen.getByRole('button', { name: /Imported/i });
    expect(within(importedTab).getByText('(1)')).toBeInTheDocument();
  });

  it('filters by status tab click', async () => {
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

  it('filters by author dropdown', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Select author filter
    const authorSelect = screen.getByDisplayValue('All Authors');
    await user.selectOptions(authorSelect, 'Andy Weir');

    expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
    expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    expect(screen.queryByText('Recursion')).not.toBeInTheDocument();
  });

  it('sorts by title', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Change sort to title
    const sortSelect = screen.getByDisplayValue('Date Added');
    await user.selectOptions(sortSelect, 'title');

    // All books still present after sort change
    expect(screen.getByText('Recursion')).toBeInTheDocument();
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });

  it('opens context menu on three-dot click', async () => {
    vi.mocked(api.getBooks).mockResolvedValue(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Click the first three-dot menu button
    const menuButtons = screen.getAllByLabelText('Book options');
    await user.click(menuButtons[0]);

    expect(screen.getByText('View Details')).toBeInTheDocument();
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
    // TanStack Query passes additional context as second arg to mutationFn
    await waitFor(() => {
      expect(vi.mocked(api.deleteBook).mock.calls[0][0]).toBe(4);
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

    // Filter by Andy Weir
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
    vi.mocked(api.search).mockResolvedValue([]);
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
});
