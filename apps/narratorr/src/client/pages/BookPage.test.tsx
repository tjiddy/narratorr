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
    getBook: vi.fn(),
    getBooks: vi.fn(),
    addBook: vi.fn(),
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

const mockBook = {
  asin: 'B00ABC1234',
  title: 'The Way of Kings',
  subtitle: 'Book One of the Stormlight Archive',
  authors: [
    { name: 'Brandon Sanderson', asin: 'A00SAND1234' },
  ],
  narrators: ['Michael Kramer', 'Kate Reading'],
  series: [{ name: 'The Stormlight Archive', position: 1, asin: 'S001' }],
  description: '<p>A wonderful epic fantasy novel about honor and betrayal.</p>',
  coverUrl: 'https://example.com/cover.jpg',
  duration: 872,
  genres: ['Fantasy', 'Epic', 'Adventure'],
};

const mockLibraryBooks = [
  {
    id: 1,
    title: 'Project Hail Mary',
    asin: 'B00OTHER',
    status: 'wanted',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    author: { id: 1, name: 'Andy Weir', slug: 'andy-weir' },
  },
];

function renderBookPage(asin = 'B00ABC1234') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/books/${asin}`]}>
        <Routes>
          <Route path="books/:asin" element={<BookPage />} />
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
    vi.mocked(api.getBook).mockResolvedValue(mockBook);
    vi.mocked(api.getBooks).mockResolvedValue(mockLibraryBooks);
  });

  it('renders loading skeleton initially', () => {
    // Delay resolution to see skeleton
    vi.mocked(api.getBook).mockReturnValue(new Promise(() => {}));
    renderBookPage();
    // Skeleton should show placeholder elements
    expect(document.querySelector('.skeleton')).toBeTruthy();
  });

  it('renders all metadata fields', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.getByText(/Michael Kramer, Kate Reading/)).toBeInTheDocument();
    expect(screen.getByText(/The Stormlight Archive #1/)).toBeInTheDocument();
    expect(screen.getByText(/14h 32m/)).toBeInTheDocument();
  });

  it('renders genre chips', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
    });

    expect(screen.getByText('Epic')).toBeInTheDocument();
    expect(screen.getByText('Adventure')).toBeInTheDocument();
  });

  it('shows "Book not found" when book fails to load', async () => {
    vi.mocked(api.getBook).mockRejectedValue(new Error('Not found'));
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Book not found')).toBeInTheDocument();
    });
  });

  it('shows "Add to Library" when not in library', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Add to Library')).toBeInTheDocument();
    });
  });

  it('shows "In Library" when book is already in library', async () => {
    vi.mocked(api.getBooks).mockResolvedValue([
      {
        id: 1,
        title: 'The Way of Kings',
        asin: 'B00ABC1234',
        status: 'wanted',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
      },
    ]);

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('adds book to library on button click', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addBook).mockResolvedValue({
      id: 2,
      title: 'The Way of Kings',
      asin: 'B00ABC1234',
      status: 'wanted',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    });

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Add to Library')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Add to Library'));

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith("Added 'The Way of Kings' to library");
    });
  });

  it('renders description with show more toggle', async () => {
    const longDescription = '<p>' + 'A'.repeat(400) + '</p>';
    vi.mocked(api.getBook).mockResolvedValue({ ...mockBook, description: longDescription });

    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
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

  it('links author names to author page', async () => {
    renderBookPage();

    await waitFor(() => {
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    });

    const authorLink = screen.getByText('Brandon Sanderson');
    expect(authorLink.closest('a')).toHaveAttribute('href', '/authors/A00SAND1234');
  });
});
