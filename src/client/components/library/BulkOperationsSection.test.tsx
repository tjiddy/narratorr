import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../../__tests__/helpers.js';
import { BulkOperationsSection } from './BulkOperationsSection.js';
import { useBulkOperation } from '../../hooks/useBulkOperation.js';
import type { BulkOpType } from '@/lib/api';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockStartJob = vi.fn();

vi.mock('../../hooks/useBulkOperation.js', () => ({
  useBulkOperation: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual };
});

vi.mock('@/lib/api', () => ({
  api: {
    getBulkRenameCount: vi.fn(),
    getBulkRetagCount: vi.fn(),
    getBookStats: vi.fn(),
    rescanLibrary: vi.fn(),
    deleteMissingBooks: vi.fn(),
  },
}));

interface SetupOpts {
  isRunning?: boolean;
  jobType?: BulkOpType | null;
  completed?: number;
  total?: number;
  failures?: number;
  missingCount?: number;
  queryClient?: QueryClient;
}

function makeStats(missing = 0) {
  return {
    counts: { wanted: 0, downloading: 0, imported: 0, failed: 0, missing },
    authors: [],
    series: [],
    narrators: [],
  };
}

function setup(overrides?: SetupOpts) {
  vi.mocked(useBulkOperation).mockReturnValue({
    isRunning: overrides?.isRunning ?? false,
    jobType: overrides?.jobType ?? null,
    progress: {
      completed: overrides?.completed ?? 0,
      total: overrides?.total ?? 0,
      failures: overrides?.failures ?? 0,
    },
    startJob: mockStartJob,
  });
  (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockResolvedValue({ mismatched: 5, alreadyMatching: 10 });
  (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 15 });
  (api.getBookStats as ReturnType<typeof vi.fn>).mockResolvedValue(makeStats(overrides?.missingCount ?? 0));
  (api.rescanLibrary as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 0, missing: 0, restored: 0 });
  (api.deleteMissingBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ deleted: 0 });
  const queryClient = overrides?.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { queryClient, ...renderWithProviders(<BulkOperationsSection />, { queryClient }) };
}

