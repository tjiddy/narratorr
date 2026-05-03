import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import type { SearchResult } from '@/lib/api';
import { createMockBook } from '@/__tests__/factories';
import { queryKeys } from '@/lib/queryKeys';

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      const message = (body as { error?: string })?.error || (body as { message?: string })?.message || `HTTP ${status}`;
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      searchBooks: vi.fn(),
      searchGrab: vi.fn(),
      addToBlacklist: vi.fn(),
      cancelSearchIndexer: vi.fn().mockResolvedValue({ cancelled: true }),
      getAuthConfig: vi.fn().mockResolvedValue({ apiKey: 'test-key' }),
      getSettings: vi.fn().mockResolvedValue({ metadata: { languages: [] } }),
    },
    // Override formatBytes with a GB-only formatter that existing assertions depend on.
    formatBytes: (bytes?: number) => {
      if (!bytes) return '0 B';
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    },
    // Override ApiError with a hoisted class so `instanceof ApiError` checks in the
    // component match this test-local class (the real class is bundled separately).
    ApiError: MockApiError,
  };
});

// Mock useSearchStream — existing tests provide results via mockStreamState
const mockStreamActions = {
  start: vi.fn(),
  cancelIndexer: vi.fn(),
  showResults: vi.fn(),
  reset: vi.fn(),
};

let mockStreamState: {
  phase: 'idle' | 'searching' | 'results';
  sessionId: string | null;
  indexers: Array<{ id: number; name: string; status: string; resultCount?: number; error?: string }>;
  results: { results: SearchResult[]; durationUnknown: boolean; unsupportedResults: { count: number; titles: string[] } } | null;
  error: string | null;
  hasResults: boolean;
  authReady: boolean;
} = {
  phase: 'idle',
  sessionId: null,
  indexers: [],
  results: null,
  error: null,
  hasResults: false,
  authReady: true,
};

