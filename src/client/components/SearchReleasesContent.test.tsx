import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchReleasesContent } from './SearchReleasesContent';
import { createMockBook } from '@/__tests__/factories';
import type { SearchResult } from '@/lib/api';
import type { SearchResponse } from '@/lib/api/search';
import type { IndexerState } from '@/hooks/useSearchStream';
import { searchDropReasonSchema } from '@shared/schemas/search-stream.js';
import { DROP_REASON_LABELS } from '@/lib/searchDropReasonCopy';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: { ...(actual as { api: object }).api },
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const mockBook = createMockBook();

const mockResult: SearchResult = {
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
};

type ContentProps = ComponentProps<typeof SearchReleasesContent>;

const defaultProps: ContentProps = {
  phase: 'idle',
  indexers: [],
  hasResults: false,
  error: null,
  searchResponse: null,
  resultKeys: [],
  book: mockBook,
  isGrabbing: false,
  isBlacklisting: false,
  onCancelIndexer: vi.fn(),
  onShowResults: vi.fn(),
  onRetry: vi.fn(),
  retryDisabled: false,
  onGrab: vi.fn(),
  onBlacklist: vi.fn(),
};

function renderContent(overrides: Partial<typeof defaultProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SearchReleasesContent {...defaultProps} {...overrides} />
    </QueryClientProvider>,
  );
}

describe('SearchReleasesContent', () => {
  describe('searching phase', () => {
    it('renders indexer status rows from indexers array', () => {
      const indexers: IndexerState[] = [
        { id: 1, name: 'ABB', status: 'pending' },
        { id: 2, name: 'MyAnonamouse', status: 'complete', resultCount: 5 },
      ];
      renderContent({ phase: 'searching', indexers });

      expect(screen.getByText('ABB')).toBeInTheDocument();
      expect(screen.getByText('MyAnonamouse')).toBeInTheDocument();
      expect(screen.getByText('Searching...')).toBeInTheDocument();
      expect(screen.getByText('5 results')).toBeInTheDocument();
    });

    it('shows connecting message when indexers array is empty', () => {
      renderContent({ phase: 'searching', indexers: [] });
      expect(screen.getByText('Connecting to indexers...')).toBeInTheDocument();
    });

    it('shows "Show results" button when hasResults is true', () => {
      renderContent({ phase: 'searching', hasResults: true });
      expect(screen.getByText('Show results')).toBeInTheDocument();
    });

    it('hides "Show results" button when hasResults is false', () => {
      renderContent({ phase: 'searching', hasResults: false });
      expect(screen.queryByText('Show results')).not.toBeInTheDocument();
    });

    it('calls onShowResults when "Show results" button clicked', async () => {
      const onShowResults = vi.fn();
      renderContent({ phase: 'searching', hasResults: true, onShowResults });
      await userEvent.click(screen.getByText('Show results'));
      expect(onShowResults).toHaveBeenCalledOnce();
    });

    it('calls onCancelIndexer with indexer id when cancel clicked', async () => {
      const onCancelIndexer = vi.fn();
      const indexers: IndexerState[] = [
        { id: 7, name: 'ABB', status: 'pending' },
      ];
      renderContent({ phase: 'searching', indexers, onCancelIndexer });
      await userEvent.click(screen.getByText('Cancel'));
      expect(onCancelIndexer).toHaveBeenCalledWith(7);
    });
  });

  describe('error phase', () => {
    it('shows error message when error is set and not searching/results', () => {
      renderContent({ phase: 'idle', error: 'Connection refused' });
      expect(screen.getByText('Search failed: Connection refused')).toBeInTheDocument();
    });

    it('calls onRetry when retry button clicked', async () => {
      const onRetry = vi.fn();
      renderContent({ phase: 'idle', error: 'Connection refused', onRetry });
      await userEvent.click(screen.getByText('Retry'));
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('renders Retry disabled and does not call onRetry when retryDisabled is true', async () => {
      const onRetry = vi.fn();
      renderContent({ phase: 'idle', error: 'Connection refused', retryDisabled: true, onRetry });
      const retry = screen.getByText('Retry');
      expect(retry).toBeDisabled();
      await userEvent.click(retry);
      expect(onRetry).not.toHaveBeenCalled();
    });

    it('does not show error when phase is searching', () => {
      renderContent({ phase: 'searching', error: 'Connection refused' });
      expect(screen.queryByText(/Search failed/)).not.toBeInTheDocument();
    });
  });

  describe('results phase', () => {
    it('shows loading spinner when phase is results but searchResponse is null', () => {
      renderContent({ phase: 'results', searchResponse: null });
      expect(screen.getByText('Finalizing results...')).toBeInTheDocument();
    });

    it('shows empty state when results array is empty', () => {
      const searchResponse: SearchResponse = {
        results: [],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse });
      expect(screen.getByText('No releases found')).toBeInTheDocument();
    });

    it('shows duration-unknown banner when durationUnknown is true', () => {
      const searchResponse: SearchResponse = {
        results: [mockResult],
        durationUnknown: true,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse, resultKeys: ['key-0'] });
      expect(screen.getByText(/Duration unknown/)).toBeInTheDocument();
    });

    it('shows correct pluralized result count text', () => {
      const searchResponse: SearchResponse = {
        results: [mockResult],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse, resultKeys: ['key-0'] });
      expect(screen.getByText('Found 1 release')).toBeInTheDocument();
    });

    it('pluralizes result count for multiple results', () => {
      const searchResponse: SearchResponse = {
        results: [mockResult, { ...mockResult, title: 'Another Result', infoHash: 'xyz789' }],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse, resultKeys: ['key-0', 'key-1'] });
      expect(screen.getByText('Found 2 releases')).toBeInTheDocument();
    });

    it('shows UnsupportedSection when unsupported results exist', () => {
      const searchResponse: SearchResponse = {
        results: [],
        durationUnknown: false,
        unsupportedResults: { count: 3, titles: ['Title 1', 'Title 2', 'Title 3'] },
      };
      renderContent({ phase: 'results', searchResponse });
      expect(screen.getByText(/unsupported format \(3\)/i)).toBeInTheDocument();
    });

    it('calls onGrab with correct result when grab clicked', async () => {
      const onGrab = vi.fn();
      const searchResponse: SearchResponse = {
        results: [mockResult],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse, resultKeys: ['key-0'], onGrab });
      const grabButton = screen.getByRole('button', { name: /grab/i });
      await userEvent.click(grabButton);
      expect(onGrab).toHaveBeenCalledWith(mockResult);
    });

    it('calls onBlacklist with correct result when blacklist clicked', async () => {
      const onBlacklist = vi.fn();
      const searchResponse: SearchResponse = {
        results: [mockResult],
        durationUnknown: false,
        unsupportedResults: { count: 0, titles: [] },
      };
      renderContent({ phase: 'results', searchResponse, resultKeys: ['key-0'], onBlacklist });
      const blacklistButton = screen.getByRole('button', { name: /blacklist/i });
      await userEvent.click(blacklistButton);
      expect(onBlacklist).toHaveBeenCalledWith(mockResult);
    });
  });
});

