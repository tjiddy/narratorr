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

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getBulkRenamePreview: vi.fn(),
      getBookRenamePreview: vi.fn(),
      getBulkRetagCount: vi.fn(),
      getBookStats: vi.fn(),
      rescanLibrary: vi.fn(),
      deleteMissingBooks: vi.fn(),
    },
  };
});

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
  (api.getBulkRenamePreview as ReturnType<typeof vi.fn>).mockResolvedValue({
    libraryRoot: '/library',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
    items: [
      { bookId: 1, title: 'Book One', from: 'Author/Old One', to: 'Author/Book One' },
    ],
    mismatchedTotal: 5,
    folderMatching: 10,
    importedTotal: 15,
    jobTotal: 15,
  });
  (api.getBookRenamePreview as ReturnType<typeof vi.fn>).mockResolvedValue({
    libraryRoot: '/library',
    folderFormat: '{author}/{title}',
    fileFormat: '{author} - {title}',
    folderMove: { from: 'Author/Old One', to: 'Author/Book One' },
    fileRenames: [],
  });
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

  // Confirmation modal — rename preview
  it('clicking Rename All Books opens the preview modal showing the folder-format summary with counts', async () => {
    const user = userEvent.setup({});
    setup();
    const btn = screen.getByRole('button', { name: /rename all books/i });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Check 15 imported books\. 5 need folder moves\./i)).toBeInTheDocument();
    expect(api.getBulkRenamePreview).toHaveBeenCalled();
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
    await within(dialog).findByText(/Check 15 imported books\. 5 need folder moves\./i);
    await user.click(within(dialog).getByRole('button', { name: /^rename all$/i }));
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

  // #1670 — write/refresh metadata sidecars reconcile action
  it('renders the Write/refresh metadata sidecars button', () => {
    setup();
    expect(screen.getByRole('button', { name: /write\/refresh metadata sidecars/i })).toBeInTheDocument();
  });

  it('clicking Confirm on the sidecar modal calls startJob with "write_metadata_sidecars"', async () => {
    const user = userEvent.setup({});
    setup();
    await user.click(screen.getByRole('button', { name: /write\/refresh metadata sidecars/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /write sidecars/i }));
    expect(mockStartJob).toHaveBeenCalledWith('write_metadata_sidecars');
  });

  // #1698 — copy must not promise a folder cover for every/each book (cover is remote-only)
  it('helper paragraph describes OPF + conditional cover without promising a cover for each book', () => {
    setup();
    const helper = screen.getByText(/Write\/refresh metadata sidecars saves a/i);
    // Retains OPF behavior and the foreign-OPF / media-server explanation.
    expect(helper).toHaveTextContent('metadata.opf');
    expect(helper).toHaveTextContent(/never overwrites a foreign/i);
    expect(helper).toHaveTextContent(/Audiobookshelf, Plex/i);
    // Cover is only materialized when not yet localized.
    expect(helper).toHaveTextContent(/cover not already saved locally/i);
    // Regression: must no longer promise a folder cover for each/every book.
    expect(helper).not.toHaveTextContent(/folder cover into each/i);
  });

  it('sidecar confirm modal describes OPF + conditional cover without promising a cover for every book', async () => {
    const user = userEvent.setup({});
    setup();
    await user.click(screen.getByRole('button', { name: /write\/refresh metadata sidecars/i }));
    const dialog = await screen.findByRole('dialog');
    // Retains OPF behavior, foreign-OPF preservation, and media-server explanation.
    expect(within(dialog).getByText(/metadata\.opf into each imported book's folder/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Foreign metadata\.opf files are left untouched/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Audiobookshelf and Plex/i)).toBeInTheDocument();
    // Cover is only downloaded when not yet localized.
    expect(within(dialog).getByText(/cover that hasn't been saved locally yet/i)).toBeInTheDocument();
    // Regression: must no longer promise a cover image for every book.
    expect(within(dialog).queryByText(/cover image into every/i)).not.toBeInTheDocument();
  });

  it('shows Writing sidecars... N/total with spinner while the reconcile job runs', () => {
    setup({ isRunning: true, jobType: 'write_metadata_sidecars', completed: 4, total: 12 });
    const btn = screen.getByRole('button', { name: /writing sidecars/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/4\/12/);
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

  // Rename preview error handling — surfaced inline in the modal, not as a toast (#1406)
  it('renders the rename preview error inline in the modal when the preview API rejects', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRenamePreview as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Network error');
    expect(toast.error).not.toHaveBeenCalled();
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

  it('renders a stringified non-Error rename preview rejection inline in the modal', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRenamePreview as ReturnType<typeof vi.fn>).mockRejectedValue('string-rejection');
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('string-rejection');
    expect(toast.error).not.toHaveBeenCalled();
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

    // F1 — Refresh Library mutation effects (#1068 review)
    it('Refresh Library success invalidates queryKeys.books() so bookStats and book lists refetch', async () => {
      const user = userEvent.setup({});
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      setup({ queryClient });
      (api.rescanLibrary as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 1, missing: 0, restored: 0 });
      await user.click(screen.getByRole('button', { name: /^refresh library$/i }));
      await waitFor(() => {
        expect(api.rescanLibrary).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
    });

    it('Refresh Library error surfaces api error message via toast.error', async () => {
      const user = userEvent.setup({});
      setup();
      (api.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Library path is not accessible: /audiobooks'));
      await user.click(screen.getByRole('button', { name: /^refresh library$/i }));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Library path is not accessible: /audiobooks');
      });
      expect(toast.success).not.toHaveBeenCalled();
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

    // F2 — Remove Missing Books pending/invalidation/error (#1068 review)
    it('Remove Missing Books shows loading state and is disabled while delete is in flight', async () => {
      const user = userEvent.setup({});
      setup({ missingCount: 4 });
      let resolveDelete!: (v: { deleted: number }) => void;
      (api.deleteMissingBooks as ReturnType<typeof vi.fn>).mockReturnValue(
        new Promise<{ deleted: number }>((resolve) => { resolveDelete = resolve; }),
      );
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /remove missing books/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /removing/i })).toBeDisabled();
      });
      resolveDelete({ deleted: 4 });
      await waitFor(() => {
        // Restored to idle label after settle (still rendered because missingCount=4 in cache)
        expect(screen.getByRole('button', { name: /remove missing books/i })).not.toBeDisabled();
      });
    });

    it('Remove Missing Books success invalidates queryKeys.books() so bookStats and book lists refetch', async () => {
      const user = userEvent.setup({});
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
      setup({ missingCount: 6, queryClient });
      (api.deleteMissingBooks as ReturnType<typeof vi.fn>).mockResolvedValue({ deleted: 6 });
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
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
    });

    it('Remove Missing Books error surfaces api error message via toast.error', async () => {
      const user = userEvent.setup({});
      setup({ missingCount: 3 });
      (api.deleteMissingBooks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Database write failed'));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /remove missing books/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /remove missing books/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Database write failed');
      });
      expect(toast.success).not.toHaveBeenCalled();
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