vi.mock('@/hooks/useSearchStream', () => ({
  useSearchStream: () => ({ state: mockStreamState, actions: mockStreamActions }),
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
    indexerId: 3,
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


/** Helper: set stream state to Phase 2 (results) with given data */
function setStreamResults(results: SearchResult[], unsupported?: { count: number; titles: string[] }, durationUnknown = false) {
  mockStreamState = {
    phase: 'results',
    sessionId: 'test-session',
    indexers: [],
    results: {
      results,
      durationUnknown,
      unsupportedResults: unsupported ?? { count: 0, titles: [] },
    },
    error: null,
    hasResults: results.length > 0,
    authReady: true,
  };
}

/** Helper: set stream state to Phase 1 (searching) */
function setStreamSearching(indexers: Array<{ id: number; name: string; status: string; resultCount?: number; error?: string }> = []) {
  mockStreamState = {
    phase: 'searching',
    sessionId: 'test-session',
    indexers,
    results: null,
    error: null,
    hasResults: indexers.some(i => i.status === 'complete' && (i.resultCount ?? 0) > 0),
    authReady: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStreamState = {
    phase: 'idle',
    sessionId: null,
    indexers: [],
    results: null,
    error: null,
    hasResults: false,
    authReady: true,
  };
});

describe('SearchReleasesModal', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <SearchReleasesModal isOpen={false} book={mockBook} onClose={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('shows book title and author in header', async () => {
    setStreamResults(mockResults);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    expect(screen.getByText('by Brandon Sanderson')).toBeInTheDocument();
  });

  it('auto-starts streaming search when opened', async () => {
    // Start with idle phase (default from beforeEach) — authReady is true
    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(mockStreamActions.start).toHaveBeenCalled();
    });
  });

  it('shows loading state then results', async () => {
    setStreamResults(mockResults);

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
    setStreamResults([]);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('No releases found')).toBeInTheDocument();
    });
  });

  it('grab passes bookId and calls onClose on success', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.searchGrab).mockResolvedValue({
      id: 1,
      title: 'The Way of Kings [Unabridged]',
      protocol: 'torrent',
      status: 'queued' as const,
      progress: 0,
      addedAt: '2024-01-01T00:00:00Z',
      indexerName: null,
      seeders: null,
      completedAt: null,
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
    await user.click(grabButtons[0]!);

    await waitFor(() => {
      expect(api.searchGrab).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(vi.mocked(api.searchGrab).mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings [Unabridged]',
          bookId: 1,
          indexerId: 3,
        }),
      );
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Download started! Check the Activity page.');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('does not call onClose when backdrop is clicked (closeOnBackdropClick={false})', async () => {
    setStreamResults([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    await user.click(screen.getByTestId('modal-backdrop'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', async () => {
    setStreamResults([]);
    const onClose = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
    );

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows protocol badges on results', async () => {
    const mixedResults: SearchResult[] = [
      { ...mockResults[0]!, protocol: 'torrent' },
      { ...mockResults[1]!, protocol: 'usenet' },
    ];
    setStreamResults(mixedResults);

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
    setStreamResults([]);
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

  describe('replacement confirmation flow', () => {
    it('shows ConfirmModal instead of error toast when grab returns 409 ACTIVE_DOWNLOAD_EXISTS', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('releases modal remains visible behind the confirmation modal', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });
      // Releases modal content still present
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    });

    it('confirming replacement calls searchGrab with replaceExisting: true and same release params', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }))
        .mockResolvedValueOnce({
          id: 2,
          title: 'The Way of Kings [Unabridged]',
          protocol: 'torrent',
          status: 'queued' as const,
          progress: 0,
          addedAt: '2024-01-01T00:00:00Z',
          indexerName: null,
          seeders: null,
          completedAt: null,
        });
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // Click confirm
      await user.click(screen.getByRole('button', { name: /replace/i }));

      await waitFor(() => {
        const lastCallArgs = vi.mocked(api.searchGrab).mock.calls.at(-1)![0];
        expect(lastCallArgs).toEqual(expect.objectContaining({
          downloadUrl: 'magnet:?xt=urn:btih:abc123',
          title: 'The Way of Kings [Unabridged]',
          bookId: 1,
          indexerId: 3,
          replaceExisting: true,
        }));
      });
    });

    it('both modals close and queue invalidates on replacement success', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }))
        .mockResolvedValueOnce({
          id: 2,
          title: 'The Way of Kings [Unabridged]',
          protocol: 'torrent',
          status: 'queued' as const,
          progress: 0,
          addedAt: '2024-01-01T00:00:00Z',
          indexerName: null,
          seeders: null,
          completedAt: null,
        });
      const onClose = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /replace/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Download started! Check the Activity page.');
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('cancelling confirmation modal closes it and leaves releases modal open', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const onClose = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      });
      // Releases modal still open
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('confirmed retry failure closes the confirm modal, keeps releases modal open, and shows an error toast', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }))
        .mockRejectedValue(new MockApiError(500, { error: 'Client unavailable' }));
      const onClose = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /replace/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to grab: Client unavailable');
      });
      expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('shows error toast for non-409 grab failures (not treated as replacement)', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(500, { error: 'Internal server error' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to grab: Internal server error');
      });
      expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
    });
  });

  describe('guid forwarding in grab calls', () => {
    it('handleGrab sends guid from search result in api.searchGrab call', async () => {
      const resultsWithGuid: SearchResult[] = [
        {
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          protocol: 'torrent',
          guid: '720129',
          downloadUrl: 'magnet:?xt=urn:btih:xyz789',
          size: 3 * 1024 * 1024 * 1024,
          seeders: 15,
          indexer: 'MyAnonamouse',
          indexerId: 5,
        },
      ];
      setStreamResults(resultsWithGuid);
      vi.mocked(api.searchGrab).mockResolvedValue({
        id: 1,
        title: 'Project Hail Mary',
        protocol: 'torrent',
        status: 'queued' as const,
        progress: 0,
        addedAt: '2024-01-01T00:00:00Z',
        indexerName: null,
        seeders: null,
        completedAt: null,
      });
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Project Hail Mary');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        const callArgs = vi.mocked(api.searchGrab).mock.calls[0]![0];
        expect(callArgs).toEqual(expect.objectContaining({ guid: '720129' }));
      });
    });

    it('handleGrab sends guid undefined when search result has no guid', async () => {
      setStreamResults(mockResults); // mockResults have no guid
      vi.mocked(api.searchGrab).mockResolvedValue({
        id: 1,
        title: 'The Way of Kings [Unabridged]',
        protocol: 'torrent',
        status: 'queued' as const,
        progress: 0,
        addedAt: '2024-01-01T00:00:00Z',
        indexerName: null,
        seeders: null,
        completedAt: null,
      });
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        const callArgs = vi.mocked(api.searchGrab).mock.calls[0]![0];
        expect(callArgs).toEqual(expect.objectContaining({ guid: undefined }));
      });
    });

    it('on 409 replace confirmation, the retry api.searchGrab call includes the original guid', async () => {
      const resultsWithGuid: SearchResult[] = [
        {
          title: 'Project Hail Mary',
          author: 'Andy Weir',
          protocol: 'torrent',
          guid: '720129',
          downloadUrl: 'magnet:?xt=urn:btih:xyz789',
          size: 3 * 1024 * 1024 * 1024,
          seeders: 15,
          indexer: 'MyAnonamouse',
          indexerId: 5,
        },
      ];
      setStreamResults(resultsWithGuid);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }))
        .mockResolvedValueOnce({
          id: 2,
          title: 'Project Hail Mary',
          protocol: 'torrent',
          status: 'queued' as const,
          progress: 0,
          addedAt: '2024-01-01T00:00:00Z',
          indexerName: null,
          seeders: null,
          completedAt: null,
        });
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Project Hail Mary');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /replace/i }));

      await waitFor(() => {
        const lastCallArgs = vi.mocked(api.searchGrab).mock.calls.at(-1)![0];
        expect(lastCallArgs).toEqual(expect.objectContaining({
          guid: '720129',
          replaceExisting: true,
        }));
      });
    });
  });

  it('shows error toast when grab fails', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.searchGrab).mockRejectedValue(new Error('Download client unavailable'));
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    const grabButtons = screen.getAllByText('Grab');
    await user.click(grabButtons[0]!);

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
    setStreamResults(resultsWithoutUrl);

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
    setStreamResults(resultsWithLongTitle);

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
      setStreamResults([lowerQualityResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('Lower quality')).toBeInTheDocument();
      });
    });

    it('does not show warning for higher quality release on imported book', async () => {
      setStreamResults([higherQualityResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await screen.findByText('High Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });

    it('does not show quality comparison for non-imported book', async () => {
      setStreamResults([lowerQualityResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Low Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });

    it('warning tooltip explains existing quality is better', async () => {
      setStreamResults([lowerQualityResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByTitle('Your copy is likely better quality')).toBeInTheDocument();
      });
    });

    it('warning does not disable grab button', async () => {
      setStreamResults([lowerQualityResult]);

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
      setStreamResults([lowerQualityResult]);

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
      setStreamResults([lowerQualityResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={importedNoDuration} onClose={vi.fn()} />,
      );

      await screen.findByText('Low Quality Release');
      await waitFor(() => {
        expect(screen.queryByText('Lower quality')).not.toBeInTheDocument();
      });
    });
  });

  it('disables blacklist button when both infoHash and guid are falsy', async () => {
    const resultsWithoutIdentifiers: SearchResult[] = [
      {
        title: 'No Identifier Release',
        author: 'Author',
        protocol: 'usenet',
        infoHash: '',
        downloadUrl: 'https://indexer.example/nzb/123',
        size: 1024,
        seeders: 0,
        indexer: 'TestIndexer',
      },
    ];
    setStreamResults(resultsWithoutIdentifiers);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('No Identifier Release');

    await waitFor(() => {
      const blacklistButton = screen.getByText('Blacklist').closest('button');
      expect(blacklistButton).toBeDisabled();
    });
  });

  it('enables blacklist button when guid is present but infoHash is missing', async () => {
    const resultsWithGuidOnly: SearchResult[] = [
      {
        title: 'GUID Only Release',
        author: 'Author',
        protocol: 'usenet',
        infoHash: '',
        guid: 'https://indexer.example/details/abc123',
        downloadUrl: 'https://indexer.example/nzb/123',
        size: 1024,
        seeders: 0,
        indexer: 'TestIndexer',
      },
    ];
    setStreamResults(resultsWithGuidOnly);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('GUID Only Release');

    await waitFor(() => {
      const blacklistButton = screen.getByText('Blacklist').closest('button');
      expect(blacklistButton).not.toBeDisabled();
    });
  });

  it('blacklists a search result with reason: other and shows success toast', async () => {
    setStreamResults(mockResults);
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
    await user.click(blacklistButtons[0]!);

    await waitFor(() => {
      expect(api.addToBlacklist).toHaveBeenCalledWith(
        {
          infoHash: 'abc123',
          guid: undefined,
          title: 'The Way of Kings [Unabridged]',
          bookId: mockBook.id,
          reason: 'other',
        },
        expect.anything(), // TanStack Query mutation context
      );
      expect(toast.success).toHaveBeenCalledWith('Release blacklisted');
    });
  });

  it('blacklists by guid when infoHash is missing', async () => {
    const guidResult: SearchResult[] = [
      {
        title: 'GUID Blacklist Test',
        author: 'Author',
        protocol: 'usenet',
        infoHash: '',
        guid: 'https://indexer.example/details/guid789',
        downloadUrl: 'https://indexer.example/nzb/456',
        size: 1024,
        seeders: 0,
        indexer: 'TestIndexer',
      },
    ];
    setStreamResults(guidResult);
    vi.mocked(api.addToBlacklist).mockResolvedValue({
      id: 2,
      guid: 'https://indexer.example/details/guid789',
      title: 'GUID Blacklist Test',
      reason: 'other',
      blacklistType: 'permanent',
      blacklistedAt: '2026-03-15T00:00:00Z',
    });
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('GUID Blacklist Test');

    await user.click(screen.getByText('Blacklist'));

    await waitFor(() => {
      expect(api.addToBlacklist).toHaveBeenCalledWith(
        {
          infoHash: undefined,
          guid: 'https://indexer.example/details/guid789',
          title: 'GUID Blacklist Test',
          bookId: mockBook.id,
          reason: 'other',
        },
        expect.anything(),
      );
    });
  });

  it('shows error toast when blacklist fails', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.addToBlacklist).mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    const blacklistButtons = screen.getAllByText('Blacklist');
    await user.click(blacklistButtons[0]!);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to blacklist: Server error');
    });
  });

  it('Grab, Blacklist, and unsupported-toggle buttons have explicit type="button"', async () => {
    setStreamResults(mockResults, { count: 1, titles: ['Part "1" of "2"'] });

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');

    screen.getAllByText('Grab').forEach((el) => {
      expect(el.closest('button')).toHaveAttribute('type', 'button');
    });
    screen.getAllByText('Blacklist').forEach((el) => {
      expect(el.closest('button')).toHaveAttribute('type', 'button');
    });
    const toggleBtn = screen.getByText(/unsupported format/i).closest('button');
    expect(toggleBtn).toHaveAttribute('type', 'button');
  });

  it('refresh button is disabled while searching', () => {
    setStreamSearching([{ id: 1, name: 'ABB', status: 'pending' }]);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    expect(screen.getByLabelText('Refresh results')).toBeDisabled();
  });

  it('refresh button triggers reset and restart when clicked', async () => {
    setStreamResults(mockResults);
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    vi.clearAllMocks();
    await user.click(screen.getByLabelText('Refresh results'));

    expect(mockStreamActions.reset).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(mockStreamActions.start).toHaveBeenCalledOnce();
    });
  });

  it('shows narrator line in header when narrators exist', () => {
    setStreamResults(mockResults);
    const bookWithNarrator = createMockBook({
      narrators: [
        { id: 1, name: 'Michael Kramer', slug: 'michael-kramer' },
        { id: 2, name: 'Kate Reading', slug: 'kate-reading' },
      ],
    });

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={bookWithNarrator} onClose={vi.fn()} />,
    );

    expect(screen.getByText('Narrated by Michael Kramer, Kate Reading')).toBeInTheDocument();
  });

  it('shows current quality in header when audio size and duration are present', () => {
    setStreamResults(mockResults);
    const bookWithAudio = createMockBook({
      audioTotalSize: 1500 * 1024 * 1024,
      audioDuration: 52320,
    });

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={bookWithAudio} onClose={vi.fn()} />,
    );

    expect(screen.getByText(/Current quality .+ MB\/hr/)).toBeInTheDocument();
  });

  it('hides current quality in header when audio size is zero', () => {
    setStreamResults(mockResults);
    const bookNoAudio = createMockBook({
      audioTotalSize: 0,
      audioDuration: 0,
    });

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={bookNoAudio} onClose={vi.fn()} />,
    );

    expect(screen.queryByText(/Current quality/)).not.toBeInTheDocument();
  });

  it('grab buttons are all disabled while a grab mutation is pending', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.searchGrab).mockReturnValue(new Promise(() => {})); // never resolves
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');
    const grabButtons = screen.getAllByText('Grab');
    await user.click(grabButtons[0]!);

    await waitFor(() => {
      screen.getAllByText('Grab').forEach((btn) => {
        expect(btn.closest('button')).toBeDisabled();
      });
    });
  });

  it('blacklist buttons are all disabled while a blacklist mutation is pending', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.addToBlacklist).mockReturnValue(new Promise(() => {})); // never resolves
    const user = userEvent.setup();

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await screen.findByText('The Way of Kings [Unabridged]');
    const blacklistButtons = screen.getAllByText('Blacklist');
    await user.click(blacklistButtons[0]!);

    await waitFor(() => {
      screen.getAllByText('Blacklist').forEach((btn) => {
        expect(btn.closest('button')).toBeDisabled();
      });
    });
  });

  it('invalidates books and activity queries on successful grab', async () => {
    setStreamResults(mockResults);
    vi.mocked(api.searchGrab).mockResolvedValue({
      id: 1,
      title: 'The Way of Kings [Unabridged]',
      protocol: 'torrent',
      status: 'queued' as const,
      progress: 0,
      addedAt: '2024-01-01T00:00:00Z',
      indexerName: null,
      seeders: null,
      completedAt: null,
    });
    const user = userEvent.setup();

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('The Way of Kings [Unabridged]');
    await user.click(screen.getAllByText('Grab')[0]!);

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
    });
  });
});