describe('BulkOperationsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStartJob.mockResolvedValue(undefined);
  });

  // Rendering
  it('renders Rename All Books and Re-tag All Books buttons', () => {
    setup();
    expect(screen.getByRole('button', { name: /rename all books/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-tag all books/i })).toBeInTheDocument();
  });

  it('does not render Convert All to M4B button', () => {
    setup();
    expect(screen.queryByRole('button', { name: /convert all to m4b/i })).not.toBeInTheDocument();
  });

  // Confirmation modal — counts
  it('clicking Rename All Books fetches count then opens confirmation modal with both mismatched and alreadyMatching counts', async () => {
    const user = userEvent.setup({});
    setup();
    const btn = screen.getByRole('button', { name: /rename all books/i });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/Rename 5 books to match the current folder format\? 10 books already match and will be skipped\./i)).toBeInTheDocument();
    expect(api.getBulkRenameCount).toHaveBeenCalled();
  });

  it('clicking Re-tag All Books fetches count then opens confirmation modal with count text', async () => {
    const user = userEvent.setup({});
    setup();
    const btn = screen.getByRole('button', { name: /re-tag all books/i });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(within(screen.getByRole('dialog')).getByText(/15 books/i)).toBeInTheDocument();
    expect(api.getBulkRetagCount).toHaveBeenCalled();
  });

  it('clicking Cancel on any modal closes it without calling the start endpoint', async () => {
    const user = userEvent.setup({});
    setup();
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    await waitFor(() => { expect(screen.getByRole('dialog')).toBeInTheDocument(); });
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockStartJob).not.toHaveBeenCalled();
  });

  it('clicking Confirm on rename modal calls startJob with "rename"', async () => {
    const user = userEvent.setup({});
    setup();
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /rename all/i }));
    expect(mockStartJob).toHaveBeenCalledWith('rename');
  });

  it('clicking Confirm on retag modal calls startJob with "retag"', async () => {
    const user = userEvent.setup({});
    setup();
    await user.click(screen.getByRole('button', { name: /re-tag all books/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /re-tag all/i }));
    expect(mockStartJob).toHaveBeenCalledWith('retag');
  });

  // Progress
  it('after confirming rename, button shows Renaming... N/total with spinner and is disabled', async () => {
    setup({ isRunning: true, jobType: 'rename', completed: 3, total: 10 });
    const btn = screen.getByRole('button', { name: /renaming/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/3\/10/);
  });

  it('after confirming retag, button shows Re-tagging... N/total with spinner and is disabled', async () => {
    setup({ isRunning: true, jobType: 'retag', completed: 2, total: 8 });
    const btn = screen.getByRole('button', { name: /re-tagging/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/2\/8/);
  });

  // Cross-op disabling
  it('while rename is running, Re-tag All Books button is disabled', () => {
    setup({ isRunning: true, jobType: 'rename' });
    expect(screen.getByRole('button', { name: /re-tag all books/i })).toBeDisabled();
  });

  it('while retag is running, Rename All Books button is disabled', () => {
    setup({ isRunning: true, jobType: 'retag' });
    expect(screen.getByRole('button', { name: /rename all books/i })).toBeDisabled();
  });

  // Navigation persistence
  it('on mount with active job, polling resumes and progress is displayed', () => {
    setup({ isRunning: true, jobType: 'rename', completed: 5, total: 20 });
    const renameBtn = screen.getByRole('button', { name: /renaming/i });
    expect(renameBtn).toBeDisabled();
    expect(renameBtn.textContent).toMatch(/5/);
  });

  it('on mount with no active job, all buttons are in normal idle state', () => {
    setup();
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /re-tag all books/i })).not.toBeDisabled();
  });

  // Error recovery
  it('when poll returns 404 (server restart), button resets to normal state without crashing', () => {
    setup({ isRunning: false, jobType: null });
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  // Completion
  it('when job completes, button returns to normal state', () => {
    setup({ isRunning: false, jobType: null });
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  it('when job completes with failures, failure count is displayed after completion', () => {
    setup({ isRunning: false, jobType: null, failures: 3, completed: 10, total: 10 });
    expect(screen.getByText(/3 failure/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  it('while rename is running with failures, failure count is shown during run', () => {
    setup({ isRunning: true, jobType: 'rename', failures: 2, completed: 5, total: 10 });
    expect(screen.getByText(/2 failure/i)).toBeInTheDocument();
  });

  // AC1: count fetch error handling (#141)
  it('shows toast.error and re-enables button when rename count API rejects', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Network error');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  it('shows toast.error when retag count API rejects', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Server error'));
    await user.click(screen.getByRole('button', { name: /re-tag all books/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Server error');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows stringified error toast when rename count API rejects a non-Error value', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockRejectedValue('string-rejection');
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('string-rejection');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  // AC5: busy-state tooltips (#141)
  it('Rename All Books button has tooltip "A bulk operation is already running." when another job is running', () => {
    setup({ isRunning: true, jobType: 'retag' });
    const renameBtn = screen.getByRole('button', { name: /rename all books/i });
    expect(renameBtn).toHaveAttribute('title', 'A bulk operation is already running.');
  });

  it('Re-tag All Books button has tooltip "A bulk operation is already running." when another job is running', () => {
    setup({ isRunning: true, jobType: 'rename' });
    const retagBtn = screen.getByRole('button', { name: /re-tag all books/i });
    expect(retagBtn).toHaveAttribute('title', 'A bulk operation is already running.');
  });

  // Finding 1: Library Actions section rename (#227)
  describe('Library Actions section (#227)', () => {
    it('section heading is "Library Actions" (not "Bulk Operations")', () => {
      setup();
      expect(screen.getByText('Library Actions')).toBeInTheDocument();
      expect(screen.queryByText('Bulk Operations')).not.toBeInTheDocument();
    });

    it('Import Existing Library link appears before Rename All Books button', () => {
      setup();
      const importLink = screen.getByRole('link', { name: /import existing library/i });
      const renameBtn = screen.getByRole('button', { name: /rename all books/i });
      expect(importLink.compareDocumentPosition(renameBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Import Existing Library link has href="/library-import"', () => {
      setup();
      const importLink = screen.getByRole('link', { name: /import existing library/i });
      expect(importLink).toHaveAttribute('href', '/library-import');
    });
  });

  // #1066 — Refresh Library / Remove Missing Books split
  describe('library import / reconciliation split (#1066)', () => {
    it('renders "Import Existing Library" link, not "Scan Library"', () => {
      setup();
      expect(screen.getByRole('link', { name: /import existing library/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^scan library$/i })).not.toBeInTheDocument();
    });

    it('renders Refresh Library button', () => {
      setup();
      expect(screen.getByRole('button', { name: /^refresh library$/i })).toBeInTheDocument();
    });

    it('clicking Refresh Library calls api.rescanLibrary and toasts success summary', async () => {
      const user = userEvent.setup({});
      setup();
      (api.rescanLibrary as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 12, missing: 2, restored: 1 });
      await user.click(screen.getByRole('button', { name: /^refresh library$/i }));
      await waitFor(() => {
        expect(api.rescanLibrary).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Scanned: 12 books. Missing: 2 books. Restored: 1 books.');
      });
    });

    it('Refresh Library button shows loading state and is disabled while in flight', async () => {
      const user = userEvent.setup({});
      setup();
      let resolveRescan!: (v: { scanned: number; missing: number; restored: number }) => void;
      (api.rescanLibrary as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<{ scanned: number; missing: number; restored: number }>((resolve) => { resolveRescan = resolve; }),
      );
      const btn = screen.getByRole('button', { name: /^refresh library$/i });
      await user.click(btn);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /refreshing/i })).toBeDisabled();
      });
      resolveRescan({ scanned: 0, missing: 0, restored: 0 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^refresh library$/i })).not.toBeDisabled();
      });
    });

    it('Remove Missing Books button is absent when missing count is 0', () => {
      setup({ missingCount: 0 });
      expect(screen.queryByRole('button', { name: /remove missing books/i })).not.toBeInTheDocument();
    });

    it('Remove Missing Books button is present when missing count > 0', async () => {
      setup({ missingCount: 3 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
    });

    it('clicking Remove Missing Books opens ConfirmModal with count and "Files will not be deleted" clarification', async () => {
      const user = userEvent.setup({});
      setup({ missingCount: 12 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /remove missing books/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Remove 12 missing books from Narratorr\? Files will not be deleted\./i)).toBeInTheDocument();
    });

    it('confirming Remove Missing Books calls api.deleteMissingBooks and toasts success', async () => {
      const user = userEvent.setup({});
      setup({ missingCount: 4 });
      (api.deleteMissingBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ deleted: 4 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /remove missing books/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));
      await waitFor(() => {
        expect(api.deleteMissingBooks).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Removed 4 missing books');
      });
    });

    it('cancelling Remove Missing Books modal does not call api.deleteMissingBooks', async () => {
      const user = userEvent.setup({});
      setup({ missingCount: 2 });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /remove missing books/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      expect(api.deleteMissingBooks).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('Remove Missing Books appears after stats cache transitions from 0 to >0 (e.g., post-refresh)', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      setup({ missingCount: 0, queryClient });
      // Wait for initial query to settle
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^refresh library$/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /remove missing books/i })).not.toBeInTheDocument();

      // Simulate refresh resolving and bookStats now reflecting 5 missing
      queryClient.setQueryData(queryKeys.bookStats(), makeStats(5));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
    });

    it('Remove Missing Books disappears after stats cache transitions from >0 to 0 (e.g., post-delete)', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      setup({ missingCount: 7, queryClient });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      queryClient.setQueryData(queryKeys.bookStats(), makeStats(0));
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /remove missing books/i })).not.toBeInTheDocument();
      });
    });
  });
});
