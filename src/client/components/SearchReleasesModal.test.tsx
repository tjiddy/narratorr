import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import type { SearchResult, SearchResponse } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';

vi.mock('@/lib/api', () => ({
  api: {
    searchBooks: vi.fn(),
    searchGrab: vi.fn(),
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

const mockBook = createMockBook();

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

function searchResponse(results: SearchResult[], unsupported?: { count: number; titles: string[] }): SearchResponse {
  return {
    results,
    durationUnknown: false,
    unsupportedResults: unsupported ?? { count: 0, titles: [] },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SearchReleasesModal', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <SearchReleasesModal isOpen={false} book={mockBook} onClose={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows book title and author in header', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    expect(screen.getByText('by Brandon Sanderson')).toBeInTheDocument();
  });

  it('auto-searches with book title and author name', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(api.searchBooks).toHaveBeenCalledWith(
        'The Way of Kings Brandon Sanderson',
        { title: 'The Way of Kings', author: 'Brandon Sanderson', bookDuration: 3139200 },
      );
    });
  });

  it('shows loading state then results', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    // Wait for results
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('Way of Kings (Graphic Audio)')).toBeInTheDocument();
      expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
    });
  });

  it('shows empty state when no results', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([]));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('No releases found')).toBeInTheDocument();
    });
  });

  it('grab passes bookId and calls onClose on success', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));
    vi.mocked(api.searchGrab).mockResolvedValue({
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
      expect(api.searchGrab).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(vi.mocked(api.searchGrab).mock.calls[0][0]).toEqual(
        expect.objectContaining({
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings [Unabridged]',
          bookId: 1,
        }),
      );
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Download started! Check the Activity page.');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('calls onClose when backdrop is clicked', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([]));
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    // Click the backdrop (outermost overlay div)
    const backdrop = screen.getByText('Releases for: The Way of Kings').closest('.fixed') as HTMLElement;
    await user.click(backdrop);

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows protocol badges on results', async () => {
    const mixedResults: SearchResult[] = [
      { ...mockResults[0], protocol: 'torrent' },
      { ...mockResults[1], protocol: 'usenet' },
    ];
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mixedResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
    });

    await waitFor(() => {
      const badges = screen.getAllByTestId('protocol-badge');
      expect(badges).toHaveLength(2);
      expect(badges[0]).toHaveTextContent('Torrent');
      expect(badges[1]).toHaveTextContent('Usenet');
    });
  });

  it('calls onClose when X button is clicked', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([]));
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    await user.click(screen.getByLabelText('Close modal'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error toast when grab fails', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));
    vi.mocked(api.searchGrab).mockRejectedValue(new Error('Download client unavailable'));
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    const grabButtons = screen.getAllByText('Grab');
    await user.click(grabButtons[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to grab: Download client unavailable');
    });
  });

  it('disables grab button when downloadUrl is falsy', async () => {
    const resultsWithoutUrl: SearchResult[] = [
      {
        title: 'No URL Release',
        author: 'Author',
        protocol: 'torrent',
        infoHash: 'abc123',
        downloadUrl: '',
        size: 1024,
        seeders: 5,
        indexer: 'TestIndexer',
      },
    ];
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(resultsWithoutUrl));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('No URL Release');

    await waitFor(() => {
      const grabButton = screen.getByText('Grab').closest('button');
      expect(grabButton).toBeDisabled();
    });
  });

  it('renders grab button for results with long unbroken rawTitle', async () => {
    const longRawTitle = 'A'.repeat(150);
    const resultsWithLongTitle: SearchResult[] = [
      {
        title: 'Some Book Title',
        author: 'Author Name',
        rawTitle: longRawTitle,
        protocol: 'torrent',
        infoHash: 'long123',
        downloadUrl: 'magnet:?xt=urn:btih:long123',
        size: 2 * 1024 * 1024 * 1024,
        seeders: 10,
        indexer: 'TestIndexer',
      },
    ];
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(resultsWithLongTitle));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('Some Book Title');

    // Grab button is rendered and enabled despite long rawTitle
    await waitFor(() => {
      const grabButton = screen.getByText('Grab').closest('button');
      expect(grabButton).toBeInTheDocument();
      expect(grabButton).not.toBeDisabled();

      // rawTitle is rendered (truncated visually via CSS, but present in DOM)
      expect(screen.getByTitle(longRawTitle)).toBeInTheDocument();
    });
  });

  describe('quality comparison for imported books', () => {
    const importedBook = createMockBook({
      status: 'imported',
      path: '/audiobooks/existing',
      audioTotalSize: 500 * 1024 * 1024, // 500 MB
      audioDuration: 36000, // 10 hours
      // Quality: 500 MB / 10hr = 50 MB/hr (Fair)
    });

    const lowerQualityResult: SearchResult = {
      title: 'Low Quality Release',
      author: 'Author',
      protocol: 'torrent',
      infoHash: 'low123',
      downloadUrl: 'magnet:?xt=urn:btih:low123',
      size: 100 * 1024 * 1024, // 100 MB → 10 MB/hr (much lower than 50)
      seeders: 5,
      indexer: 'TestIndexer',
    };

    const higherQualityResult: SearchResult = {
      title: 'High Quality Release',
      author: 'Author',
      protocol: 'torrent',
      infoHash: 'high456',
      downloadUrl: 'magnet:?xt=urn:btih:high456',
      size: 2000 * 1024 * 1024, // 2000 MB → 200 MB/hr (much higher than 50)
      seeders: 10,
      indexer: 'TestIndexer',
    };

    it('shows warning indicator for lower quality release on imported book', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Lower quality')).toBeInTheDocument();
      });
    });

    it('does not show warning for higher quality release on imported book', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([higherQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await screen.findByText('High Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });

    it('does not show quality comparison for non-imported book', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Low Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });

    it('warning tooltip explains existing quality is better', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTitle('Your copy is likely better quality')).toBeInTheDocument();
      });
    });

    it('warning does not disable grab button', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Lower quality');
      await waitFor(() => {
        const grabButton = screen.getByText('Grab').closest('button');
        expect(grabButton).not.toBeDisabled();
      });
    });

    it('skips comparison when book has no size data', async () => {
      const importedNoSize = createMockBook({
        status: 'imported',
        path: '/audiobooks/existing',
        audioTotalSize: null,
        size: null,
        audioDuration: 36000,
      });
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedNoSize} onClose={vi.fn()} />,
      );

      await screen.findByText('Low Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });

    it('skips comparison when book has no duration data', async () => {
      const importedNoDuration = createMockBook({
        status: 'imported',
        path: '/audiobooks/existing',
        audioTotalSize: 500 * 1024 * 1024,
        audioDuration: null,
        duration: null,
      });
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([lowerQualityResult]));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedNoDuration} onClose={vi.fn()} />,
      );

      await screen.findByText('Low Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });
  });

  it('disables blacklist button when infoHash is falsy', async () => {
    const resultsWithoutHash: SearchResult[] = [
      {
        title: 'No Hash Release',
        author: 'Author',
        protocol: 'usenet',
        infoHash: '',
        downloadUrl: 'https://indexer.example/nzb/123',
        size: 1024,
        seeders: 0,
        indexer: 'TestIndexer',
      },
    ];
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(resultsWithoutHash));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('No Hash Release');

    await waitFor(() => {
      const blacklistButton = screen.getByText('Blacklist').closest('button');
      expect(blacklistButton).toBeDisabled();
    });
  });

  it('blacklists a search result with reason: other and shows success toast', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));
    vi.mocked(api.addToBlacklist).mockResolvedValue({
      id: 1,
      infoHash: 'abc123',
      title: 'The Way of Kings [Unabridged]',
      reason: 'other',
      blacklistType: 'permanent',
      blacklistedAt: '2026-03-15T00:00:00Z',
    });
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    const blacklistButtons = screen.getAllByText('Blacklist');
    await user.click(blacklistButtons[0]);

    await waitFor(() => {
      expect(api.addToBlacklist).toHaveBeenCalledWith(
        {
          infoHash: 'abc123',
          title: 'The Way of Kings [Unabridged]',
          bookId: mockBook.id,
          reason: 'other',
        },
        expect.anything(), // TanStack Query mutation context
      );
      expect(toast.success).toHaveBeenCalledWith('Release blacklisted');
    });
  });

  it('shows error toast when blacklist fails', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));
    vi.mocked(api.addToBlacklist).mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    const blacklistButtons = screen.getAllByText('Blacklist');
    await user.click(blacklistButtons[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to blacklist: Server error');
    });
  });
});