describe('SearchReleasesModal duration unknown', () => {
  it('shows duration unknown banner when durationUnknown is true', async () => {
    setStreamResults(mockResults, undefined, true);

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
    setStreamResults(mockResults);

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
    setStreamResults(mockResults, { count: 3, titles: ['Book "1" of "3"', 'Book "2" of "3"', 'Book "3" of "3"'] });

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
    setStreamResults(mockResults);

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
    setStreamResults([], { count: 2, titles: unsupportedTitles });
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
      expect(screen.getByText(unsupportedTitles[0]!)).toBeInTheDocument();
      expect(screen.getByText(unsupportedTitles[1]!)).toBeInTheDocument();
    });
  });

  it('shows unsupported section alongside normal results', async () => {
    setStreamResults(mockResults, { count: 5, titles: ['Ch1', 'Ch2', 'Ch3', 'Ch4', 'Ch5'] });

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
      setStreamResults(usenetResults);

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
      setStreamResults(dupeResults);

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
      setStreamResults([{ ...baseResult, size: -1 }]);

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // The mock formatBytes for -1 would produce "-0.0 GB"; with the guard it must not render
      expect(screen.queryByText('-0.0 GB')).not.toBeInTheDocument();
    });

    it('hides size field when result.size is 0', async () => {
      setStreamResults([{ ...baseResult, size: 0 }]);

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // size=0 should be hidden; the mock returns '0 B' for falsy values but guard should prevent render
      expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    });

    it('hides size field when result.size is null', async () => {
      setStreamResults([{ ...baseResult, size: null as unknown as number }]);

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      expect(screen.queryByText('0 B')).not.toBeInTheDocument();
    });

    it('shows size field when result.size is a valid positive number', async () => {
      const size = 500 * 1024 * 1024;
      setStreamResults([{ ...baseResult, size }]);

      renderWithProviders(<SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('Test Book')).toBeInTheDocument();
      });

      // mock formatBytes: (500*1024*1024 / 1024^3).toFixed(1) = "0.5 GB"
      expect(screen.getByText('0.5 GB')).toBeInTheDocument();
    });
  });

  describe('nested ConfirmModal stacking', () => {
    it('inner ConfirmModal is interactive and visible while SearchReleasesModal is open', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      // ConfirmModal appears above SearchReleasesModal
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // SearchReleasesModal content is still present
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();

      // ConfirmModal Cancel button is interactive
      await user.click(screen.getByText('Cancel'));

      // After cancel, ConfirmModal is dismissed but SearchReleasesModal remains
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      });
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    });

    it('clicking ConfirmModal backdrop closes only the inner ConfirmModal, not SearchReleasesModal', async () => {
      setStreamResults(mockResults);
      vi.mocked(api.searchGrab).mockRejectedValue(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const onClose = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('The Way of Kings [Unabridged]');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // Two backdrops: SearchReleasesModal's and ConfirmModal's (ConfirmModal is second in DOM)
      const backdrops = screen.getAllByTestId('modal-backdrop');
      expect(backdrops).toHaveLength(2);
      await user.click(backdrops[1]!);

      // ConfirmModal closes
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      });
      // SearchReleasesModal's onClose was NOT called
      expect(onClose).not.toHaveBeenCalled();
      // SearchReleasesModal remains open
      expect(screen.getByText('Releases for: The Way of Kings')).toBeInTheDocument();
    });
  });
});

