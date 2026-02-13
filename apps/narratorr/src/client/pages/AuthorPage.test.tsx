import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthorPage } from '@/pages/AuthorPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getAuthor: vi.fn(),
    getAuthorBooks: vi.fn(),
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

const mockAuthor = {
  asin: 'A00SAND1234',
  name: 'Brandon Sanderson',
  description: '<p>Brandon Sanderson is an American author of epic fantasy and science fiction.</p>',
  imageUrl: 'https://example.com/sanderson.jpg',
  genres: ['Fantasy', 'Science Fiction'],
};

const mockBooks = [
  {
    asin: 'B001',
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson', asin: 'A00SAND1234' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    series: [{ name: 'The Stormlight Archive', position: 1 }],
    coverUrl: 'https://example.com/wok.jpg',
    duration: 2729,
    genres: ['Fantasy'],
  },
  {
    asin: 'B002',
    title: 'Words of Radiance',
    authors: [{ name: 'Brandon Sanderson', asin: 'A00SAND1234' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    series: [{ name: 'The Stormlight Archive', position: 2 }],
    coverUrl: 'https://example.com/wor.jpg',
    duration: 2893,
    genres: ['Fantasy'],
  },
  {
    asin: 'B003',
    title: 'The Final Empire',
    authors: [{ name: 'Brandon Sanderson', asin: 'A00SAND1234' }],
    narrators: ['Michael Kramer'],
    series: [{ name: 'Mistborn', position: 1 }],
    coverUrl: 'https://example.com/tfe.jpg',
    duration: 1479,
    genres: ['Fantasy'],
  },
  {
    asin: 'B004',
    title: 'Warbreaker',
    authors: [{ name: 'Brandon Sanderson', asin: 'A00SAND1234' }],
    narrators: ['Abell Greenspan'],
    series: undefined,
    coverUrl: 'https://example.com/wb.jpg',
    duration: 1412,
    genres: ['Fantasy'],
  },
];

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

function renderAuthorPage(asin = 'A00SAND1234') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/authors/${asin}`]}>
        <Routes>
          <Route path="authors/:asin" element={<AuthorPage />} />
          <Route path="library" element={<div>Library Page</div>} />
          <Route path="books/:id" element={<div>Book Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AuthorPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAuthor).mockResolvedValue(mockAuthor);
    vi.mocked(api.getAuthorBooks).mockResolvedValue(mockBooks);
    vi.mocked(api.getBooks).mockResolvedValue(mockLibraryBooks);
  });

  it('renders loading skeleton initially', () => {
    vi.mocked(api.getAuthor).mockReturnValue(new Promise(() => {}));
    renderAuthorPage();
    expect(document.querySelector('.skeleton')).toBeTruthy();
  });

  it('renders author name and image', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    });

    const img = screen.getByAltText('Brandon Sanderson');
    expect(img).toHaveAttribute('src', 'https://example.com/sanderson.jpg');
  });

  it('renders genre tags', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
    });
    expect(screen.getByText('Science Fiction')).toBeInTheDocument();
  });

  it('renders book count', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText(/4 audiobooks/)).toBeInTheDocument();
    });
  });

  it('renders author bio', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText(/Brandon Sanderson is an American author/)).toBeInTheDocument();
    });
  });

  it('renders bio with show more toggle for long descriptions', async () => {
    const longBio = '<p>' + 'A'.repeat(400) + '</p>';
    vi.mocked(api.getAuthor).mockResolvedValue({ ...mockAuthor, description: longBio });

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });
  });

  it('groups books by series', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    });

    expect(screen.getByText('Mistborn')).toBeInTheDocument();
    expect(screen.getByText('Standalone')).toBeInTheDocument();
  });

  it('renders books within series with position', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.getByText('Words of Radiance')).toBeInTheDocument();
    expect(screen.getByText('The Final Empire')).toBeInTheDocument();
    expect(screen.getByText('Warbreaker')).toBeInTheDocument();
  });

  it('renders standalone books in separate section', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Warbreaker')).toBeInTheDocument();
    });

    expect(screen.getByText('Standalone')).toBeInTheDocument();
  });

  it('shows "Author not found" when author fails to load', async () => {
    vi.mocked(api.getAuthor).mockRejectedValue(new Error('Not found'));
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Author not found')).toBeInTheDocument();
    });
  });

  it('renders add buttons for books not in library', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Should have add buttons (+ icons) for books not in library
    const addButtons = screen.getAllByTitle(/Add ".*" to library/);
    expect(addButtons.length).toBe(4);
  });

  it('adds a book to library on button click', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addBook).mockResolvedValue({
      id: 2,
      title: 'The Way of Kings',
      asin: 'B001',
      status: 'wanted',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    });

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const addButton = screen.getByTitle('Add "The Way of Kings" to library');
    await user.click(addButton);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith("Added 'The Way of Kings' to library");
    });
  });

  it('shows check icon for books already in library', async () => {
    vi.mocked(api.getBooks).mockResolvedValue([
      {
        id: 1,
        title: 'The Way of Kings',
        asin: 'B001',
        status: 'wanted',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
      },
    ]);

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Should have 3 add buttons (Way of Kings is in library)
    const addButtons = screen.getAllByTitle(/Add ".*" to library/);
    expect(addButtons.length).toBe(3);
  });

  it('renders back button', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Back')).toBeInTheDocument();
    });
  });

  it('renders book titles in catalog', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });
  });

  it('renders initials avatar when no image', async () => {
    vi.mocked(api.getAuthor).mockResolvedValue({ ...mockAuthor, imageUrl: undefined });
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('BS')).toBeInTheDocument();
    });
  });

  it('shows series count in stats', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText(/2 series/)).toBeInTheDocument();
    });
  });

  it('renders "Add All" buttons for each series', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    });

    const addAllButtons = screen.getAllByText(/Add All/);
    // 3 sections: Stormlight Archive, Mistborn, Standalone
    expect(addAllButtons.length).toBe(3);
  });

  it('renders narrator and duration for books', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Michael Kramer, Kate Reading').length).toBeGreaterThan(0);
    expect(screen.getByText('45h 29m')).toBeInTheDocument();
  });
});
