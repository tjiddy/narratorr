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

// Spy on useNavigate for navigation assertions
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.mock requires dynamic import
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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

/** Paged variant: accepts independent total so Pagination renders when total > limit (100).
 * Use total > 100 to trigger Pagination rendering. */
function mockPagedLibraryData(books: BookWithAuthor[], opts: { total: number }) {
  vi.mocked(api.getBooks).mockImplementation((params?: BookListParams) => {
    const offset = params?.offset ?? 0;
    const limit = params?.limit ?? 100;
    const page = books.slice(offset, offset + limit);
    return Promise.resolve({ data: page, total: opts.total });
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

// --- Shared toolbar interaction helpers (#183) ---

async function waitForLibraryLoad() {
  await waitFor(() => {
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
  });
}

async function switchToTableView(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Table view'));
  await waitFor(() => {
    expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true');
  });
}

async function selectAllBooksInTable(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => {
    expect(screen.getByLabelText('Select all books')).toBeInTheDocument();
  });
  await user.click(screen.getByLabelText('Select all books'));
  await waitFor(() => {
    expect(screen.getByText(/selected/i)).toBeInTheDocument();
  });
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

  it('shows Add Book link with search query in NoMatchState (#322)', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Search for something that won't match any books
    const searchInput = screen.getByPlaceholderText('Search library...');
    await user.type(searchInput, 'nonexistent book title xyz');

    // After debounce, NoMatchState should appear with Add Book link
    await waitFor(() => {
      expect(screen.getByText('No books match your filters')).toBeInTheDocument();
    }, { timeout: 2000 });

    const addBookLink = screen.getByText('Add Book').closest('a');
    const href = addBookLink?.getAttribute('href') ?? '';
    const params = new URLSearchParams(href.split('?')[1]);
    expect(params.get('q')).toBe('nonexistent book title xyz');
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

// #183 — Test coverage gaps

describe('LibraryPage — view mode localStorage edge cases (#183)', () => {
  beforeEach(() => {
    localStorage.removeItem('narratorr:library-view');
  });

  it('falls back to grid when localStorage has malformed value', async () => {
    localStorage.setItem('narratorr:library-view', 'grid-view');
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    expect(screen.getByLabelText('Grid view')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'false');
  });

  it('falls back to grid when localStorage throws on getItem', async () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('localStorage unavailable');
    });
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    expect(screen.getByLabelText('Grid view')).toHaveAttribute('aria-pressed', 'true');
    getItemSpy.mockRestore();
  });

  it('still changes view mode when localStorage throws on setItem', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('localStorage full');
    });
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    await user.click(screen.getByLabelText('Table view'));

    await waitFor(() => {
      expect(screen.getByLabelText('Table view')).toHaveAttribute('aria-pressed', 'true');
    });
    setItemSpy.mockRestore();
  });
});

describe('LibraryPage — pagination (#183)', () => {
  // Create a page of books that mockPagedLibraryData will return
  const pageBooks = Array.from({ length: 4 }, (_, i) =>
    createMockBook({
      id: i + 1,
      title: `Book ${i + 1}`,
      createdAt: `2024-01-0${i + 1}T00:00:00Z`,
      updatedAt: `2024-01-0${i + 1}T00:00:00Z`,
    }),
  );

  it('renders Pagination when total exceeds page limit', async () => {
    // total=150 > limit=100 → pagination visible
    mockPagedLibraryData(pageBooks, { total: 150 });

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Book 1')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText(/showing/i)).toBeInTheDocument();
    });
  });

  it('does not render Pagination when total is within page limit', async () => {
    mockPagedLibraryData(pageBooks, { total: 4 });

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Book 1')).toBeInTheDocument();
    });

    // No pagination controls since total (4) <= limit (100)
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
  });

  it('navigates to next page via pagination controls', async () => {
    mockPagedLibraryData(pageBooks, { total: 150 });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('Book 1')).toBeInTheDocument();
    });

    const nextButton = screen.getByLabelText('Next page');
    await user.click(nextButton);

    await waitFor(() => {
      // getBooks should be called with offset=100 for page 2
      expect(vi.mocked(api.getBooks)).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 100 }),
      );
    });
  });

  it('does not render Pagination when total is zero', async () => {
    mockPagedLibraryData([], { total: 0 });
    // Override stats to have counts so empty-state doesn't trigger
    vi.mocked(api.getBookStats).mockResolvedValue({
      counts: { wanted: 5, downloading: 0, imported: 0, failed: 0, missing: 0 },
      authors: [], series: [], narrators: [],
    });

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('No books match your filters')).toBeInTheDocument();
    });

    // No pagination since total=0
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
  });
});