describe('ReleaseCard', () => {
  it('renders without narrator field when result has no narrator', async () => {
    const withNarrator: SearchResult = {
      title: 'Book With Narrator',
      author: 'Author A',
      narrator: 'Test Narrator Name',
      protocol: 'torrent',
      infoHash: 'wn999',
      downloadUrl: 'magnet:?xt=urn:btih:wn999',
      size: 1024,
      seeders: 1,
      indexer: 'Test',
    };
    const withoutNarrator: SearchResult = {
      title: 'Book Without Narrator',
      author: 'Author B',
      protocol: 'torrent',
      infoHash: 'wo999',
      downloadUrl: 'magnet:?xt=urn:btih:wo999',
      size: 1024,
      seeders: 1,
      indexer: 'Test',
    };
    setStreamResults([withNarrator, withoutNarrator]);

    renderWithProviders(
      <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Book With Narrator')).toBeInTheDocument();
      expect(screen.getByText('Book Without Narrator')).toBeInTheDocument();
    });

    // Narrator name appears exactly once — only for the first card
    expect(screen.getByText('Test Narrator Name')).toBeInTheDocument();
    expect(screen.queryAllByText('Test Narrator Name')).toHaveLength(1);
    // Both cards render without crash (narrator-absent card still renders action buttons)
    expect(screen.getAllByRole('button', { name: /grab/i })).toHaveLength(2);
  });
});

