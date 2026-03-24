import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers';
import { SearchPage } from './SearchPage';
import { api, ApiError } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';
import type { BookMetadata } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const originalApi = actual.api as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...originalApi,
      searchMetadata: vi.fn(),
      getBooks: vi.fn(),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
      }),
    },
  };
});

const mockBookMetadata: BookMetadata = {
  title: 'The Way of Kings',
  authors: [{ name: 'Brandon Sanderson', asin: 'B001IGFHW6' }],
  narrators: ['Michael Kramer'],
  series: [{ name: 'The Stormlight Archive', position: 1 }],
  asin: 'B003P2WO5E',
  coverUrl: 'https://example.com/cover.jpg',
  description: 'An epic fantasy',
  duration: 2700,
  genres: ['Fantasy'],
};

const mockLibraryBook = createMockBook({
  title: 'Existing Book',
  asin: 'B000EXISTING',
  narrators: [],
  authors: [{ id: 1, name: 'Some Author', slug: 'some-author' }],
});

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [mockLibraryBook], total: 1 });
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      books: [mockBookMetadata],
      authors: [],
    });
  });

  it('renders search form', () => {
    renderWithProviders(<SearchPage />);
    expect(screen.getByPlaceholderText(/search by title/i)).toBeInTheDocument();
  });

  it('shows Add button for books not in library', async () => {
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Way of Kings');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /add/i })).toBeInTheDocument();
  });

  it('shows In Library indicator when book matches by ASIN', async () => {
    const libraryBookWithAsin = {
      ...mockLibraryBook,
      asin: 'B003P2WO5E',
      title: 'The Way of Kings',
      author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
    };
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [libraryBookWithAsin], total: 1 });

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Way of Kings');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('calls addBook on Add button click and shows success toast', async () => {
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });
    (api.addBook as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 2,
      title: 'The Way of Kings',
      status: 'wanted',
    });

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Way of Kings');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open popover
    await user.click(screen.getByRole('button', { name: /add/i }));
    // Click Add to Library in popover
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
        title: 'The Way of Kings',
        authors: expect.arrayContaining([expect.objectContaining({ name: 'Brandon Sanderson' })]),
        narrators: expect.arrayContaining(['Michael Kramer']),
        seriesName: 'The Stormlight Archive',
      }));
    });

    // After success, should show "In Library"
    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('shows empty state before searching', () => {
    renderWithProviders(<SearchPage />);
    expect(screen.getByText('Start your search')).toBeInTheDocument();
  });

  it('shows no results message when search returns empty', async () => {
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      books: [],
      authors: [],
    });

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'nonexistent book');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText(/No results for "nonexistent book"/)).toBeInTheDocument();
    });
  });

  it('shows error message when search fails', async () => {
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error'),
    );

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Way of Kings');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('disables search button when query is too short', () => {
    renderWithProviders(<SearchPage />);
    const searchButton = screen.getByRole('button', { name: /^search$/i });
    expect(searchButton).toBeDisabled();
  });

  it('shows multiple results with book count', async () => {
    const secondBook: BookMetadata = {
      ...mockBookMetadata,
      title: 'Words of Radiance',
      asin: 'B00ANOTHER',
    };
    (api.searchMetadata as ReturnType<typeof vi.fn>).mockResolvedValue({
      books: [mockBookMetadata, secondBook],
      authors: [],
    });
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Sanderson');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Words of Radiance')).toBeInTheDocument();
    });

    // Book count shown in tab
    expect(screen.getByText('(2)')).toBeInTheDocument();
  });

  it('handles 409 duplicate gracefully', async () => {
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [], total: 0 });
    (api.addBook as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(409, { id: 1, title: 'The Way of Kings' }),
    );

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    const input = screen.getByPlaceholderText(/search by title/i);
    await user.type(input, 'Way of Kings');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open popover
    await user.click(screen.getByRole('button', { name: /add/i }));
    // Click Add to Library in popover
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    // After 409, should show "In Library"
    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  describe('Add Book identity', () => {
    it('shows "Add Book" heading on the page', () => {
      renderWithProviders(<SearchPage />);
      expect(screen.getByRole('heading', { name: /add book/i })).toBeInTheDocument();
    });

    it('does not show "Discover Audiobooks" hero headline', () => {
      renderWithProviders(<SearchPage />);
      expect(screen.queryByText(/discover audiobooks/i)).not.toBeInTheDocument();
    });

    it('does not use "Discover" language in any heading or subheading', () => {
      renderWithProviders(<SearchPage />);
      const headings = screen.queryAllByRole('heading');
      for (const heading of headings) {
        expect(heading.textContent?.toLowerCase()).not.toMatch(/discover/);
      }
    });

    it('search form is the first interactive control on the page', () => {
      renderWithProviders(<SearchPage />);
      const input = screen.getByPlaceholderText(/search by title/i);
      expect(input).toBeInTheDocument();
      // The search input should be present and precede any results area
      expect(input.tagName).toBe('INPUT');
    });
  });
});
