import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { UpdateBanner } from '@/components/layout/UpdateBanner';

vi.mock('@/lib/api', () => ({
  api: {
    getSystemStatus: vi.fn(),
    dismissUpdate: vi.fn(),
  },
}));

import { api } from '@/lib/api';

describe('UpdateBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders banner when update present and dismissed: false', async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
      update: {
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      },
    });

    renderWithProviders(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(/update available/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
  });

  it('shows version number and clickable release notes link', async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
      update: {
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      },
    });

    renderWithProviders(<UpdateBanner />);

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /release notes/i });
      expect(link).toHaveAttribute('href', 'https://github.com/releases/v0.2.0');
    });
  });

  it('hidden when no update field in status response', async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
    });

    renderWithProviders(<UpdateBanner />);

    await waitFor(() => {
      expect(vi.mocked(api.getSystemStatus)).toHaveBeenCalled();
    });
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it('hidden when update present but dismissed: true', async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
      update: {
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: true,
      },
    });

    renderWithProviders(<UpdateBanner />);

    await waitFor(() => {
      expect(vi.mocked(api.getSystemStatus)).toHaveBeenCalled();
    });
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it('dismiss button calls PUT /api/system/update/dismiss with the version', async () => {
    vi.mocked(api.getSystemStatus).mockResolvedValue({
      version: '0.1.0',
      status: 'ok',
      timestamp: new Date().toISOString(),
      update: {
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      },
    });
    vi.mocked(api.dismissUpdate).mockResolvedValue({ ok: true });

    renderWithProviders(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(/update available/i)).toBeInTheDocument();
    });

    const dismissButton = screen.getByLabelText(/dismiss update/i);
    await userEvent.click(dismissButton);

    await waitFor(() => {
      expect(api.dismissUpdate).toHaveBeenCalledWith('0.2.0');
    });
  });

  it('banner disappears after successful dismiss via query invalidation', async () => {
    let callCount = 0;
    vi.mocked(api.getSystemStatus).mockImplementation(() => {
      callCount++;
      // First call: update available; subsequent calls: dismissed
      if (callCount === 1) {
        return Promise.resolve({
          version: '0.1.0',
          status: 'ok',
          timestamp: new Date().toISOString(),
          update: {
            latestVersion: '0.2.0',
            releaseUrl: 'https://github.com/releases/v0.2.0',
            dismissed: false,
          },
        });
      }
      return Promise.resolve({
        version: '0.1.0',
        status: 'ok',
        timestamp: new Date().toISOString(),
        update: {
          latestVersion: '0.2.0',
          releaseUrl: 'https://github.com/releases/v0.2.0',
          dismissed: true,
        },
      });
    });
    vi.mocked(api.dismissUpdate).mockResolvedValue({ ok: true });

    renderWithProviders(<UpdateBanner />);

    // Banner should appear
    await waitFor(() => {
      expect(screen.getByText(/update available/i)).toBeInTheDocument();
    });

    // Dismiss
    await userEvent.click(screen.getByLabelText(/dismiss update/i));

    // After dismiss succeeds, query invalidation triggers refetch with dismissed: true → banner gone
    await waitFor(() => {
      expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
    });
  });

  it('does not render during API loading state (no flash)', () => {
    vi.mocked(api.getSystemStatus).mockImplementation(
      () => new Promise(() => {}), // never resolves
    );

    renderWithProviders(<UpdateBanner />);

    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });

  it('does not render on API error (no false positive)', async () => {
    vi.mocked(api.getSystemStatus).mockRejectedValue(new Error('network error'));

    renderWithProviders(<UpdateBanner />);

    // Wait for query to settle
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText(/update available/i)).not.toBeInTheDocument();
  });
});