describe('LibraryPage — bulk action toolbar page-level wiring (#183)', () => {
  const booksWithPaths = [
    createMockBook({ id: 1, path: '/audiobooks/book1', status: 'wanted' }),
    createMockBook({ id: 2, title: 'Book 2', path: '/audiobooks/book2', status: 'wanted',
      createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }),
    createMockBook({ id: 3, title: 'Book 3', path: null, status: 'imported',
      createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' }),
  ];

  it('renders BulkActionToolbar in table mode with selections', async () => {
    mockLibraryData(booksWithPaths);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    expect(screen.getByText(/selected/i)).toBeInTheDocument();
  });

  it('does not render BulkActionToolbar in grid mode', async () => {
    mockLibraryData(mockBooks);

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    // Grid mode is default — no bulk toolbar
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
  });

  it('does not render BulkActionToolbar in table mode with no selections', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    await switchToTableView(user);

    // No selections made — no bulk toolbar
    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
  });

  it('bulk delete with deleteFiles passes { deleteFiles: true } to mutation', async () => {
    mockLibraryData(booksWithPaths);
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    // Click Remove in bulk toolbar
    const removeButton = screen.getByRole('button', { name: /remove/i });
    await user.click(removeButton);

    // Check the "Delete files from disk" checkbox in the confirm modal
    await waitFor(() => {
      expect(screen.getByText('Delete Selected Books')).toBeInTheDocument();
    });
    const checkbox = screen.getByLabelText(/delete files from disk/i);
    await user.click(checkbox);

    // Confirm deletion via the Remove button in the dialog
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(vi.mocked(api.deleteBook)).toHaveBeenCalledWith(
        expect.any(Number),
        { deleteFiles: true },
      );
    });
  });

  it('bulk delete without deleteFiles passes undefined (no deleteFiles) to mutation', async () => {
    mockLibraryData(booksWithPaths);
    vi.mocked(api.deleteBook).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    await user.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => {
      expect(screen.getByText('Delete Selected Books')).toBeInTheDocument();
    });

    // Confirm without checking deleteFiles via the Remove button in the dialog
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' });
    await user.click(confirmButton);

    await waitFor(() => {
      // deleteFiles=false → deleteBook(id, undefined)
      expect(vi.mocked(api.deleteBook)).toHaveBeenCalledWith(
        expect.any(Number),
        undefined,
      );
    });
  });

  it('hides delete-files checkbox when no selected books have a path', async () => {
    const booksNoPaths = [
      createMockBook({ id: 1, path: null }),
      createMockBook({ id: 2, title: 'Book 2', path: null,
        createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' }),
    ];
    mockLibraryData(booksNoPaths);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    await user.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => {
      expect(screen.getByText('Delete Selected Books')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText(/delete files from disk/i)).not.toBeInTheDocument();
  });

  it('bulk search fires searchBook API for selected wanted books', async () => {
    mockLibraryData(booksWithPaths);
    vi.mocked(api.searchBook).mockResolvedValue({ result: 'no_results' });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(vi.mocked(api.searchBook)).toHaveBeenCalled();
    });
  });

  it('bulk set status to Wanted fires updateBook and shows toast with Wanted label', async () => {
    mockLibraryData(booksWithPaths);
    vi.mocked(api.updateBook).mockResolvedValue(booksWithPaths[0]);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    // Open the Set Status menu
    await user.click(screen.getByRole('button', { name: /set status/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^wanted$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^wanted$/i }));

    await waitFor(() => {
      expect(vi.mocked(api.updateBook)).toHaveBeenCalledWith(
        expect.any(Number),
        { status: 'wanted' },
      );
    });

    // Verify the label is preserved through the page wiring to the toast
    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringContaining('to Wanted'),
      );
    });
  });

  it('bulk set status to Owned fires updateBook and shows toast with Owned label', async () => {
    mockLibraryData(booksWithPaths);
    vi.mocked(api.updateBook).mockResolvedValue(booksWithPaths[0]);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitFor(() => { expect(screen.getByText('The Way of Kings')).toBeInTheDocument(); });

    await switchToTableView(user);
    await selectAllBooksInTable(user);

    await user.click(screen.getByRole('button', { name: /set status/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^owned$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^owned$/i }));

    await waitFor(() => {
      expect(vi.mocked(api.updateBook)).toHaveBeenCalledWith(
        expect.any(Number),
        { status: 'imported' },
      );
    });

    // Verify the label is preserved through the page wiring to the toast
    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringContaining('to Owned'),
      );
    });
  });
});