describe('SearchReleasesModal — streaming search (Phase 1/Phase 2)', () => {
  describe('Phase 1 — Indexer status view', () => {
    it('renders indexer list with pending status indicators when stream starts', () => {
      setStreamSearching([
        { id: 1, name: 'AudioBookBay', status: 'pending' },
        { id: 2, name: 'MAM', status: 'pending' },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('AudioBookBay')).toBeInTheDocument();
      expect(screen.getByText('MAM')).toBeInTheDocument();
      expect(screen.getAllByText('Searching...')).toHaveLength(2);
    });

    it('shows result count for completed indexer', () => {
      setStreamSearching([
        { id: 1, name: 'AudioBookBay', status: 'complete', resultCount: 5 },
        { id: 2, name: 'MAM', status: 'pending' },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('5 results')).toBeInTheDocument();
      expect(screen.getByText('Searching...')).toBeInTheDocument();
    });

    it('shows error message for failed indexer', () => {
      setStreamSearching([
        { id: 1, name: 'AudioBookBay', status: 'error', error: 'FlareSolverr timed out' },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('FlareSolverr timed out')).toBeInTheDocument();
    });

    it('cancel button hidden for already-completed indexers', () => {
      setStreamSearching([
        { id: 1, name: 'AudioBookBay', status: 'complete', resultCount: 3 },
        { id: 2, name: 'MAM', status: 'pending' },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      // Only one Cancel button (for the pending indexer)
      const cancelButtons = screen.getAllByText('Cancel');
      expect(cancelButtons).toHaveLength(1);
    });

    it('calls cancelIndexer when cancel button is clicked', async () => {
      setStreamSearching([
        { id: 1, name: 'AudioBookBay', status: 'pending' },
      ]);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await user.click(screen.getByText('Cancel'));
      expect(mockStreamActions.cancelIndexer).toHaveBeenCalledWith(1);
    });
  });

  describe('Show results button', () => {
    it('appears when hasResults is true', () => {
      mockStreamState = {
        phase: 'searching',
        sessionId: 'test',
        indexers: [{ id: 1, name: 'ABB', status: 'complete', resultCount: 3 }],
        results: null,
        error: null,
        hasResults: true,
        authReady: true,
      };

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('Show results')).toBeInTheDocument();
    });

    it('does not appear when hasResults is false', () => {
      setStreamSearching([
        { id: 1, name: 'ABB', status: 'complete', resultCount: 0 },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.queryByText('Show results')).not.toBeInTheDocument();
    });

    it('calls showResults when clicked', async () => {
      mockStreamState = {
        phase: 'searching',
        sessionId: 'test',
        indexers: [{ id: 1, name: 'ABB', status: 'complete', resultCount: 3 }],
        results: null,
        error: null,
        hasResults: true,
        authReady: true,
      };
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await user.click(screen.getByText('Show results'));
      expect(mockStreamActions.showResults).toHaveBeenCalled();
    });
  });

  describe('Phase 2 — Results view', () => {
    it('shows loading state when phase is results but results data has not arrived yet', () => {
      mockStreamState = {
        phase: 'results',
        sessionId: 'test',
        indexers: [],
        results: null,
        error: null,
        hasResults: false,
        authReady: true,
      };

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('Finalizing results...')).toBeInTheDocument();
    });

    it('shows empty state when results are empty', () => {
      setStreamResults([]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('No releases found')).toBeInTheDocument();
    });

    it('renders duration-unknown banner when durationUnknown is true', () => {
      setStreamResults(mockResults, undefined, true);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText(/duration unknown/i)).toBeInTheDocument();
    });

    it('renders unsupported results section when count > 0', () => {
      setStreamResults(mockResults, { count: 2, titles: ['Part 1', 'Part 2'] });

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('Found, but unsupported format (2)')).toBeInTheDocument();
    });
  });

  describe('error handling', () => {
    it('shows error state on SSE connection failure', () => {
      mockStreamState = {
        phase: 'idle',
        sessionId: null,
        indexers: [],
        results: null,
        error: 'Search connection failed',
        hasResults: false,
        authReady: true,
      };

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('Search failed: Search connection failed')).toBeInTheDocument();
    });

    it('shows retry button after connection error', async () => {
      mockStreamState = {
        phase: 'idle',
        sessionId: null,
        indexers: [],
        results: null,
        error: 'Search connection failed',
        hasResults: false,
        authReady: true,
      };
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await user.click(screen.getByText('Retry'));
      expect(mockStreamActions.start).toHaveBeenCalled();
    });
  });

  describe('AC1 — modal overflow', () => {
    it('renders dialog wrapper with flex constraints that propagate max-height to scrollable body', () => {
      setStreamResults(mockResults);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      const dialog = screen.getByRole('dialog');
      // The dialog wrapper must be a flex column with min-h-0 to propagate max-height
      // to the scrollable body. Without min-h-0, flex children default to min-height: auto
      // and overflow past the parent's max-height.
      expect(dialog.className).toMatch(/flex/);
      expect(dialog.className).toMatch(/flex-col/);
      expect(dialog.className).toMatch(/min-h-0/);
    });
  });

  describe('AC2 — finalizing timeout error state', () => {
    it('renders error state with retry button when finalizing times out', () => {
      mockStreamState = {
        phase: 'idle',
        sessionId: null,
        indexers: [],
        results: null,
        error: 'Search timed out waiting for results',
        hasResults: false,
        authReady: true,
      };

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText(/Search timed out waiting for results/)).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('renders normal results when search-complete arrives in time', () => {
      setStreamResults(mockResults);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      expect(screen.getByText('The Way of Kings [Unabridged]')).toBeInTheDocument();
      expect(screen.queryByText(/timed out/)).not.toBeInTheDocument();
    });
  });

  describe('language pill data flow', () => {
    it('shows language pill when result has language metadata', async () => {
      setStreamResults([
        {
          ...mockResults[0]!,
          language: 'English',
        },
      ]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('english')).toBeInTheDocument();
      });
    });
  });

  describe('#421 — "In library" badge wiring', () => {
    it('renders "In library" badge on result card when book lastGrabGuid matches result guid', async () => {
      setStreamResults([
        { ...mockResults[0]!, guid: 'grabbed-guid' },
      ]);
      const bookWithGrab = createMockBook({ lastGrabGuid: 'grabbed-guid', lastGrabInfoHash: null });

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={bookWithGrab} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText('In library')).toBeInTheDocument();
      });
    });

    it('no "In library" badge on any result card when book has no grab identifiers (both null)', async () => {
      setStreamResults(mockResults);
      const bookNoGrab = createMockBook({ lastGrabGuid: null, lastGrabInfoHash: null });

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={bookNoGrab} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText(mockResults[0]!.title)).toBeInTheDocument();
      });
      expect(screen.queryByText('In library')).not.toBeInTheDocument();
    });

    it('renders "In library" badge only on the matching result, not on others', async () => {
      setStreamResults([
        { ...mockResults[0]!, guid: 'match-guid' },
        { ...mockResults[1]!, guid: 'other-guid' },
      ]);
      const bookWithGrab = createMockBook({ lastGrabGuid: 'match-guid', lastGrabInfoHash: null });

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={bookWithGrab} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText(mockResults[0]!.title)).toBeInTheDocument();
      });
      const badges = screen.getAllByText('In library');
      expect(badges).toHaveLength(1);
    });

    it('renders "In library" badge on result card when book lastGrabInfoHash matches result infoHash (torrent path)', async () => {
      const { guid: _guid0, ...result0NoGuid } = mockResults[0]!;
      // PHASE 1 SKIPPED — needs human review
      const { guid: _guid1, ...result1NoGuid } = mockResults[1]!;
      setStreamResults([
        { ...result0NoGuid, infoHash: 'abc123' },
        { ...result1NoGuid, infoHash: 'other-hash' },
      ]);
      const bookWithHash = createMockBook({ lastGrabGuid: null, lastGrabInfoHash: 'abc123' });

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={bookWithHash} onClose={vi.fn()} />,
      );

      await waitFor(() => {
        expect(screen.getByText(mockResults[0]!.title)).toBeInTheDocument();
      });
      const badges = screen.getAllByText('In library');
      expect(badges).toHaveLength(1);
    });
  });
});