describe('SearchReleasesContent — no relaxed-query banner (superseded disclosure)', () => {
  it('renders results with relaxedQuery present and NO disclosure banner — the box owns the winning query now', () => {
    const searchResponse: SearchResponse = {
      results: [mockResult],
      durationUnknown: false,
      unsupportedResults: { count: 0, titles: [] },
      relaxedQuery: 'star wars haunted starlight',
    };
    renderContent({ phase: 'results', searchResponse, resultKeys: ['k0'] });

    expect(screen.queryByText(/matched on relaxed query/i)).not.toBeInTheDocument();
    expect(screen.queryByText('star wars haunted starlight')).not.toBeInTheDocument();
  });
});

describe('SearchReleasesContent — quality-filtered empty state (#2325)', () => {
  const filteredResponse = (filteredOut: SearchResponse['filteredOut'], overrides: Partial<SearchResponse> = {}): SearchResponse => ({
    results: [],
    durationUnknown: false,
    unsupportedResults: { count: 0, titles: [] },
    ...(filteredOut && { filteredOut }),
    ...overrides,
  });

  it('names the dominant reason with its threshold and lists the remaining reasons', () => {
    renderContent({
      phase: 'results',
      searchResponse: filteredResponse({
        total: 4,
        reasons: [
          { reason: 'below-min-size', count: 3, threshold: '50 MB' },
          { reason: 'below-min-seeders', count: 1, threshold: '5 seeders' },
        ],
      }),
    });

    expect(screen.getByText(/below your minimum size \(50 MB\)/i)).toBeInTheDocument();
    expect(screen.getByText(/below your minimum seeder count \(5 seeders\)/i)).toBeInTheDocument();
    expect(screen.queryByText('No releases found')).not.toBeInTheDocument();
  });

  it('falls back to the plain empty state when filteredOut is absent', () => {
    renderContent({ phase: 'results', searchResponse: filteredResponse(undefined) });

    expect(screen.getByText('No releases found')).toBeInTheDocument();
  });

  it('falls back to the plain empty state when filteredOut reports nothing dropped', () => {
    renderContent({ phase: 'results', searchResponse: filteredResponse({ total: 0, reasons: [] }) });

    expect(screen.getByText('No releases found')).toBeInTheDocument();
  });

  it('renders a threshold-less reason without a dangling qualifier', () => {
    const { container } = renderContent({
      phase: 'results',
      searchResponse: filteredResponse({ total: 2, reasons: [{ reason: 'reject-word-match', count: 2 }] }),
    });

    expect(screen.getByText(/matched one of your reject words/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|\(\)/);
    expect(screen.queryByText('No releases found')).not.toBeInTheDocument();
  });

  it('renders neither empty state when results are present alongside filteredOut', () => {
    renderContent({
      phase: 'results',
      resultKeys: ['key-0'],
      searchResponse: filteredResponse(
        { total: 1, reasons: [{ reason: 'below-min-size', count: 1, threshold: '50 MB' }] },
        { results: [mockResult] },
      ),
    });

    expect(screen.queryByText('No releases found')).not.toBeInTheDocument();
    expect(screen.queryByText(/quality filters/i)).not.toBeInTheDocument();
    expect(screen.getByText('Found 1 release')).toBeInTheDocument();
  });

  it('still renders the unsupported-format section beneath the quality-filtered empty state', () => {
    renderContent({
      phase: 'results',
      searchResponse: filteredResponse(
        { total: 1, reasons: [{ reason: 'below-min-size', count: 1, threshold: '50 MB' }] },
        { unsupportedResults: { count: 2, titles: ['Part 1', 'Part 2'] } },
      ),
    });

    expect(screen.getByText(/below your minimum size/i)).toBeInTheDocument();
    expect(screen.getByText(/unsupported format \(2\)/i)).toBeInTheDocument();
  });

  it('maps every reason in the closed vocabulary to non-empty copy', () => {
    for (const reason of searchDropReasonSchema.options) {
      expect(DROP_REASON_LABELS[reason].trim().length).toBeGreaterThan(0);
    }
  });
});
