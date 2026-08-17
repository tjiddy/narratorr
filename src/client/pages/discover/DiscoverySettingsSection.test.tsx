import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { DiscoverySettingsSection } from './DiscoverySettingsSection';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
  ApiError: class extends Error {
    status: number;
    body: unknown;
    constructor(s: number, b: unknown) { super(`HTTP ${s}`); this.status = s; this.body = b; }
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

// The schema default is `enabled: true`; a fetched `false` is what makes "the card renders saved
// config, not defaults" observable at all.
beforeEach(() => {
  vi.resetAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings({ discovery: { enabled: false } }));
});

describe('DiscoverySettingsSection', () => {
  it('renders enable/disable toggle, interval input, max-per-author input', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Discovery')).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/refresh interval/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/max suggestions per author/i)).toBeInTheDocument();
  });

  it('toggling enable/disable persists via settings mutation', async () => {
    mockApi.updateSettings.mockResolvedValue(createMockSettings({ discovery: { enabled: true } }));

    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText(/enable discovery/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        discovery: expect.objectContaining({ enabled: true }),
      });
    });
  });

  it('changing interval value persists via settings mutation', async () => {
    mockApi.updateSettings.mockResolvedValue(createMockSettings({ discovery: { enabled: false, intervalHours: 12 } }));

    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/refresh interval/i)).toBeInTheDocument();
    });

    const intervalInput = screen.getByLabelText(/refresh interval/i);
    await userEvent.clear(intervalInput);
    await userEvent.type(intervalInput, '12');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        discovery: expect.objectContaining({ intervalHours: 12 }),
      });
    });
  });

  it('save button is hidden when form is not dirty', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Discovery')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('does not submit invalid interval value (zero)', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/refresh interval/i)).toBeInTheDocument();
    });

    const intervalInput = screen.getByLabelText(/refresh interval/i);
    await userEvent.clear(intervalInput);
    await userEvent.type(intervalInput, '0');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('does not submit when maxSuggestionsPerAuthor is 0 (below min)', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/max suggestions per author/i)).toBeInTheDocument();
    });

    const maxInput = screen.getByLabelText(/max suggestions per author/i);
    await userEvent.clear(maxInput);
    await userEvent.type(maxInput, '0');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('does not submit when maxSuggestionsPerAuthor is 51 (above max)', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/max suggestions per author/i)).toBeInTheDocument();
    });

    const maxInput = screen.getByLabelText(/max suggestions per author/i);
    await userEvent.clear(maxInput);
    await userEvent.type(maxInput, '51');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('save success invalidates settings cache, resets dirty state, and shows success toast', async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    mockApi.updateSettings.mockResolvedValue(createMockSettings({ discovery: { enabled: true } }));

    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText(/enable discovery/i));
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Discovery settings saved');
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    invalidateSpy.mockRestore();
  });

  describe('expiryDays field', () => {
    it('renders expiry days input with default value', async () => {
      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/suggestion expiry/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText(/suggestion expiry/i)).toHaveValue(90);
    });

    it('changing expiry days persists via settings mutation', async () => {
      mockApi.updateSettings.mockResolvedValue(createMockSettings({
        discovery: { enabled: false, expiryDays: 60 },
      }));

      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/suggestion expiry/i)).toBeInTheDocument();
      });

      const expiryInput = screen.getByLabelText(/suggestion expiry/i);
      await userEvent.clear(expiryInput);
      await userEvent.type(expiryInput, '60');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          discovery: expect.objectContaining({ expiryDays: 60 }),
        });
      });
    });

    it('does not submit when expiryDays is 0 (below min)', async () => {
      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/suggestion expiry/i)).toBeInTheDocument();
      });

      const expiryInput = screen.getByLabelText(/suggestion expiry/i);
      await userEvent.clear(expiryInput);
      await userEvent.type(expiryInput, '0');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });
  });

  it('renders Enable Discovery toggle as a hidden-checkbox slider (sr-only peer pattern)', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    });

    const checkbox = screen.getByLabelText(/enable discovery/i);
    expect(checkbox).toHaveClass('sr-only');
    // ToggleSwitch places its visual track immediately after the hidden checkbox.
    const sliderTrack = checkbox.nextElementSibling as HTMLElement | null;
    expect(sliderTrack).toBeInTheDocument();
    expect(sliderTrack!.tagName).toBe('DIV');
    expect(sliderTrack).toHaveClass('rounded-full');
  });

  it('save failure shows error toast', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Server error'));

    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByLabelText(/enable discovery/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Server error');
    });
  });

  it('renders each number input with step="1"', async () => {
    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/refresh interval/i)).toBeInTheDocument();
    });

    expect(screen.getByLabelText(/refresh interval/i).getAttribute('step')).toBe('1');
    expect(screen.getByLabelText(/max suggestions per author/i).getAttribute('step')).toBe('1');
    expect(screen.getByLabelText(/suggestion expiry/i).getAttribute('step')).toBe('1');
  });

  it('#514 shows destructive border on each invalid numeric input', async () => {
    const user = userEvent.setup();

    const fields = [
      { label: /refresh interval/i },
      { label: /max suggestions per author/i },
      { label: /suggestion expiry/i },
    ];

    for (const { label } of fields) {
      const { unmount } = renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(label)).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText(/enable discovery/i));

      const input = screen.getByLabelText(label);

      expect(input.className).toContain('border-border');
      expect(input.className).not.toContain('border-destructive');

      await user.clear(input);
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(input.className).toContain('border-destructive');
      });

      unmount();
    }
  });

  describe('when the shared settings read fails', () => {
    it('reports the read failure instead of showing the defaults as saved discovery config', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load discovery settings.')).toBeInTheDocument();
      });
      // A 24-hour refresh reads as the operator's cadence; it is the schema default.
      expect(screen.queryByLabelText(/enable discovery/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/refresh interval/i)).not.toBeInTheDocument();
    });

    it('refetches and restores the saved discovery config when the operator clicks Retry', async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ discovery: { enabled: true, intervalHours: 72 } }));
      const user = userEvent.setup();

      renderWithProviders(<DiscoverySettingsSection />);
      await waitFor(() => expect(screen.getByText('Failed to load discovery settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading discovery settings' }));

      // 72, not the schema default 24: only a real refetch produces this value.
      await waitFor(() => expect(screen.getByLabelText(/refresh interval/i)).toHaveValue(72));
      expect(screen.queryByText('Failed to load discovery settings.')).not.toBeInTheDocument();
      expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
    });
  });

});