// =============================================================================
// #412 — Grab payload contract tests (derived type, no cherry-pick)
// =============================================================================

const mockDownloadResponse = {
  id: 1,
  title: 'Test',
  protocol: 'torrent' as const,
  status: 'queued' as const,
  progress: 0,
  addedAt: '2024-01-01T00:00:00Z',
  indexerName: null,
  seeders: null,
  completedAt: null,
};

/** SearchResult with ALL grab-contract fields populated, plus non-contract fields. */
const fullResult: SearchResult = {
  title: 'Full Result',
  rawTitle: 'full.result.mp3',
  author: 'Author Name',
  narrator: 'Narrator Name',
  protocol: 'torrent',
  downloadUrl: 'magnet:?xt=urn:btih:full123',
  infoHash: 'full123',
  size: 3 * 1024 * 1024 * 1024,
  seeders: 15,
  leechers: 3,
  grabs: 100,
  language: 'English',
  newsgroup: 'alt.binaries.audiobooks',
  indexer: 'TestIndexer',
  indexerId: 7,
  indexerPriority: 1,
  detailsUrl: 'https://example.com/details/123',
  guid: 'guid-abc-123',
  coverUrl: 'https://example.com/cover.jpg',
  matchScore: 95,
  isFreeleech: true,
  isVipOnly: false,
};

