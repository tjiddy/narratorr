import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockBook } from '@/__tests__/factories';
import { BookPage } from './BookPage';

vi.mock('@/lib/api', () => ({
  api: {
    getBookById: vi.fn(),
    getBook: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockLibraryBook = createMockBook({
  asin: 'B00ABC1234',
  narrators: [{ id: 1, name: 'Michael Kramer', slug: 'michael-kramer' }, { id: 2, name: 'Kate Reading', slug: 'kate-reading' }],
  duration: 872,
  authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'A00SAND1234' }],
});

const mockMetadataBook = {
  title: 'The Way of Kings',
  subtitle: 'Book One of the Stormlight Archive',
  authors: [{ name: 'Brandon Sanderson', asin: 'A00SAND1234' }],
  narrators: ['Michael Kramer', 'Kate Reading'],
  series: [{ name: 'The Stormlight Archive', position: 1 }],
  description: '<p>Full metadata description.</p>',
  coverUrl: 'https://example.com/cover.jpg',
  duration: 872,
  genres: ['Fantasy', 'Epic', 'Adventure'],
  publisher: 'Macmillan Audio',
  asin: 'B00ABC1234',
};

function renderBookPage(id = '1') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/library', `/books/${id}`]}>
        <Routes>
          <Route path="books/:id" element={<BookPage />} />
          <Route path="library" element={<div>Library Page</div>} />
          <Route path="search" element={<div>Search Page</div>} />
          <Route path="authors/:asin" element={<div>Author Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BookPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getBookById).mockResolvedValue(mockLibraryBook);
    vi.mocked(api.getBook).mockResolvedValue(mockMetadataBook);
  });

  it('shows loading state with book content not yet visible', () => {
    vi.mocked(api.getBookById).mockReturnValue(new Promise(() => {}));
    renderBookPage();

    // Content should not be visible while loading
    expect(screen.queryByText('The Way of Kings')).not.toBeInTheDocument();
    expect(screen.queryByText('Brandon Sanderson')).not.toBeInTheDocument();
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });

  it('renders library book data with metadata enrichment', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Author, narrator, series, duration
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.getByText(/Michael Kramer, Kate Reading/)).toBeInTheDocument();
    expect(screen.getByText(/The Stormlight Archive #1/)).toBeInTheDocument();
    expect(screen.getByText(/14h 32m/)).toBeInTheDocument();

    // Metadata enrichment: subtitle arrives on a second query cycle
    await waitFor(() => {
      expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
    });
    expect(screen.getByText('Fantasy')).toBeInTheDocument();
    expect(screen.getByText('Epic')).toBeInTheDocument();

    // Status badge
    expect(screen.getByText('Wanted')).toBeInTheDocument();
  });

  it('renders book without ASIN (no metadata enrichment)', async () => {
    vi.mocked(api.getBookById).mockResolvedValue({
      ...mockLibraryBook,
      asin: null,
      description: '<p>Library description only.</p>',
    });
    vi.mocked(api.getBook).mockResolvedValue(null as never);

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(api.getBook).not.toHaveBeenCalled();
  });

  it('shows "Book not found" when book fails to load', async () => {
    vi.mocked(api.getBookById).mockRejectedValue(new Error('Not found'));
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Book not found')).toBeInTheDocument();
    });

    expect(screen.getByText(/Back to Library/)).toBeInTheDocument();
  });

  it('still renders base data when metadata enrichment fails', async () => {
    vi.mocked(api.getBook).mockRejectedValue(new Error('Metadata service down'));
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Base data renders fine
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.getByText(/Michael Kramer, Kate Reading/)).toBeInTheDocument();

    // Subtitle from metadata is not present since it failed
    expect(screen.queryByText('Book One of the Stormlight Archive')).not.toBeInTheDocument();
  });

  it('navigates back to library when back button is clicked', async () => {
    const user = userEvent.setup();
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Library'));

    await waitFor(() => {
      expect(screen.getByText('Library Page')).toBeInTheDocument();
    });
  });

  it('links author name to author page when author has ASIN', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    });

    const authorLink = screen.getByText('Brandon Sanderson');
    expect(authorLink.closest('a')).toHaveAttribute('href', '/authors/A00SAND1234');
  });

  it('toggles description expand/collapse for long descriptions', async () => {
    const user = userEvent.setup();
    const longDescription = '<p>' + 'A'.repeat(400) + '</p>';
    vi.mocked(api.getBookById).mockResolvedValue({ ...mockLibraryBook, description: longDescription });

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();

    await user.click(screen.getByText('Show less'));
    expect(screen.getByText('Show more')).toBeInTheDocument();
  });

  it('opens search releases modal when button is clicked', async () => {
    const user = userEvent.setup();
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Search Releases')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Search Releases'));

    // Modal should open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
