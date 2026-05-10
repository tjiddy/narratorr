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

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import { api } from '@/lib/api';
import type { Mock } from 'vitest';

describe('HealthDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateMock.mockReset();
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

  describe('#1065 — clickable cards via target', () => {
    it('renders an indexer card as a button and navigates to /settings/indexers?edit=<id> on click', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'indexer:MAM',
          state: 'error',
          message: 'Authentication failed',
          target: { kind: 'indexer', id: 42 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /indexer:MAM/i });
      await user.click(card);

      expect(navigateMock).toHaveBeenCalledWith('/settings/indexers?edit=42');
    });

    it('navigates to /settings/download-clients?edit=<id> for download-client target', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'download-client:qBit',
          state: 'error',
          target: { kind: 'download-client', id: 7 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /download-client:qBit/i });
      await user.click(card);

      expect(navigateMock).toHaveBeenCalledWith('/settings/download-clients?edit=7');
    });

    it('navigates to /settings/post-processing for ffmpeg settings target', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'ffmpeg',
          state: 'error',
          target: { kind: 'settings', path: 'post-processing' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /ffmpeg/i });
      await user.click(card);

      expect(navigateMock).toHaveBeenCalledWith('/settings/post-processing');
    });

    it('navigates to /settings (index) for library-root route target — not /settings/general', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'library-root',
          state: 'error',
          target: { kind: 'route', path: '/settings' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /library-root/i });
      await user.click(card);

      expect(navigateMock).toHaveBeenCalledWith('/settings');
    });

    it('navigates to /activity for stuck-downloads route target', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'stuck-downloads',
          state: 'warning',
          target: { kind: 'route', path: '/activity' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /stuck-downloads/i });
      await user.click(card);

      expect(navigateMock).toHaveBeenCalledWith('/activity');
    });

    it('cards without target render as non-button elements with no navigation', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'untargeted-check', state: 'healthy' },
      ]);

      renderWithProviders(<HealthDashboard />);

      await waitFor(() => {
        expect(screen.getByText('untargeted-check')).toBeInTheDocument();
      });

      // No button with that name exists
      expect(screen.queryByRole('button', { name: /untargeted-check/i })).toBeNull();
    });

    it('keyboard activation (Enter) on actionable card triggers navigation', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'indexer:NZB',
          state: 'error',
          target: { kind: 'indexer', id: 1 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('button', { name: /indexer:NZB/i });
      card.focus();
      await user.keyboard('{Enter}');

      expect(navigateMock).toHaveBeenCalledWith('/settings/indexers?edit=1');
    });

    it('two indexer cards with the same checkName but different ids both render and navigate independently', async () => {
      const user = userEvent.setup();
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'indexer:NZB', state: 'error', target: { kind: 'indexer', id: 1 } },
        { checkName: 'indexer:NZB', state: 'warning', target: { kind: 'indexer', id: 2 } },
      ]);

      // Suppress noise; assert no duplicate-key warning surfaces.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderWithProviders(<HealthDashboard />);

      const buttons = await screen.findAllByRole('button', { name: /indexer:NZB/i });
      expect(buttons).toHaveLength(2);

      await user.click(buttons[0]!);
      expect(navigateMock).toHaveBeenLastCalledWith('/settings/indexers?edit=1');

      await user.click(buttons[1]!);
      expect(navigateMock).toHaveBeenLastCalledWith('/settings/indexers?edit=2');

      const duplicateKeyWarning = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('Encountered two children with the same key')),
      );
      expect(duplicateKeyWarning).toBe(false);

      errorSpy.mockRestore();
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
