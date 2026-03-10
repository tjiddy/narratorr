import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers';
import { ScheduledTasks } from './ScheduledTasks';

vi.mock('@/lib/api', () => ({
  api: {
    getSystemTasks: vi.fn(),
    runSystemTask: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
import type { Mock } from 'vitest';

describe('ScheduledTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders task list with name, last run, next run, running columns', async () => {
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: '2026-03-10T11:55:00Z', nextRun: '2026-03-10T12:00:00Z', running: false },
      { name: 'search', type: 'timeout', lastRun: null, nextRun: null, running: true },
    ]);

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    expect(screen.getByText('search')).toBeInTheDocument();
  });

  it('shows "Running" or "Idle" derived from running boolean', async () => {
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
      { name: 'search', type: 'timeout', lastRun: null, nextRun: null, running: true },
    ]);

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('Idle')).toBeInTheDocument();
    });
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('Run Now button calls POST /api/system/tasks/:name/run', async () => {
    const user = userEvent.setup();
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockResolvedValue({ ok: true });

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    const runButton = screen.getByRole('button', { name: /run now/i });
    await user.click(runButton);

    await waitFor(() => {
      expect(api.runSystemTask).toHaveBeenCalledWith('monitor');
    });
  });

  it('shows success toast after manual task run', async () => {
    const user = userEvent.setup();
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockResolvedValue({ ok: true });

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
  });

  it('shows error toast when manual task run fails', async () => {
    const user = userEvent.setup();
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockRejectedValue(new Error('Task failed'));

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('disables Run Now button and shows spinner while mutation is pending', async () => {
    const user = userEvent.setup();
    let resolveTask: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => { resolveTask = resolve; });

    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockReturnValue(pendingPromise);

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    const runButton = screen.getByRole('button', { name: /run now/i });
    await user.click(runButton);

    await waitFor(() => {
      expect(runButton).toBeDisabled();
      // LoadingSpinner renders an SVG with animate-spin; ZapIcon does not
      const spinner = runButton.querySelector('svg.animate-spin');
      expect(spinner).toBeInTheDocument();
    });

    // Resolve so mutation settles and cleanup happens
    resolveTask!({ ok: true });
  });

  it('re-fetches task list after successful mutation', async () => {
    const user = userEvent.setup();
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockResolvedValue({ ok: true });

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    const callsBefore = (api.getSystemTasks as Mock).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect((api.getSystemTasks as Mock).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('re-fetches task list after failed mutation', async () => {
    const user = userEvent.setup();
    (api.getSystemTasks as Mock).mockResolvedValue([
      { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false },
    ]);
    (api.runSystemTask as Mock).mockRejectedValue(new Error('Task failed'));

    renderWithProviders(<ScheduledTasks />);

    await waitFor(() => {
      expect(screen.getByText('monitor')).toBeInTheDocument();
    });

    const callsBefore = (api.getSystemTasks as Mock).mock.calls.length;
    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect((api.getSystemTasks as Mock).mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
