import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { DownloadsTabSection } from './DownloadsTabSection';
import type { DownloadsTabSectionProps } from './DownloadsTabSection';
import type { Download } from '@/lib/api';

function mockMutation(overrides: Partial<{ mutate: ReturnType<typeof vi.fn>; isPending: boolean; variables: unknown }> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isIdle: true,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    variables: undefined,
    status: 'idle' as const,
    failureCount: 0,
    failureReason: null,
    reset: vi.fn(),
    context: undefined,
    submittedAt: 0,
    ...overrides,
  } as never;
}

function mockPagination(overrides: Partial<{ page: number; limit: number; offset: number }> = {}) {
  return {
    page: 1,
    limit: 25,
    offset: 0,
    setPage: vi.fn(),
    totalPages: (total: number) => Math.ceil(total / 25) || 1,
    clampToTotal: vi.fn(),
    ...overrides,
  } as never;
}

function makeDownload(overrides: Partial<Download> = {}): Download {
  return {
    id: 1,
    bookId: 1,
    title: 'Test Book',
    authorName: 'Author',
    indexerName: 'Test Indexer',
    downloadUrl: 'http://download.url',
    status: 'downloading',
    progress: 0.5,
    size: 1000000,
    protocol: 'torrent',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Download;
}

function defaultProps(overrides: Partial<DownloadsTabSectionProps> = {}): DownloadsTabSectionProps {
  return {
    queue: [],
    queueTotal: 0,
    queuePagination: mockPagination(),
    mergeCards: [],
    searchCards: [],
    cancelMutation: mockMutation(),
    retryMutation: mockMutation(),
    approveMutation: mockMutation(),
    rejectMutation: mockMutation(),
    cancellingMergeBookId: null,
    cancelMergeMutation: mockMutation(),
    history: [],
    historyTotal: 0,
    historyPagination: mockPagination(),
    deleteMutation: mockMutation(),
    deleteHistoryMutation: mockMutation(),
    confirmClearHistory: false,
    onConfirmClearHistoryChange: vi.fn(),
    ...overrides,
  };
}

describe('DownloadsTabSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('active downloads', () => {
    it('renders active downloads count in header', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps({ queueTotal: 3 })} />);
      expect(screen.getByText('3 active downloads')).toBeInTheDocument();
    });

    it('shows singular form for 1 download', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps({ queueTotal: 1 })} />);
      expect(screen.getByText('1 active download')).toBeInTheDocument();
    });

    it('shows empty state when no downloads, merges, or searches active', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps()} />);
      expect(screen.getByText('No active downloads')).toBeInTheDocument();
    });

    it('renders download cards for active queue items', () => {
      const queue = [makeDownload({ id: 1, title: 'Book One' }), makeDownload({ id: 2, title: 'Book Two' })];
      renderWithProviders(<DownloadsTabSection {...defaultProps({ queue, queueTotal: 2 })} />);
      expect(screen.getByText('Book One')).toBeInTheDocument();
      expect(screen.getByText('Book Two')).toBeInTheDocument();
    });
  });

  describe('download history', () => {
    it('renders history count in header', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps({ historyTotal: 5 })} />);
      expect(screen.getByText('5 completed downloads')).toBeInTheDocument();
    });

    it('shows empty state when no history', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps()} />);
      expect(screen.getByText('No download history')).toBeInTheDocument();
    });

    it('shows clear history button when history has items', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps({ historyTotal: 3, history: [makeDownload({ id: 10, status: 'completed' })] })} />);
      expect(screen.getByText('Clear History')).toBeInTheDocument();
    });

    it('does not show clear history button when history is empty', () => {
      renderWithProviders(<DownloadsTabSection {...defaultProps({ historyTotal: 0 })} />);
      expect(screen.queryByText('Clear History')).not.toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('clear history button calls onConfirmClearHistoryChange', async () => {
      const user = userEvent.setup();
      const onConfirmChange = vi.fn();
      renderWithProviders(<DownloadsTabSection {...defaultProps({
        historyTotal: 3,
        history: [makeDownload({ id: 10, status: 'completed' })],
        onConfirmClearHistoryChange: onConfirmChange,
      })} />);

      await user.click(screen.getByText('Clear History'));
      expect(onConfirmChange).toHaveBeenCalledWith(true);
    });
  });
});
