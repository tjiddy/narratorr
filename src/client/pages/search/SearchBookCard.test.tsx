import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBookCard } from './SearchBookCard';
import { createMockBookMetadata, createMockBook } from '@/__tests__/factories';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, monitorForUpgrades: false, rejectWords: '', requiredWords: '' },
      }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';

function renderCard(bookOverrides = {}, libraryBooks?: ReturnType<typeof createMockBook>[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const book = createMockBookMetadata(bookOverrides);
  return render(
    <QueryClientProvider client={queryClient}>
      <SearchBookCard book={book} index={0} libraryBooks={libraryBooks} queryClient={queryClient} />
    </QueryClientProvider>,
  );
}

describe('SearchBookCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders book title and author', () => {
    renderCard();
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders cover image when coverUrl is provided', () => {
    renderCard();
    expect(screen.getByAltText('The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback icon when no coverUrl', () => {
    renderCard({ coverUrl: undefined });
    expect(screen.queryByAltText('The Way of Kings')).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    renderCard();
    expect(screen.getByText(/Narrated by Michael Kramer, Kate Reading/)).toBeInTheDocument();
  });

  it('renders genre badges up to 3 max', () => {
    renderCard({ genres: ['Fantasy', 'Epic', 'Adventure', 'Romance'] });
    expect(screen.getByText('Fantasy')).toBeInTheDocument();
    expect(screen.getByText('Epic')).toBeInTheDocument();
    expect(screen.getByText('Adventure')).toBeInTheDocument();
    expect(screen.queryByText('Romance')).not.toBeInTheDocument();
  });

  it('shows Add button when not in library', () => {
    renderCard();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows In Library badge when book is in library', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [createMockBook({ asin: book.asin })];
    renderCard({}, libraryBooks);
    expect(screen.getByText('In Library')).toBeInTheDocument();
  });

  it('calls addBook via popover flow', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 1, title: 'The Way of Kings' } as never);
    const user = userEvent.setup();
    renderCard();

    // Open popover
    await user.click(screen.getByRole('button'));
    // Click Add to Library
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledTimes(1);
    });
  });

  it('shows In Library after successful add', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 1, title: 'The Way of Kings' } as never);
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Added 'The Way of Kings' to library");
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('handles 409 duplicate gracefully', async () => {
    vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { id: 1 }));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('Already in library');
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
  });

  it('shows error toast for non-409 errors', async () => {
    vi.mocked(api.addBook).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add book: Network error');
    });
  });
});