describe('SearchReleasesModal duration unknown', () => {
  it('shows duration unknown banner when durationUnknown is true', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue({
      results: mockResults,
      durationUnknown: true,
      unsupportedResults: { count: 0, titles: [] },
    });

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/duration unknown/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/quality filtering is disabled/i)).toBeInTheDocument();
    });
  });

  it('does not show duration unknown banner when durationUnknown is false', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByText(/duration unknown/i)).not.toBeInTheDocument();
    });
  });
});

describe('SearchReleasesModal unsupported results', () => {
  it('shows collapsed unsupported section when count > 0', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults, {
      count: 3,
      titles: ['Book "1" of "3"', 'Book "2" of "3"', 'Book "3" of "3"'],
    }));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Found, but unsupported format (3)')).toBeInTheDocument();
    });

    // Titles should not be visible before expanding
    await waitFor(() => {
      expect(screen.queryByText('Book "1" of "3"')).not.toBeInTheDocument();
    });
  });

  it('does not render unsupported section when count is 0', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByText(/unsupported format/i)).not.toBeInTheDocument();
    });
  });

  it('expands to show raw titles when clicked', async () => {
    const unsupportedTitles = ['hp02.Harry Potter "28" of "30" yEnc', 'hp02.Harry Potter "29" of "30" yEnc'];
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse([], {
      count: 2,
      titles: unsupportedTitles,
    }));
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Found, but unsupported format (2)')).toBeInTheDocument();
    });

    // Click to expand
    await user.click(screen.getByText('Found, but unsupported format (2)'));

    // Titles should now be visible
    await waitFor(() => {
      expect(screen.getByText(unsupportedTitles[0])).toBeInTheDocument();
      expect(screen.getByText(unsupportedTitles[1])).toBeInTheDocument();
    });
  });

  it('shows unsupported section alongside normal results', async () => {
    vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(mockResults, {
      count: 5,
      titles: ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5'],
    }));

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText('Found, but unsupported format (5)')).toBeInTheDocument();
    });
  });

  describe('stable keys', () => {
    it('renders two results without infoHash with different downloadUrl independently', async () => {
      const usenetResults: SearchResult[] = [
        {
          title: 'The Way of Kings',
          author: 'Brandon Sanderson',
          protocol: 'usenet',
          downloadUrl: 'https://nzb.example.com/dl1.nzb',
          size: 5 * 1024 * 1024 * 1024,
          indexer: 'NZBgeek',
        },
        {
          title: 'The Way of Kings',
          author: 'Brandon Sanderson',
          protocol: 'usenet',
          downloadUrl: 'https://nzb.example.com/dl2.nzb',
          size: 4 * 1024 * 1024 * 1024,
          indexer: 'NZBgeek',
        },
      ];
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(usenetResults));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
      });

      // Both results should render independently despite sharing title/author/indexer
      const grabButtons = screen.getAllByText('Grab');
      expect(grabButtons).toHaveLength(2);
    });

    it('renders true duplicate results without React duplicate-key warning', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const dupeResults: SearchResult[] = [
        {
          title: 'Same Title',
          author: 'Same Author',
          protocol: 'usenet',
          downloadUrl: 'https://nzb.example.com/same.nzb',
          size: 5 * 1024 * 1024 * 1024,
          indexer: 'NZBgeek',
        },
        {
          title: 'Same Title',
          author: 'Same Author',
          protocol: 'usenet',
          downloadUrl: 'https://nzb.example.com/same.nzb',
          size: 5 * 1024 * 1024 * 1024,
          indexer: 'NZBgeek',
        },
      ];
      vi.mocked(api.searchBooks).mockResolvedValue(searchResponse(dupeResults));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
      });

      const grabButtons = screen.getAllByText('Grab');
      expect(grabButtons).toHaveLength(2);
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('same key'), expect.anything(), expect.anything());
      spy.mockRestore();
    });
  });

  describe('ReleaseCard size display guard', () => {
    const baseResult: SearchResult = {
      title: 'Test Book',
      author: 'Test Author',
      protocol: 'torrent',
      infoHash: 'test123',
      downloadUrl: 'magnet:?xt=urn:btih:test123',
      seeders: 5,
      indexer: 'TestIndexer',
    };

    it('hides size field when result.size is -1 (negative sentinel)', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(
        searchResponse([{ ...baseResult, size: -1 }]),
      );

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // The mock formatBytes for -1 would produce "-0.0 GB"; with the guard it must not render
      expect(screen.queryByText('-0.0 GB')).not.toBeInTheDocument();
    });

    it('hides size field when result.size is 0', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(
        searchResponse([{ ...baseResult, size: 0 }]),
      );

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // size=0 should be hidden; the mock returns '0 B' for falsy values but guard should prevent render
      expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    });

    it('hides size field when result.size is null', async () => {
      vi.mocked(api.searchBooks).mockResolvedValue(
        searchResponse([{ ...baseResult, size: null as unknown as number }]),
      );

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    });

    it('shows size field when result.size is a valid positive number', async () => {
      const size = 500 * 1024 * 1024;
      vi.mocked(api.searchBooks).mockResolvedValue(
        searchResponse([{ ...baseResult, size }]),
      );

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // mock formatBytes: (500*1024*1024 / 1024^3).toFixed(1) = "0.5 GB"
      expect(screen.getByText('0.5 GB')).toBeInTheDocument();
    });
  });
});
