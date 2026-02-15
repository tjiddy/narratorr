import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import type { BookWithAuthor, SearchResult } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    search: vi.fn(),
    grab: vi.fn(),
    addToBlacklist: vi.fn(),
  },
  formatBytes: (bytes?: number) => {
    if (!bytes) return '0 B';
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockBook: BookWithAuthor = {
  id: 1,
  title: 'The Way of Kings',
  authorId: 1,
  status: 'wanted',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
};

const mockResults: SearchResult[] = [
  {
    title: 'The Way of Kings [Unabridged]',
    author: 'Brandon Sanderson',
    narrator: 'Michael Kramer',
    protocol: 'torrent',
    infoHash: 'abc123',
    downloadUrl: 'magnet:?xt=urn:btih:abc123',
    size: 5 * 1024 * 1024 * 1024,
    seeders: 24,
    indexer: 'AudioBookBay',
  },
  {
    title: 'Way of Kings (Graphic Audio)',
    author: 'Brandon Sanderson',
    protocol: 'torrent',
    infoHash: 'def456',
    downloadUrl: 'magnet:?xt=urn:btih:def456',
    size: 8 * 1024 * 1024 * 1024,
    seeders: 8,
    indexer: 'AudioBookBay',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SearchReleasesModal', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <SearchReleasesModal isOpen={false} book={mockBook} onClose={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows book title and author in header', async () => {
    vi.mocked(api.search).mockResolvedValue(mockResults);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    expect(screen.getByText('by Brandon Sanderson')).toBeInTheDocument();
  });

  it('auto-searches with book title and author name', async () => {
    vi.mocked(api.search).mockResolvedValue(mockResults);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(api.search).toHaveBeenCalledWith('The Way of Kings Brandon Sanderson');
    });
  });

  it('shows loading state then results', async () => {
    vi.mocked(api.search).mockResolvedValue(mockResults);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    // Wait for results
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
    });

    expect(screen.getByText('Way of Kings (Graphic Audio)')).toBeInTheDocument();
    expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
  });

  it('shows empty state when no results', async () => {
    vi.mocked(api.search).mockResolvedValue([]);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('No releases found')).toBeInTheDocument();
    });
  });

  it('grab passes bookId and calls onClose on success', async () => {
    vi.mocked(api.search).mockResolvedValue(mockResults);
    vi.mocked(api.grab).mockResolvedValue({
      id: 1,
      title: 'The Way of Kings [Unabridged]',
      protocol: 'torrent',
      status: 'queued' as const,
      progress: 0,
      addedAt: '2024-01-01T00:00:00Z',
    });
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    // Wait for results to render
    const title = await screen.findByText('The Way of Kings [Unabridged]');
    expect(title).toBeInTheDocument();

    // Click Grab on first result
    const grabButtons = screen.getAllByText('Grab');
    await user.click(grabButtons[0]);

    await waitFor(() => {
      expect(api.grab).toHaveBeenCalledTimes(1);
    });

    expect(vi.mocked(api.grab).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        downloadUrl: 'magnet:?xt=urn:btih:abc123',
        title: 'The Way of Kings [Unabridged]',
        bookId: 1,
      }),
    );

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Download started! Check the Activity page.');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    vi.mocked(api.search).mockResolvedValue([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    // Click the backdrop (outermost overlay div)
    const backdrop = screen.getByText('Releases for: The Way of Kings').closest('.fixed') as HTMLElement;
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when X button is clicked', async () => {
    vi.mocked(api.search).mockResolvedValue([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    await user.click(screen.getByLabelText('Close modal'));

    expect(onClose).toHaveBeenCalled();
  });
});
