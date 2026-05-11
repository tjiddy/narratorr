import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ActiveTabSection } from './ActiveTabSection';
import type { ActiveTabSectionProps } from './ActiveTabSection';
import type { Download, ImportJobWithBook } from '@/lib/api';

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

function defaultProps(overrides: Partial<ActiveTabSectionProps> = {}): ActiveTabSectionProps {
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
    ...overrides,
  };
}

describe('ActiveTabSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('queue count and empty state', () => {
    it('renders plural download queue count in header', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps({ queueTotal: 3 })} />);
      expect(screen.getByText('3 downloads queued')).toBeInTheDocument();
    });

    it('renders singular download queue count for 1 item', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps({ queueTotal: 1 })} />);
      expect(screen.getByText('1 download queued')).toBeInTheDocument();
    });

    it('hides download queue count when there are no queued downloads', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps({ queueTotal: 0 })} />);
      expect(screen.queryByText(/downloads? queued/)).not.toBeInTheDocument();
    });

    it('shows empty header subtitle when no activity is active', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps()} />);
      expect(screen.getByText('Nothing currently active')).toBeInTheDocument();
    });

    it('does not show empty header subtitle while processing import jobs are present', () => {
      const importJobs: ImportJobWithBook[] = [{
        id: 1, bookId: 42, type: 'manual', status: 'processing', phase: 'copying',
        phaseHistory: [{ phase: 'copying', startedAt: 1000 }],
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
        startedAt: '2025-01-01T00:00:00Z', completedAt: null,
        book: { title: 'Import Book', coverUrl: null, primaryAuthorName: 'Author' },
      }];
      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);
      expect(screen.queryByText('Nothing currently active')).not.toBeInTheDocument();
    });

    it('ignores completed import jobs that are no longer visible activity', () => {
      const importJobs: ImportJobWithBook[] = [{
        id: 1, bookId: 42, type: 'manual', status: 'completed', phase: 'done',
        phaseHistory: [],
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:01:00Z',
        startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:01:00Z',
        book: { title: 'Finished Import', coverUrl: null, primaryAuthorName: 'Author' },
      }];
      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);
      expect(screen.getByText('Nothing currently active')).toBeInTheDocument();
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    it('shows empty state when no downloads, merges, or searches active', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps()} />);
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    it('renders download cards for active queue items', () => {
      const queue = [makeDownload({ id: 1, title: 'Book One' }), makeDownload({ id: 2, title: 'Book Two' })];
      renderWithProviders(<ActiveTabSection {...defaultProps({ queue, queueTotal: 2 })} />);
      expect(screen.getByText('Book One')).toBeInTheDocument();
      expect(screen.getByText('Book Two')).toBeInTheDocument();
    });

    it('does not render history section or clear history button', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps()} />);
      expect(screen.queryByText('Clear History')).not.toBeInTheDocument();
      expect(screen.queryByText(/completed download/)).not.toBeInTheDocument();
      expect(screen.queryByText('No download history')).not.toBeInTheDocument();
    });
  });

  describe('#514 per-item cancelling state', () => {
    it('only the row matching cancelMutation.variables shows cancelling state', () => {
      const queue = [
        makeDownload({ id: 1, title: 'Book One', status: 'downloading' }),
        makeDownload({ id: 2, title: 'Book Two', status: 'downloading' }),
      ];
      renderWithProviders(<ActiveTabSection {...defaultProps({
        queue,
        queueTotal: 2,
        cancelMutation: mockMutation({ isPending: true, variables: 1 }),
      })} />);

      // First row should show cancelling state
      const cancellingTexts = screen.getAllByText('Cancelling...');
      expect(cancellingTexts).toHaveLength(1);

      // Second row should show normal "Cancel & Blacklist" button
      expect(screen.getByText('Cancel & Blacklist')).toBeInTheDocument();
    });
  });

  // ===========================================================================
  // #637 — Import jobs integration
  // ===========================================================================

  describe('#637 import jobs integration', () => {
    it('renders ImportActivityCard for processing import jobs', () => {
      const importJobs: ImportJobWithBook[] = [{
        id: 1, bookId: 42, type: 'manual', status: 'processing', phase: 'copying',
        phaseHistory: [{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }, { phase: 'copying', startedAt: 2000 }],
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
        startedAt: '2025-01-01T00:00:00Z', completedAt: null,
        book: { title: 'Import Book', coverUrl: null, primaryAuthorName: 'Author' },
      }];
      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);
      expect(screen.getByText('Import Book')).toBeInTheDocument();
    });

    it('renders queued subsection with ImportQueuedRow components', () => {
      const importJobs: ImportJobWithBook[] = [{
        id: 2, bookId: 43, type: 'manual', status: 'pending', phase: 'queued',
        phaseHistory: [],
        createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
        startedAt: null, completedAt: null,
        book: { title: 'Queued Book', coverUrl: null, primaryAuthorName: null },
      }];
      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);
      expect(screen.getByText('Queued Book')).toBeInTheDocument();
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });

    it('shows "Queued · N waiting" section header', () => {
      const importJobs: ImportJobWithBook[] = [
        { id: 1, bookId: 41, type: 'manual', status: 'pending', phase: 'queued', phaseHistory: [], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', startedAt: null, completedAt: null, book: { title: 'Q1', coverUrl: null, primaryAuthorName: null } },
        { id: 2, bookId: 42, type: 'manual', status: 'pending', phase: 'queued', phaseHistory: [], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', startedAt: null, completedAt: null, book: { title: 'Q2', coverUrl: null, primaryAuthorName: null } },
      ];
      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);
      expect(screen.getByText(/2 waiting/)).toBeInTheDocument();
    });

    it('empty state unchanged when no activity of any type', () => {
      renderWithProviders(<ActiveTabSection {...defaultProps()} />);
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    it('sorts processing imports by updatedAt descending and queued by createdAt ascending', () => {
      const importJobs: ImportJobWithBook[] = [
        // Intentionally out of order: older update first
        { id: 1, bookId: 41, type: 'manual', status: 'processing', phase: 'copying',
          phaseHistory: [{ phase: 'copying', startedAt: 1000 }],
          createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T01:00:00Z',
          startedAt: '2025-01-01T00:00:00Z', completedAt: null,
          book: { title: 'Older Processing', coverUrl: null, primaryAuthorName: null } },
        { id: 2, bookId: 42, type: 'manual', status: 'processing', phase: 'analyzing',
          phaseHistory: [{ phase: 'analyzing', startedAt: 2000 }],
          createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T02:00:00Z',
          startedAt: '2025-01-01T00:00:00Z', completedAt: null,
          book: { title: 'Newer Processing', coverUrl: null, primaryAuthorName: null } },
        // Queued: newer created first (should render second)
        { id: 3, bookId: 43, type: 'manual', status: 'pending', phase: 'queued',
          phaseHistory: [],
          createdAt: '2025-01-01T02:00:00Z', updatedAt: '2025-01-01T02:00:00Z',
          startedAt: null, completedAt: null,
          book: { title: 'Newer Queued', coverUrl: null, primaryAuthorName: null } },
        { id: 4, bookId: 44, type: 'manual', status: 'pending', phase: 'queued',
          phaseHistory: [],
          createdAt: '2025-01-01T01:00:00Z', updatedAt: '2025-01-01T01:00:00Z',
          startedAt: null, completedAt: null,
          book: { title: 'Older Queued', coverUrl: null, primaryAuthorName: null } },
      ];

      renderWithProviders(<ActiveTabSection {...defaultProps({ importJobs })} />);

      const titles = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
      // Processing: Newer first (updatedAt desc), then queued section: Older first (createdAt asc)
      const newerIdx = titles.indexOf('Newer Processing');
      const olderIdx = titles.indexOf('Older Processing');
      expect(newerIdx).toBeLessThan(olderIdx);

      const allText = document.body.textContent ?? '';
      const olderQueuedPos = allText.indexOf('Older Queued');
      const newerQueuedPos = allText.indexOf('Newer Queued');
      expect(olderQueuedPos).toBeLessThan(newerQueuedPos);
    });
  });
});
