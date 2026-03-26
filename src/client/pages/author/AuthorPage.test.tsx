import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockBook, createMockAuthor } from '@/__tests__/factories';
import { AuthorPage } from './AuthorPage';

// Mock api
vi.mock('@/lib/api', () => ({
  api: {
    getAuthor: vi.fn(),
    getAuthorBooks: vi.fn(),
    getBookIdentifiers: vi.fn(),
    addBook: vi.fn(),
    getSettings: vi.fn(),
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
  createMockBook({
    id: 1,
    title: 'Project Hail Mary',
    asin: 'B00OTHER',
    authors: [createMockAuthor({ id: 1, name: 'Andy Weir', slug: 'andy-weir' })],
  }),
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
    vi.mocked(api.getBookIdentifiers).mockResolvedValue(mockLibraryBooks.map((b) => ({ asin: b.asin ?? null, title: b.title, authorName: b.authors[0]?.name ?? null, authorSlug: null })));
    vi.mocked(api.getSettings).mockResolvedValue({
      quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
    } as never);
  });

  it('renders loading skeleton with multiple placeholders', () => {
    vi.mocked(api.getAuthor).mockReturnValue(new Promise(() => {}));
    renderAuthorPage();

    // Skeleton renders visible placeholder content
    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(5);
    // Avatar placeholder is a rounded-full skeleton
    expect(document.querySelector('.skeleton.rounded-full')).toBeInTheDocument();
  });

  it('renders author name and image', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    });

    await waitFor(() => {
      const img = screen.getByAltText('Brandon Sanderson');
      expect(img).toHaveAttribute('src', 'https://example.com/sanderson.jpg');
    });
  });

  it('renders genre tags', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Fantasy')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Science Fiction')).toBeInTheDocument();
    });
  });

  it('renders book count and series count in stats', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText(/4 audiobooks/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/2 series/)).toBeInTheDocument();
    });
  });

  it('renders author bio and toggles show more/less', async () => {
    const longBio = '<p>' + 'A'.repeat(400) + '</p>';
    vi.mocked(api.getAuthor).mockResolvedValue({ ...mockAuthor, description: longBio });
    const user = userEvent.setup();

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Show more'));
    await waitFor(() => {
      expect(screen.getByText('Show less')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Show less'));
    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });
  });

  it('groups books by series with standalone section', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('Mistborn')).toBeInTheDocument();
      expect(screen.getByText('Standalone')).toBeInTheDocument();
      // All book titles present
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByText('Words of Radiance')).toBeInTheDocument();
      expect(screen.getByText('The Final Empire')).toBeInTheDocument();
      expect(screen.getByText('Warbreaker')).toBeInTheDocument();
    });
  });

  it('shows "Author not found" when author fails to load', async () => {
    vi.mocked(api.getAuthor).mockRejectedValue(new Error('Not found'));
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Author not found')).toBeInTheDocument();
    });

    // Has a back-to-library link
    await waitFor(() => {
      const backLink = screen.getByText('Back to Library').closest('a');
      expect(backLink).toHaveAttribute('href', '/library');
    });
  });

  it('renders add popover buttons for books not in library', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // AddBookPopover renders buttons — 4 books not in library + Add All buttons
    // Each not-in-library book gets an Add popover button
    await waitFor(() => {
      const inLibraryIcons = screen.queryAllByLabelText('In library');
      expect(inLibraryIcons.length).toBe(0); // no books in library by default
    });
  });

  it('adds a book to library via popover', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addBook).mockResolvedValue(createMockBook({ id: 2, asin: 'B001' }));

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Find the first AddBookPopover's trigger button (excludes "Add All" buttons)
    const addButtons = screen.getAllByRole('button').filter(
      (btn) => btn.textContent?.includes('Add') && !btn.textContent?.includes('Add All'),
    );
    expect(addButtons.length).toBeGreaterThan(0);
    await user.click(addButtons[0]);

    // Click "Add to Library" in the popover
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalled();
    });
  });

  it('shows check icon for books already in library', async () => {
    vi.mocked(api.getBookIdentifiers).mockResolvedValue([
      { asin: 'B001', title: 'The Way of Kings', authorName: 'Brandon Sanderson', authorSlug: null },
    ]);

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // One book in library shows check icon
    await waitFor(() => {
      const inLibrary = screen.getAllByLabelText('In library');
      expect(inLibrary.length).toBe(1);
    });
  });

  it('renders back button that navigates back', async () => {
    const user = userEvent.setup();
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('Back')).toBeInTheDocument();
    });

    // The back button exists and is clickable
    await user.click(screen.getByText('Back'));
    // Navigation is handled by navigate(-1), which we don't mock deeply,
    // but clicking should not throw
  });

  it('renders initials avatar when no image', async () => {
    vi.mocked(api.getAuthor).mockResolvedValue({ ...mockAuthor, imageUrl: undefined });
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('BS')).toBeInTheDocument();
    });
  });

  it('renders "Add All" buttons for each series section', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    });

    await waitFor(() => {
      const addAllButtons = screen.getAllByText(/Add All/);
      // 3 sections: Stormlight Archive, Mistborn, Standalone
      expect(addAllButtons.length).toBe(3);
    });
  });

  it('clicks Add All to add all books in a series', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addBook).mockResolvedValue(createMockBook({ id: 10, title: 'Added' }));

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Stormlight Archive')).toBeInTheDocument();
    });

    const addAllButtons = screen.getAllByText(/Add All/);
    // Click the first "Add All" (Mistborn comes first alphabetically, 1 book)
    await user.click(addAllButtons[0]);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalled();
    });
  });

  it('renders narrator and duration for books', async () => {
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getAllByText('Michael Kramer, Kate Reading').length).toBeGreaterThan(0);
      expect(screen.getByText('45h 29m')).toBeInTheDocument();
    });
  });

  it('shows error toast when addBook fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.addBook).mockRejectedValue(new Error('Server error'));

    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open popover and click Add to Library
    const addButtons = screen.getAllByRole('button').filter(
      (btn) => btn.textContent?.includes('Add') && !btn.textContent?.includes('Add All'),
    );
    await user.click(addButtons[0]);

    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('shows empty catalog message when author has no books', async () => {
    vi.mocked(api.getAuthorBooks).mockResolvedValue([]);
    renderAuthorPage();

    await waitFor(() => {
      expect(screen.getByText('No audiobooks found for this author.')).toBeInTheDocument();
    });
  });
});
