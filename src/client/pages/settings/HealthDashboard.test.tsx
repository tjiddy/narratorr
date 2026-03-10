import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { renderWithProviders } from '../../__tests__/helpers';
import { HealthDashboard } from './HealthDashboard';
import { queryKeys } from '@/lib/queryKeys';

vi.mock('@/lib/api', () => ({
  api: {
    getHealthStatus: vi.fn(),
    getHealthSummary: vi.fn(),
    runHealthCheck: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

describe('HealthDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders health cards with correct state indicators', async () => {
    (api.getHealthStatus as Mock).mockResolvedValue([
      { checkName: 'indexer:NZBgeek', state: 'healthy' },
      { checkName: 'library-root', state: 'error', message: 'Path not writable' },
      { checkName: 'disk-space', state: 'warning', message: 'Low disk space: 3.2 GB free' },
    ]);

    renderWithProviders(<HealthDashboard />);

    await waitFor(() => {
      expect(screen.getByText('indexer:NZBgeek')).toBeInTheDocument();
    });

    expect(screen.getByText('library-root')).toBeInTheDocument();
    expect(screen.getByText('Path not writable')).toBeInTheDocument();
    expect(screen.getByText('disk-space')).toBeInTheDocument();
    expect(screen.getByText('Low disk space: 3.2 GB free')).toBeInTheDocument();
  });

  it('shows per-check error messages when state is warning or error', async () => {
    (api.getHealthStatus as Mock).mockResolvedValue([
      { checkName: 'ffmpeg', state: 'error', message: 'ffmpeg not found at: /usr/bin/ffmpeg' },
    ]);

    renderWithProviders(<HealthDashboard />);

    await waitFor(() => {
      expect(screen.getByText('ffmpeg not found at: /usr/bin/ffmpeg')).toBeInTheDocument();
    });
  });

  it('shows loading state while fetching health status', () => {
    (api.getHealthStatus as Mock).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<HealthDashboard />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows error state when health API fails', async () => {
    (api.getHealthStatus as Mock).mockRejectedValue(new Error('Network error'));

    renderWithProviders(<HealthDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no checks configured', async () => {
    (api.getHealthStatus as Mock).mockResolvedValue([]);

    renderWithProviders(<HealthDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/no health checks/i)).toBeInTheDocument();
    });
  });

  it('Run Now button triggers immediate health check', async () => {
    const user = userEvent.setup();
    (api.getHealthStatus as Mock).mockResolvedValue([
      { checkName: 'library-root', state: 'healthy' },
    ]);
    (api.runHealthCheck as Mock).mockResolvedValue([
      { checkName: 'library-root', state: 'healthy' },
    ]);

    renderWithProviders(<HealthDashboard />);

    await waitFor(() => {
      expect(screen.getByText('library-root')).toBeInTheDocument();
    });

    const runButton = screen.getByRole('button', { name: /run now/i });
    await user.click(runButton);

    await waitFor(() => {
      expect(api.runHealthCheck).toHaveBeenCalledOnce();
    });
  });

  it('invalidates both health status and summary queries after successful Run Now', async () => {
    const user = userEvent.setup();
    (api.getHealthStatus as Mock).mockResolvedValue([
      { checkName: 'library-root', state: 'healthy' },
    ]);
    (api.getHealthSummary as Mock).mockResolvedValue({ state: 'healthy' });
    (api.runHealthCheck as Mock).mockResolvedValue([
      { checkName: 'library-root', state: 'healthy' },
    ]);

    // Render a companion that subscribes to the summary query so invalidation triggers a refetch
    function SummaryObserver() {
      useQuery({ queryKey: queryKeys.health.summary(), queryFn: api.getHealthSummary });
      return null;
    }

    renderWithProviders(
      <>
        <HealthDashboard />
        <SummaryObserver />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByText('library-root')).toBeInTheDocument();
    });

    // Record call counts after initial render
    const statusCallsBefore = (api.getHealthStatus as Mock).mock.calls.length;
    const summaryCallsBefore = (api.getHealthSummary as Mock).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /run now/i }));

    await waitFor(() => {
      expect((api.getHealthStatus as Mock).mock.calls.length).toBeGreaterThan(statusCallsBefore);
      expect((api.getHealthSummary as Mock).mock.calls.length).toBeGreaterThan(summaryCallsBefore);
    });
  });
});