/** The exact grab-contract keys that should appear in the payload (from grabSchema). */
const GRAB_CONTRACT_KEYS = ['downloadUrl', 'title', 'protocol', 'indexerId', 'size', 'seeders', 'guid'];

/** Non-contract SearchResult keys that must NOT appear. */
const NON_CONTRACT_KEYS = [
  'rawTitle', 'author', 'narrator', 'infoHash', 'leechers', 'grabs',
  'language', 'newsgroup', 'indexer', 'indexerPriority', 'detailsUrl',
  'coverUrl', 'matchScore', 'isFreeleech', 'isVipOnly',
];

describe('SearchReleasesModal — grab payload contract (#412)', () => {
  describe('grab happy path — exact payload', () => {
    it('torrent grab sends exactly the grab-contract fields plus bookId (no extra SearchResult fields)', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];

      // Verify all grab-contract fields are present with correct values
      expect(payload).toEqual({
        downloadUrl: 'magnet:?xt=urn:btih:full123',
        title: 'Full Result',
        protocol: 'torrent',
        bookId: mockBook.id,
        indexerId: 7,
        size: 3 * 1024 * 1024 * 1024,
        seeders: 15,
        guid: 'guid-abc-123',
      });

      // Verify non-contract fields are absent
      for (const key of NON_CONTRACT_KEYS) {
        expect(payload).not.toHaveProperty(key);
      }
    });

    it('usenet grab sends protocol: usenet with the same grab-contract fields', async () => {
      const usenetResult: SearchResult = {
        ...fullResult,
        protocol: 'usenet',
        downloadUrl: 'https://nzb.example.com/dl/123',
      };
      setStreamResults([usenetResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];
      expect(payload.protocol).toBe('usenet');
      expect(payload.downloadUrl).toBe('https://nzb.example.com/dl/123');

      // Non-contract fields still excluded
      for (const key of NON_CONTRACT_KEYS) {
        expect(payload).not.toHaveProperty(key);
      }
    });

    it('successful grab shows success toast and does not leave stale pendingReplace state', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const onClose = vi.fn();
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Download started! Check the Activity page.');
        expect(onClose).toHaveBeenCalled();
      });

      // No confirm modal should be visible (no stale pendingReplace)
      expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
    });
  });

  describe('non-contract field exclusion', () => {
    it('non-grab-contract fields (rawTitle, author, coverUrl, matchScore, etc.) are NOT included in the mutation payload', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];
      const payloadKeys = Object.keys(payload);

      // Every key in payload should be a grab-contract key or bookId
      for (const key of payloadKeys) {
        expect([...GRAB_CONTRACT_KEYS, 'bookId', 'replaceExisting']).toContain(key);
      }
    });
  });

  describe('409 replace-confirm flow — derived type', () => {
    it('409 error captures grab-contract fields from the original mutation variables', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      // Confirm modal should appear (pendingReplace was captured)
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // No error toast — 409 is handled specially
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('confirming replace sends { ...pendingReplace, replaceExisting: true } with all grab-contract fields preserved', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }))
        .mockResolvedValueOnce(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /replace/i }));

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(2);
      });

      const retryPayload = vi.mocked(api.searchGrab).mock.calls[1]![0];

      // All original grab-contract fields preserved, plus replaceExisting
      expect(retryPayload).toEqual({
        downloadUrl: 'magnet:?xt=urn:btih:full123',
        title: 'Full Result',
        protocol: 'torrent',
        bookId: mockBook.id,
        indexerId: 7,
        size: 3 * 1024 * 1024 * 1024,
        seeders: 15,
        guid: 'guid-abc-123',
        replaceExisting: true,
      });
    });

    it('cancelling replace clears pendingReplace state without calling the API', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // Click cancel
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      });

      // Only the initial grab call, no retry
      expect(api.searchGrab).toHaveBeenCalledTimes(1);
    });
  });

  describe('field forwarding regression', () => {
    it('mock SearchResult with all grab-contract fields populated — mutation receives every field plus bookId', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];

      // Every SearchResult-sourced grab-contract field is present
      for (const key of GRAB_CONTRACT_KEYS) {
        expect(payload).toHaveProperty(key);
      }
      expect(payload).toHaveProperty('bookId', mockBook.id);
    });

    it('mock SearchResult with only required fields (title, protocol, downloadUrl) — mutation succeeds', async () => {
      const minimalResult: SearchResult = {
        title: 'Minimal Result',
        protocol: 'torrent',
        downloadUrl: 'magnet:?xt=urn:btih:minimal',
        indexer: 'TestIndexer',
      };
      setStreamResults([minimalResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Minimal Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];
      expect(payload.downloadUrl).toBe('magnet:?xt=urn:btih:minimal');
      expect(payload.title).toBe('Minimal Result');
      expect(payload.protocol).toBe('torrent');
      expect(payload.bookId).toBe(mockBook.id);
    });
  });

  describe('boundary / edge cases', () => {
    it('SearchResult with seeders: 0 (falsy but valid) — 0 is forwarded, not dropped', async () => {
      const zeroSeedersResult: SearchResult = {
        ...fullResult,
        seeders: 0,
      };
      setStreamResults([zeroSeedersResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];
      expect(payload.seeders).toBe(0);
    });

    it('SearchResult with size: 0 — 0 is forwarded, not dropped', async () => {
      const zeroSizeResult: SearchResult = {
        ...fullResult,
        size: 0,
      };
      setStreamResults([zeroSizeResult]);
      vi.mocked(api.searchGrab).mockResolvedValue(mockDownloadResponse);
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(api.searchGrab).toHaveBeenCalledTimes(1);
      });

      const payload = vi.mocked(api.searchGrab).mock.calls[0]![0];
      expect(payload.size).toBe(0);
    });
  });

  describe('error paths', () => {
    it('grab mutation error (non-409) shows error toast and does not set pendingReplace', async () => {
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to grab: Network error');
      });

      // No confirm modal (pendingReplace should be null)
      expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
    });
  });

  describe('ARIA attributes (#484)', () => {
    it('renders aria-labelledby linked to the heading id', () => {
      setStreamResults([]);
      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={vi.fn()} />,
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-labelledby', 'search-releases-modal-title');
      const heading = document.getElementById('search-releases-modal-title');
      expect(heading).toBeInTheDocument();
      expect(heading!.tagName).toBe('H3');
    });
  });

  describe('nested Escape isolation (#484)', () => {
    it('Escape while inner ConfirmModal is open does not close the outer modal', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      setStreamResults([fullResult]);
      vi.mocked(api.searchGrab)
        .mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS' }));

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('Full Result');
      await user.click(screen.getAllByText('Grab')[0]!);

      // Wait for confirm modal to appear
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /replace/i })).toBeInTheDocument();
      });

      // Press Escape — should close only the inner confirm modal, not the outer
      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /replace/i })).not.toBeInTheDocument();
      });
      // Outer modal should still be open
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape after inner ConfirmModal is closed closes the outer modal', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      setStreamResults([fullResult]);

      renderWithProviders(
        <SearchReleasesModal isOpen={true} book={mockBook} onClose={onClose} />,
      );

      await screen.findByText('Full Result');
      // No inner confirm modal open — pressing Escape should close the outer modal
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not call onClose when Escape is pressed while closed', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <SearchReleasesModal isOpen={false} book={mockBook} onClose={onClose} />,
      );
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
