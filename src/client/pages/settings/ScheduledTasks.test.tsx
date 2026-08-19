import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '../../__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { ScheduledTasks } from './ScheduledTasks';

vi.mock('@/lib/api', async (importOriginal) => ({
  // Preserve real non-api exports (ApiError) — the mutation's onError does an
  // `instanceof` against it, and a replacement factory would land it as undefined.
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    getSystemTasks: vi.fn(),
    runSystemTask: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import type { Mock } from 'vitest';

const IDLE_MONITOR = { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: false };

/** Render with an idle `monitor` row whose Run Now rejects, then click it. */
async function clickRunNowRejectingWith(error: unknown, queryClient?: QueryClient) {
  const user = userEvent.setup();
  (api.getSystemTasks as Mock).mockResolvedValue([IDLE_MONITOR]);
  (api.runSystemTask as Mock).mockRejectedValue(error);

  renderWithProviders(<ScheduledTasks />, queryClient ? { queryClient } : {});

  await waitFor(() => {
    expect(screen.getByText('monitor')).toBeInTheDocument();
  });

  const runButton = screen.getByRole('button', { name: /run now/i });
  await user.click(runButton);
  return runButton;
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('ScheduledTasks', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: the race test queues a `*Once()` response and
    // clearAllMocks does not drain those queues.
    vi.resetAllMocks();
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
      const spinner = runButton.querySelector('[data-testid="loading-spinner"]');
      expect(spinner).toBeInTheDocument();
    });

    // Let the mutation settle before test cleanup.
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

  describe('ALREADY_RUNNING (409) classification', () => {
    it('surfaces a 409 as an informational toast carrying the server message, not an error', async () => {
      await clickRunNowRejectingWith(new ApiError(409, { error: 'Task "monitor" is already running' }));

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith('Task "monitor" is already running');
      });
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('surfaces a 500 ApiError as an error toast, not informational', async () => {
      await clickRunNowRejectingWith(new ApiError(500, { error: 'Internal server error' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Internal server error');
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('surfaces a 404 ApiError as an error toast — the rule keys on 409, not on any ApiError', async () => {
      await clickRunNowRejectingWith(new ApiError(404, { error: 'Task "monitor" not found' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Task "monitor" not found');
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('surfaces a 503 ApiError as an error toast — the rule does not generalise to any 4xx/5xx', async () => {
      await clickRunNowRejectingWith(new ApiError(503, { error: 'Service unavailable' }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Service unavailable');
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('surfaces a plain Error with no status as an error toast', async () => {
      await clickRunNowRejectingWith(new Error('Network down'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Network down');
      });
      expect(toast.info).not.toHaveBeenCalled();
    });

    it('invalidates the tasks query after a successful run', async () => {
      const user = userEvent.setup();
      const client = makeQueryClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
      (api.getSystemTasks as Mock).mockResolvedValue([IDLE_MONITOR]);
      (api.runSystemTask as Mock).mockResolvedValue({ ok: true });

      renderWithProviders(<ScheduledTasks />, { queryClient: client });
      await waitFor(() => {
        expect(screen.getByText('monitor')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /run now/i }));

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.systemTasks() });
      });
    });

    it('invalidates the tasks query after a 409', async () => {
      const client = makeQueryClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await clickRunNowRejectingWith(new ApiError(409, { error: 'Task "monitor" is already running' }), client);

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.systemTasks() });
      });
    });

    it('invalidates the tasks query after a genuine error', async () => {
      const client = makeQueryClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await clickRunNowRejectingWith(new ApiError(500, { error: 'Internal server error' }), client);

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.systemTasks() });
      });
    });

    it('disables Run Now for a row the poll reports as running, with no click of our own', async () => {
      (api.getSystemTasks as Mock).mockResolvedValue([
        { name: 'monitor', type: 'cron', lastRun: null, nextRun: null, running: true },
      ]);

      renderWithProviders(<ScheduledTasks />);

      await waitFor(() => {
        expect(screen.getByText('monitor')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
      expect(api.runSystemTask).not.toHaveBeenCalled();
    });

    it('leaves Run Now enabled after a 409 settles while the poll still reports idle', async () => {
      const runButton = await clickRunNowRejectingWith(
        new ApiError(409, { error: 'Task "monitor" is already running' }),
      );

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(runButton).toBeEnabled();
      });
    });

    it('reports the scheduler race as informational and flips the row to Running', async () => {
      const user = userEvent.setup();
      (api.getSystemTasks as Mock)
        .mockResolvedValueOnce([IDLE_MONITOR])
        .mockResolvedValue([{ ...IDLE_MONITOR, running: true }]);
      (api.runSystemTask as Mock).mockRejectedValue(
        new ApiError(409, { error: 'Task "monitor" is already running' }),
      );

      renderWithProviders(<ScheduledTasks />);

      await waitFor(() => {
        expect(screen.getByText('Idle')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /run now/i }));

      await waitFor(() => {
        expect(screen.getByText('Running')).toBeInTheDocument();
      });
      expect(toast.info).toHaveBeenCalledWith('Task "monitor" is already running');
      expect(toast.error).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
    });
  });

  describe('when the task read fails', () => {
    it('names the read failure instead of leaving a blank card', async () => {
      (api.getSystemTasks as Mock).mockRejectedValue(new Error('scheduler unavailable'));

      renderWithProviders(<ScheduledTasks />);

      // The pre-fix state is a blank card — not even the empty message renders — so the
      // positive assertion carries the test.
      await waitFor(() => {
        expect(screen.getByText('Failed to load scheduled tasks.')).toBeInTheDocument();
      });
      expect(screen.queryByText('No scheduled tasks.')).not.toBeInTheDocument();
    });

    it('refetches and renders the rows when the operator clicks Retry', async () => {
      (api.getSystemTasks as Mock)
        .mockRejectedValueOnce(new Error('scheduler unavailable'))
        .mockResolvedValue([IDLE_MONITOR]);
      const user = userEvent.setup();

      renderWithProviders(<ScheduledTasks />);
      await waitFor(() => expect(screen.getByText('Failed to load scheduled tasks.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading scheduled tasks' }));

      await waitFor(() => expect(screen.getByText('monitor')).toBeInTheDocument());
      expect(screen.queryByText('Failed to load scheduled tasks.')).not.toBeInTheDocument();
      expect(api.getSystemTasks).toHaveBeenCalledTimes(2);
    });

    it('keeps polling, so the error clears on its own once the endpoint recovers', async () => {
      (api.getSystemTasks as Mock)
        .mockRejectedValueOnce(new Error('scheduler unavailable'))
        .mockResolvedValue([IDLE_MONITOR]);
      const queryClient = makeQueryClient();

      renderWithProviders(<ScheduledTasks />, { queryClient });
      await waitFor(() => expect(screen.getByText('Failed to load scheduled tasks.')).toBeInTheDocument());

      // Stand in for the 30s poll firing: the refetch the interval schedules is the same
      // refetch invalidation triggers, and faking timers deadlocks TanStack Query.
      await queryClient.refetchQueries({ queryKey: queryKeys.systemTasks() });

      await waitFor(() => expect(screen.getByText('monitor')).toBeInTheDocument());
      expect(screen.queryByText('Failed to load scheduled tasks.')).not.toBeInTheDocument();
    });
  });
});
