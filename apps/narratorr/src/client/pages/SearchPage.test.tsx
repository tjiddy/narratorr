import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../__tests__/helpers';
import { SearchPage } from './SearchPage';
import { api, ApiError } from '@/lib/api';
import type { BookMetadata, BookWithAuthor } from '@/lib/api';

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
      search: vi.fn(),
      grab: vi.fn(),
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

const mockLibraryBook: BookWithAuthor = {
  id: 1,
  title: 'Existing Book',
  authorId: 1,
  narrator: null,
  description: null,
  coverUrl: null,
  asin: 'B000EXISTING',
  isbn: null,
  seriesName: null,
  seriesPosition: null,
  duration: null,
  publishedDate: null,
  genres: null,
  status: 'wanted',
  path: null,
  size: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  author: { id: 1, name: 'Some Author', slug: 'some-author' },
};

describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([mockLibraryBook]);
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
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

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
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([libraryBookWithAsin]);

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
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

    await user.click(screen.getByRole('button', { name: /add/i }));

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledWith(expect.objectContaining({
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
        narrator: 'Michael Kramer',
        seriesName: 'The Stormlight Archive',
      }));
    });

    // After success, should show "In Library"
    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('handles 409 duplicate gracefully', async () => {
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

    await user.click(screen.getByRole('button', { name: /add/i }));

    // After 409, should show "In Library"
    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('shows error message when grab fails in indexer mode', async () => {
    (api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        title: 'Test Audiobook',
        author: 'Test Author',
        protocol: 'torrent',
        infoHash: 'abc123',
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
        size: 1024 * 1024 * 1024,
        seeders: 10,
        indexer: 'TestIndexer',
      },
    ]);
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    // Switch to indexer mode
    await user.click(screen.getByText('Search Indexers'));

    const input = screen.getByPlaceholderText(/search audiobooks/i);
    await user.type(input, 'Test Audiobook');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('Test Audiobook')).toBeInTheDocument();
    });

    // Now make grab fail
    vi.mocked(api.grab).mockRejectedValue(new Error('Client offline'));

    await user.click(screen.getByRole('button', { name: /grab/i }));

    await waitFor(() => {
      expect(screen.getByText(/Failed to start download: Client offline/)).toBeInTheDocument();
    });
  });

  it('disables grab button when result has no downloadUrl in indexer mode', async () => {
    (api.search as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        title: 'No Link Result',
        author: 'Author',
        protocol: 'torrent',
        infoHash: 'xyz',
        downloadUrl: '',
        size: 500_000_000,
        seeders: 2,
        indexer: 'TestIndexer',
      },
    ]);
    (api.getBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    renderWithProviders(<SearchPage />);
    const user = userEvent.setup();

    // Switch to indexer mode
    await user.click(screen.getByText('Search Indexers'));

    const input = screen.getByPlaceholderText(/search audiobooks/i);
    await user.type(input, 'No Link');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => {
      expect(screen.getByText('No Link Result')).toBeInTheDocument();
    });

    const grabButton = screen.getByRole('button', { name: /grab/i });
    expect(grabButton).toBeDisabled();
  });
});
