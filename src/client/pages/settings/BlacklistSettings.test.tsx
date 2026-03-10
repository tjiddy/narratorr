import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { BlacklistSettings } from './BlacklistSettings';

vi.mock('@/lib/api', () => ({
  api: {
    getBlacklist: vi.fn(),
    removeFromBlacklist: vi.fn(),
    toggleBlacklistType: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockEntries = [
  {
    id: 1,
    infoHash: 'abc123def456789',
    title: 'Bad Release [Unabridged]',
    reason: 'wrong_content' as const,
    note: 'Not the right book',
    blacklistType: 'permanent' as const,
    expiresAt: null,
    blacklistedAt: '2024-06-15T12:00:00Z',
  },
  {
    id: 2,
    infoHash: 'xyz789abc123456',
    title: 'Spam Release',
    reason: 'spam' as const,
    blacklistType: 'permanent' as const,
    expiresAt: null,
    blacklistedAt: '2024-06-16T12:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BlacklistSettings', () => {
  it('shows empty state when no entries', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue([]);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('No blacklisted releases')).toBeInTheDocument();
    });
  });

  it('renders blacklist entries', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
    });
    expect(screen.getByText('Spam Release')).toBeInTheDocument();
    expect(screen.getByText('Wrong Content')).toBeInTheDocument();
    expect(screen.getByText('Spam')).toBeInTheDocument();
  });

  it('shows note when present', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Not the right book')).toBeInTheDocument();
    });
  });

  it('shows truncated info hash', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('abc123def456...')).toBeInTheDocument();
    });
  });

  it('opens confirm modal and deletes entry', async () => {
    vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);
    vi.mocked(api.removeFromBlacklist).mockResolvedValue({ success: true });
    const user = userEvent.setup();

    renderWithProviders(<BlacklistSettings />);

    await waitFor(() => {
      expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
    });

    // Click delete on first entry
    const deleteButtons = screen.getAllByLabelText(/Remove .* from blacklist/);
    await user.click(deleteButtons[0]);

    // Confirm modal should appear
    expect(screen.getByText(/Remove "Bad Release \[Unabridged\]" from the blacklist/)).toBeInTheDocument();

    // Click the "Delete" confirm button
    const confirmButton = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.removeFromBlacklist).toHaveBeenCalled();
      expect(vi.mocked(api.removeFromBlacklist).mock.calls[0][0]).toBe(1);
    });
  });

  describe('reason and expiry columns', () => {
    it('shows reason column with human-readable labels including new reasons', async () => {
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Failed Download Release',
          reason: 'download_failed' as const,
          blacklistType: 'temporary' as const,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
        {
          id: 2,
          infoHash: 'xyz789abc123456',
          title: 'Infra Error Release',
          reason: 'infrastructure_error' as const,
          blacklistType: 'temporary' as const,
          expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          blacklistedAt: '2024-06-16T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Download Failed')).toBeInTheDocument();
      });
      expect(screen.getByText('Infrastructure Error')).toBeInTheDocument();
    });

    it('shows "Permanent" in expiry column for permanent entries', async () => {
      vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
      });
      const permanentLabels = screen.getAllByText('Permanent');
      expect(permanentLabels.length).toBeGreaterThanOrEqual(2);
    });

    it('shows human-readable "Expires in X days" for temporary entries', async () => {
      const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Temp Entry',
          reason: 'download_failed' as const,
          blacklistType: 'temporary' as const,
          expiresAt: futureDate,
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText(/Expires in/)).toBeInTheDocument();
      });
    });

    it('shows "Expired" for temporary entries with past expiry', async () => {
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Expired Entry',
          reason: 'download_failed' as const,
          blacklistType: 'temporary' as const,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Expired')).toBeInTheDocument();
      });
    });

    it('shows singular "Expires in 1 day" at one-day boundary', async () => {
      // Set expiry to ~12 hours from now — Math.ceil will round to 1 day
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Almost Expired Entry',
          reason: 'infrastructure_error' as const,
          blacklistType: 'temporary' as const,
          expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Expires in 1 day')).toBeInTheDocument();
      });
    });

    it('shows "Unknown" for entries with null reason (pre-migration)', async () => {
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Old Entry',
          reason: undefined,
          blacklistType: 'permanent' as const,
          expiresAt: null,
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Unknown')).toBeInTheDocument();
      });
    });
  });

  describe('toggle temporary/permanent', () => {
    it('toggle button switches temporary entry to permanent and UI updates', async () => {
      const { toast } = await import('sonner');
      const entries = [
        {
          id: 1,
          infoHash: 'abc123def456789',
          title: 'Temp Release',
          reason: 'download_failed' as const,
          blacklistType: 'temporary' as const,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          blacklistedAt: '2024-06-15T12:00:00Z',
        },
      ];
      vi.mocked(api.getBlacklist).mockResolvedValue(entries);
      vi.mocked(api.toggleBlacklistType).mockResolvedValue({ ...entries[0], blacklistType: 'permanent', expiresAt: null });
      const user = userEvent.setup();

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Temp Release')).toBeInTheDocument();
      });

      const toggleButton = screen.getByRole('button', { name: /Toggle Temp Release to permanent/ });
      await user.click(toggleButton);

      await waitFor(() => {
        expect(api.toggleBlacklistType).toHaveBeenCalledWith(1, 'permanent');
      });
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Blacklist entry updated');
      });
    });

    it('toggle button switches permanent entry to temporary and UI updates', async () => {
      const { toast } = await import('sonner');
      vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);
      vi.mocked(api.toggleBlacklistType).mockResolvedValue({ ...mockEntries[0], blacklistType: 'temporary' });
      const user = userEvent.setup();

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
      });

      const toggleButtons = screen.getAllByRole('button', { name: /Toggle .* to temporary/ });
      await user.click(toggleButtons[0]);

      await waitFor(() => {
        expect(api.toggleBlacklistType).toHaveBeenCalledWith(1, 'temporary');
      });
      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Blacklist entry updated');
      });
    });

    it('toggle success invalidates blacklist query cache', async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

      vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);
      vi.mocked(api.toggleBlacklistType).mockResolvedValue({ ...mockEntries[0], blacklistType: 'temporary' });
      const user = userEvent.setup();

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><BlacklistSettings /></MemoryRouter>
        </QueryClientProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
      });

      const toggleButtons = screen.getAllByRole('button', { name: /Toggle .* to temporary/ });
      await user.click(toggleButtons[0]);

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['blacklist'] });
      });
    });

    it('shows error toast when toggle API fails', async () => {
      const { toast } = await import('sonner');
      vi.mocked(api.getBlacklist).mockResolvedValue(mockEntries);
      vi.mocked(api.toggleBlacklistType).mockRejectedValue(new Error('Server error'));
      const user = userEvent.setup();

      renderWithProviders(<BlacklistSettings />);

      await waitFor(() => {
        expect(screen.getByText('Bad Release [Unabridged]')).toBeInTheDocument();
      });

      const toggleButtons = screen.getAllByRole('button', { name: /Toggle .* to temporary/ });
      await user.click(toggleButtons[0]);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to update blacklist entry');
      });
    });
  });
});