describe('LibraryPage — card menu observable behavior (#183)', () => {
  beforeEach(() => {
    localStorage.removeItem('narratorr:library-view');
  });

  it('opens menu when card context menu button is clicked', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /search releases/i })).toBeInTheDocument();
    });
  });

  it('closes menu when same card context menu button is clicked again', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('closes first menu and opens second when different card menu is clicked', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(optionsButtons[0]).toHaveAttribute('aria-expanded', 'true');
    });

    await user.click(optionsButtons[1]);

    await waitFor(() => {
      // First button's menu closed, second button's menu opened
      expect(optionsButtons[0]).toHaveAttribute('aria-expanded', 'false');
      expect(optionsButtons[1]).toHaveAttribute('aria-expanded', 'true');
      // Still exactly one menu in the DOM
      expect(screen.getAllByRole('menu')).toHaveLength(1);
    });
  });

  it('opens releases modal and closes menu when Search Releases is clicked', async () => {
    mockLibraryData(mockBooks);
    vi.mocked(api.searchBooks).mockResolvedValue({ results: [], durationUnknown: false, unsupportedResults: { count: 0, titles: [] } });
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /search releases/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('menuitem', { name: /search releases/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText(/releases for/i)).toBeInTheDocument();
    });

    // Menu should be closed
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens delete confirmation modal and closes menu when Remove is clicked', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: /remove from library/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('menuitem', { name: /remove from library/i }));

    await waitFor(() => {
      expect(screen.getByText('Remove from Library')).toBeInTheDocument();
      expect(screen.getByText(/are you sure you want to remove/i)).toBeInTheDocument();
    });

    // Menu should be closed
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('navigates to /books/:id when card body is clicked', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    // Click the first book card (role="link" with tabIndex=0)
    const bookCards = screen.getAllByRole('link').filter(el => el.getAttribute('tabindex') === '0');
    await user.click(bookCards[0]);

    // Default sort is createdAt desc, so the first rendered card is id=4 (Words of Radiance, Jan 4)
    expect(mockNavigate).toHaveBeenCalledWith('/books/4');
  });

  it('closes menu on document click outside', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    const optionsButtons = screen.getAllByLabelText('Book options');
    await user.click(optionsButtons[0]);

    await waitFor(() => {
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    // Click outside the menu (on the page heading)
    await user.click(screen.getByText('Library'));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});

describe('LibraryPage — import polling smoke test (#183)', () => {
  it('triggers polling interval when books have importing status', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const importingBooks = [
      createMockBook({ id: 1, status: 'importing' }),
      createMockBook({
        id: 2, title: 'Book 2', status: 'importing',
        createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z',
      }),
    ];
    mockLibraryData(importingBooks);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Record call count after initial load
    const initialCallCount = vi.mocked(api.getBooks).mock.calls.length;

    // Advance time by 3s — useImportPolling sets a 3s interval that invalidates queries
    await vi.advanceTimersByTimeAsync(3100);

    // getBooks should have been called again due to the polling invalidation
    await waitFor(() => {
      expect(vi.mocked(api.getBooks).mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    vi.useRealTimers();
  });
});

describe('LibraryPage — status counts and subtitle (#183)', () => {
  it('shows "0 books in your collection" when stats returns zero counts', async () => {
    mockLibraryData([]);

    // Override getBookStats to return null-like zero counts (the page handles empty stats)
    vi.mocked(api.getBookStats).mockResolvedValue({
      counts: { wanted: 0, downloading: 0, imported: 0, failed: 0, missing: 0 },
      authors: [],
      series: [],
      narrators: [],
    });

    renderWithProviders(<LibraryPage />);

    // With 0 totalAll and no search, empty state renders
    await waitFor(() => {
      expect(screen.getByText('Your library is empty')).toBeInTheDocument();
    });
  });

  it('shows result count subtitle when searching', async () => {
    mockLibraryData(mockBooks);
    const user = userEvent.setup();

    renderWithProviders(<LibraryPage />);

    await waitForLibraryLoad();

    // Type in search
    const searchInput = screen.getByPlaceholderText(/search/i);
    await user.type(searchInput, 'Recursion');

    await waitFor(() => {
      expect(screen.getByText(/1 result/)).toBeInTheDocument();
    });
  });

  it('uses singular "book" when totalAll is 1', async () => {
    const singleBook = [createMockBook({ id: 1 })];
    mockLibraryData(singleBook);

    renderWithProviders(<LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText('1 book in your collection')).toBeInTheDocument();
    });
  });

  describe('sort-change animation replay', () => {
    /** Helper: get all book-card DOM elements (role="link" with tabIndex="0"). */
    function getCardElements() {
      return screen.getAllByRole('link').filter(el => el.getAttribute('tabIndex') === '0');
    }

    it('replaces card DOM nodes when sort field changes and settled response arrives', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Capture DOM element references before sort change
      const cardsBefore = getCardElements();
      expect(cardsBefore.length).toBeGreaterThan(0);

      // Change sort field: createdAt → title
      await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      // Wait for settled response
      await waitFor(() => {
        const cardsAfter = getCardElements();
        expect(cardsAfter.length).toBeGreaterThan(0);
        // Every card DOM node should be a NEW element (grid remounted)
        for (const cardAfter of cardsAfter) {
          expect(cardsBefore).not.toContain(cardAfter);
        }
        // Remounted cards have correct stagger animation delays
        cardsAfter.forEach((card, index) => {
          expect(card).toHaveStyle({ animationDelay: `${Math.min(index, 9) * 50}ms` });
        });
      });
    });

    it('preserves card DOM nodes while sorted response is still loading (placeholder phase)', async () => {
      // First call resolves immediately (initial load); second call stays pending (sort change)
      let resolveSortedResponse!: (v: { data: BookWithAuthor[]; total: number }) => void;
      const pendingSortResponse = new Promise<{ data: BookWithAuthor[]; total: number }>((r) => {
        resolveSortedResponse = r;
      });

      vi.mocked(api.getBooks)
        .mockResolvedValueOnce({ data: mockBooks, total: mockBooks.length })
        .mockReturnValueOnce(pendingSortResponse as never);
      vi.mocked(api.getBookStats).mockResolvedValue({
        counts: { wanted: 0, downloading: 0, imported: mockBooks.length, failed: 0, missing: 0 },
        authors: [], series: [], narrators: [],
      });
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Capture card DOM references before sort change
      const cardsBefore = getCardElements();
      expect(cardsBefore.length).toBeGreaterThan(0);

      // Change sort field — this triggers a new query but response is pending
      await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      // During placeholder phase: cards should be the SAME DOM nodes (grid not remounted)
      const cardsDuringPlaceholder = getCardElements();
      for (const card of cardsDuringPlaceholder) {
        expect(cardsBefore).toContain(card);
      }

      // Now resolve the sorted response
      const sortedBooks = [...mockBooks].sort((a, b) => a.title.localeCompare(b.title));
      resolveSortedResponse({ data: sortedBooks, total: sortedBooks.length });

      // After settle: cards should be NEW DOM nodes (grid remounted)
      await waitFor(() => {
        const cardsAfter = getCardElements();
        expect(cardsAfter.length).toBeGreaterThan(0);
        for (const cardAfter of cardsAfter) {
          expect(cardsBefore).not.toContain(cardAfter);
        }
      });
    });

    it('replaces card DOM nodes when sort direction changes and settled response arrives', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // First change to title sort (A→Z)
      await user.click(screen.getByRole('button', { name: /date added.*newest/i }));
      await user.click(screen.getByRole('option', { name: /title.*a.*z/i }));

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Capture DOM element references after first sort settles
      const cardsBefore = getCardElements();
      expect(cardsBefore.length).toBeGreaterThan(0);

      // Toggle direction: A→Z to Z→A
      await user.click(screen.getByRole('button', { name: /title.*a.*z/i }));
      await user.click(screen.getByRole('option', { name: /title.*z.*a/i }));

      // Wait for settled response
      await waitFor(() => {
        const cardsAfter = getCardElements();
        expect(cardsAfter.length).toBeGreaterThan(0);
        // Every card DOM node should be a NEW element (grid remounted)
        for (const cardAfter of cardsAfter) {
          expect(cardsBefore).not.toContain(cardAfter);
        }
      });
    });

    it('preserves card DOM nodes when search filter changes within the same sort order', async () => {
      mockLibraryData(mockBooks);
      const user = userEvent.setup();

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      // Capture a specific card DOM element reference before search change
      const wayOfKingsCard = getCardElements().find(
        el => el.querySelector('h3')?.textContent === 'The Way of Kings',
      )!;
      expect(wayOfKingsCard).toBeDefined();

      // Type a search query that matches "The Way of Kings"
      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'Way');

      // Wait for filtered results to settle — same card should be the SAME DOM node
      await waitFor(() => {
        const cardsAfter = getCardElements();
        const sameCard = cardsAfter.find(
          el => el.querySelector('h3')?.textContent === 'The Way of Kings',
        );
        // Grid container key unchanged (sort params stable) → card persists as same node
        expect(sameCard).toBe(wayOfKingsCard);
      });
    });

    it('applies stagger animation delays on initial load (index * 50ms, capped at 450ms)', async () => {
      mockLibraryData(mockBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      });

      const cards = getCardElements();
      expect(cards.length).toBe(mockBooks.length);

      cards.forEach((card, index) => {
        const expectedDelay = `${Math.min(index, 9) * 50}ms`;
        expect(card).toHaveStyle({ animationDelay: expectedDelay });
      });
    });

    it('caps animation delay at 450ms for cards at index >= 10', async () => {
      const manyBooks = Array.from({ length: 15 }, (_, i) =>
        createMockBook({
          id: i + 1,
          title: `Book ${String.fromCharCode(65 + i)}`,
          createdAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          updatedAt: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
        }),
      );
      mockLibraryData(manyBooks);

      renderWithProviders(<LibraryPage />);

      await waitFor(() => {
        expect(screen.getByText('Book A')).toBeInTheDocument();
      });

      const cards = getCardElements();
      expect(cards.length).toBe(15);

      // Cards at index 10-14 should all have 450ms delay (capped at Math.min(index, 9) * 50)
      for (let i = 10; i < 15; i++) {
        expect(cards[i]).toHaveStyle({ animationDelay: '450ms' });
      }
    });
  });
});
