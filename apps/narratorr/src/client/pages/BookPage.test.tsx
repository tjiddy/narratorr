import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookPage } from '@/pages/BookPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getBookById: vi.fn(),
    getBook: vi.fn(),
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

const mockLibraryBook = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  narrator: 'Michael Kramer, Kate Reading',
  description: '<p>An epic fantasy novel.</p>',
  coverUrl: 'https://example.com/cover.jpg',
  asin: 'B00ABC1234',
  isbn: null,
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  duration: 872,
  publishedDate: '2010-08-31',
  genres: ['Fantasy', 'Epic'],
  status: 'wanted',
  path: null,
  size: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson', asin: 'A00SAND1234' },
};

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
      <MemoryRouter initialEntries={[`/books/${id}`]}>
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

  it('renders loading skeleton initially', () => {
    vi.mocked(api.getBookById).mockReturnValue(new Promise(() => {}));
    renderBookPage();
    expect(document.querySelector('.skeleton')).toBeTruthy();
  });

  it('renders library book data', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.getByText(/Michael Kramer, Kate Reading/)).toBeInTheDocument();
    expect(screen.getByText(/The Stormlight Archive #1/)).toBeInTheDocument();
    expect(screen.getByText(/14h 32m/)).toBeInTheDocument();
  });

  it('renders book without ASIN (no metadata enrichment)', async () => {
    vi.mocked(api.getBookById).mockResolvedValue({
      ...mockLibraryBook,
      asin: null,
      description: '<p>Library description only.</p>',
    });
    vi.mocked(api.getBook).mockResolvedValue(null as any);

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Should not call metadata API when ASIN is null
    expect(api.getBook).not.toHaveBeenCalled();
  });

  it('renders genre chips', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
    });

    expect(screen.getByText('Epic')).toBeInTheDocument();
  });

  it('shows status badge', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Wanted')).toBeInTheDocument();
    });
  });

  it('shows "Book not found" when book fails to load', async () => {
    vi.mocked(api.getBookById).mockRejectedValue(new Error('Not found'));
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Book not found')).toBeInTheDocument();
    });
  });

  it('renders back link to library', async () => {
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

  it('renders description with show more toggle', async () => {
    const longDescription = '<p>' + 'A'.repeat(400) + '</p>';
    vi.mocked(api.getBookById).mockResolvedValue({ ...mockLibraryBook, description: longDescription });

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });
  });

  it('enriches with metadata subtitle when ASIN present', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
    });
  });
});
