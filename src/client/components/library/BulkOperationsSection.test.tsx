import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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

vi.mock('@/lib/api', () => ({
  api: {
    getBulkRenameCount: vi.fn(),
    getBulkRetagCount: vi.fn(),
    getBulkConvertCount: vi.fn(),
    getSettings: vi.fn(),
  },
}));

function setup(overrides?: { ffmpegPath?: string; isRunning?: boolean; jobType?: string | null; completed?: number; total?: number; failures?: number }) {
  mockIsRunning.current = overrides?.isRunning ?? false;
  mockJobType.current = overrides?.jobType ?? null;
  mockProgress.current = {
    completed: overrides?.completed ?? 0,
    total: overrides?.total ?? 0,
    failures: overrides?.failures ?? 0,
  };
  const ffmpegPath = overrides?.ffmpegPath ?? '/usr/bin/ffmpeg';
  (api.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
    processing: { ffmpegPath },
  });
  (api.getBulkRenameCount as ReturnType<typeof vi.fn>).mockResolvedValue({ mismatched: 5, alreadyMatching: 10 });
  (api.getBulkRetagCount as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 15 });
  (api.getBulkConvertCount as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 3 });
  return renderWithProviders(<BulkOperationsSection />);
}

describe('BulkOperationsSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStartJob.mockResolvedValue(undefined);
  });

  // Rendering
  it('renders Rename All Books, Re-tag All Books, Convert All to M4B buttons', () => {
    setup();
    expect(screen.getByRole('button', { name: /rename all books/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-tag all books/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /convert all to m4b/i })).toBeInTheDocument();
  });

  it('Convert All to M4B button is disabled with tooltip when ffmpegPath is not configured', async () => {
    setup({ ffmpegPath: '' });
    const convertBtn = screen.getByRole('button', { name: /convert all to m4b/i });
    expect(convertBtn).toBeDisabled();
  });

  it('Convert All to M4B button is enabled when ffmpegPath is configured', async () => {
    setup({ ffmpegPath: '/usr/bin/ffmpeg' });
    // Wait for settings query to resolve and enable the button
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /convert all to m4b/i })).not.toBeDisabled();
    });
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
    expect(screen.getByText(/15/)).toBeInTheDocument();
    expect(api.getBulkRetagCount).toHaveBeenCalled();
  });

  it('clicking Convert All to M4B fetches count then opens confirmation modal with count text', async () => {
    const user = userEvent.setup({});
    setup();
    const btn = screen.getByRole('button', { name: /convert all to m4b/i });
    await user.click(btn);
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(api.getBulkConvertCount).toHaveBeenCalled();
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

  // Progress
  it('after confirming rename, button shows Renaming... N/total with spinner and is disabled', async () => {
    mockIsRunning.current = true;
    mockJobType.current = 'rename';
    mockProgress.current = { completed: 3, total: 10, failures: 0 };
    setup({ isRunning: true, jobType: 'rename', completed: 3, total: 10 });
    const btn = screen.getByRole('button', { name: /renaming/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/3/);
    expect(btn.textContent).toMatch(/10/);
  });

  it('after confirming retag, button shows Re-tagging... N/total with spinner and is disabled', async () => {
    setup({ isRunning: true, jobType: 'retag', completed: 2, total: 8 });
    const btn = screen.getByRole('button', { name: /re-tagging/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/2/);
  });

  it('after confirming convert, button shows Converting... N/total with spinner and is disabled', async () => {
    setup({ isRunning: true, jobType: 'convert', completed: 1, total: 5 });
    const btn = screen.getByRole('button', { name: /converting/i });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/1/);
  });

  // Cross-op disabling
  it('while rename is running, Re-tag All Books and Convert All to M4B buttons are disabled', () => {
    setup({ isRunning: true, jobType: 'rename' });
    expect(screen.getByRole('button', { name: /re-tag all books/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /convert all to m4b/i })).toBeDisabled();
  });

  it('while retag is running, Rename All Books and Convert All to M4B buttons are disabled', () => {
    setup({ isRunning: true, jobType: 'retag' });
    expect(screen.getByRole('button', { name: /rename all books/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /convert all to m4b/i })).toBeDisabled();
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

  it('shows toast.error when convert count API rejects', async () => {
    const user = userEvent.setup({});
    setup({ ffmpegPath: '/usr/bin/ffmpeg' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /convert all to m4b/i })).not.toBeDisabled();
    });
    (api.getBulkConvertCount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Convert error'));
    await user.click(screen.getByRole('button', { name: /convert all to m4b/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Convert error');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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

  // AC6: Convert tooltip copy (#141)
  it('Convert All to M4B button tooltip reads "Requires ffmpeg — configure in Settings > Post Processing" when ffmpeg not configured', () => {
    setup({ ffmpegPath: '' });
    const convertBtn = screen.getByRole('button', { name: /convert all to m4b/i });
    expect(convertBtn).toHaveAttribute('title', 'Requires ffmpeg — configure in Settings > Post Processing');
  });
});
