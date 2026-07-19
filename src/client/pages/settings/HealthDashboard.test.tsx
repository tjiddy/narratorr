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

  describe('#1065 — clickable cards via target (now Link-based, #1888)', () => {
    it('renders an indexer card as a link to /settings/indexers?edit=<id>', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'indexer:MAM',
          state: 'error',
          message: 'Authentication failed',
          target: { kind: 'indexer', id: 42 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /indexer:MAM/i });
      expect(card).toHaveAttribute('href', '/settings/indexers?edit=42');
    });

    it('links to /settings/download-clients?edit=<id> for download-client target', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'download-client:qBit',
          state: 'error',
          target: { kind: 'download-client', id: 7 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /download-client:qBit/i });
      expect(card).toHaveAttribute('href', '/settings/download-clients?edit=7');
    });

    it('links to /settings/post-processing for ffmpeg settings target', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'ffmpeg',
          state: 'error',
          target: { kind: 'settings', path: 'post-processing' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /ffmpeg/i });
      expect(card).toHaveAttribute('href', '/settings/post-processing');
    });

    it('links to /settings (index) for library-root route target — not /settings/general', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'library-root',
          state: 'error',
          target: { kind: 'route', path: '/settings' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /library-root/i });
      expect(card).toHaveAttribute('href', '/settings');
    });

    it('links to /activity for stuck-downloads route target', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'stuck-downloads',
          state: 'warning',
          target: { kind: 'route', path: '/activity' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /stuck-downloads/i });
      expect(card).toHaveAttribute('href', '/activity');
    });

    it('resolves the card link under a subpath basename', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'indexer:MAM', state: 'error', target: { kind: 'indexer', id: 42 } },
      ]);

      renderWithProviders(<HealthDashboard />, { basename: '/narratorr', route: '/settings/system' });

      const card = await screen.findByRole('link', { name: /indexer:MAM/i });
      expect(card).toHaveAttribute('href', '/narratorr/settings/indexers?edit=42');
    });

    it('cards without target render as non-link elements', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'untargeted-check', state: 'healthy' },
      ]);

      renderWithProviders(<HealthDashboard />);

      await waitFor(() => {
        expect(screen.getByText('untargeted-check')).toBeInTheDocument();
      });

      expect(screen.queryByRole('link', { name: /untargeted-check/i })).toBeNull();
    });

    it('an actionable card is keyboard-focusable (native link activation)', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'indexer:NZB',
          state: 'error',
          target: { kind: 'indexer', id: 1 },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const card = await screen.findByRole('link', { name: /indexer:NZB/i });
      card.focus();
      expect(document.activeElement).toBe(card);
      expect(card).toHaveAttribute('href', '/settings/indexers?edit=1');
    });

    it('two indexer cards with the same checkName but different ids both render with distinct hrefs', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'indexer:NZB', state: 'error', target: { kind: 'indexer', id: 1 } },
        { checkName: 'indexer:NZB', state: 'warning', target: { kind: 'indexer', id: 2 } },
      ]);

      // Suppress noise; assert no duplicate-key warning surfaces.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderWithProviders(<HealthDashboard />);

      const links = await screen.findAllByRole('link', { name: /indexer:NZB/i });
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute('href', '/settings/indexers?edit=1');
      expect(links[1]).toHaveAttribute('href', '/settings/indexers?edit=2');

      const duplicateKeyWarning = errorSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('Encountered two children with the same key')),
      );
      expect(duplicateKeyWarning).toBe(false);

      errorSpy.mockRestore();
    });
  });

  describe('#1230 — inline link rendering', () => {
    it('renders an external release-notes link when a check carries a link', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'version-update',
          state: 'warning',
          message: 'Update available: v1.2.3',
          link: { url: 'https://github.com/tjiddy/narratorr/releases/v1.2.3', label: 'Release notes' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      const anchor = await screen.findByRole('link', { name: /release notes/i });
      expect(anchor).toHaveAttribute('href', 'https://github.com/tjiddy/narratorr/releases/v1.2.3');
      expect(anchor).toHaveAttribute('target', '_blank');
      expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByText('Update available: v1.2.3')).toBeInTheDocument();
    });

    it('renders the card as a non-button (no nested interactive control) when a link is present', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        {
          checkName: 'version-update',
          state: 'warning',
          link: { url: 'https://example.com/r', label: 'Release notes' },
        },
      ]);

      renderWithProviders(<HealthDashboard />);

      await screen.findByRole('link', { name: /release notes/i });
      expect(screen.queryByRole('button', { name: /version-update/i })).toBeNull();
    });

    it('renders no anchor for checks without a link', async () => {
      (api.getHealthStatus as Mock).mockResolvedValue([
        { checkName: 'library-root', state: 'healthy' },
      ]);

      renderWithProviders(<HealthDashboard />);

      await waitFor(() => {
        expect(screen.getByText('library-root')).toBeInTheDocument();
      });
      expect(screen.queryByRole('link')).toBeNull();
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
