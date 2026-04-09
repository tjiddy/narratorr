import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers.js';
import { BulkOperationsSection } from './BulkOperationsSection.js';
import { api } from '@/lib/api';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const mockStartJob = vi.fn();
const mockIsRunning = { current: false };
const mockJobType = { current: null as string | null };
const mockProgress = { current: { completed: 0, total: 0, failures: 0 } };

vi.mock('../../hooks/useBulkOperation.js', () => ({
  useBulkOperation: () => ({
    isRunning: mockIsRunning.current,
    jobType: mockJobType.current,
    progress: mockProgress.current,
    startJob: mockStartJob,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual };
});

vi.mock('@/lib/api', () => ({
  api: {
    getBulkRenameCount: vi.fn(),
    getBulkRetagCount: vi.fn(),
  },
}));

function setup(overrides?: { isRunning?: boolean; jobType?: string | null; completed?: number; total?: number; failures?: number }) {
  mockIsRunning.current = overrides?.isRunning ?? false;
  mockJobType.current = overrides?.jobType ?? null;
  mockProgress.current = {
    completed: overrides?.completed ?? 0,
    total: overrides?.total ?? 0,
    failures: overrides?.failures ?? 0,
  };
  (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockResolvedValue({ mismatched: 5, alreadyMatching: 10 });
  (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 15 });
  return renderWithProviders(<BulkOperationsSection />);
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
    mockIsRunning.current = true;
    mockJobType.current = 'rename';
    mockProgress.current = { completed: 3, total: 10, failures: 0 };
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
    // The rename button should show progress (hook resumes on mount)
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
    // Hook resets to idle on 404 — simulate by having hook return idle state
    setup({ isRunning: false, jobType: null });
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  // Completion
  it('when job completes, button returns to normal state', () => {
    // Hook marks isRunning=false on completion
    setup({ isRunning: false, jobType: null });
    expect(screen.getByRole('button', { name: /rename all books/i })).not.toBeDisabled();
  });

  it('when job completes with failures, failure count is displayed after completion', () => {
    // After completion with failures, the failure banner should remain visible
    setup({ isRunning: false, jobType: null, failures: 3, completed: 10, total: 10 });
    expect(screen.getByText(/3 failure/i)).toBeInTheDocument();
    // Buttons should also be back in idle state
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
    // Modal should NOT open
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Button should be re-enabled (loading cleared)
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

  it('shows fallback toast message when rename count API rejects a non-Error value', async () => {
    const user = userEvent.setup({});
    setup();
    (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockRejectedValue('string-rejection');
    await user.click(screen.getByRole('button', { name: /rename all books/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to fetch operation count');
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

    it('Scan Library link appears before Rename All Books button', () => {
      setup();
      const scanLink = screen.getByRole('link', { name: /scan library/i });
      const renameBtn = screen.getByRole('button', { name: /rename all books/i });
      // Scan Library should come before Rename in DOM order
      expect(scanLink.compareDocumentPosition(renameBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Scan Library link has href="/library-import"', () => {
      setup();
      const scanLink = screen.getByRole('link', { name: /scan library/i });
      expect(scanLink).toHaveAttribute('href', '/library-import');
    });
  });
});
