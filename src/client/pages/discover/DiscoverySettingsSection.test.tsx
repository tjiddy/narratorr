import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
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

import { api } from '@/lib/api';
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

function makeSettings(overrides = {}) {
  return {
    discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5, expiryDays: 90, snoozeDays: 30 },
    library: { rootFolder: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{title}' },
    search: { enabled: true, intervalMinutes: 30, blacklistTtlDays: 30 },
    import: { deleteAfterImport: false, importMode: 'copy' as const },
    general: { logLevel: 'info' as const },
    metadata: { provider: 'audible' as const, region: 'us' },
    processing: { ffmpegPath: '/usr/bin/ffmpeg', filePermissions: '644', folderPermissions: '755', enableRetagging: false },
    tagging: { writeTags: false, tags: [], clearExistingTags: false },
    quality: {},
    network: {},
    rss: { enabled: false, intervalMinutes: 30 },
    system: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockApi.getSettings.mockResolvedValue(makeSettings());
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
    mockApi.updateSettings.mockResolvedValue(makeSettings({ discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 } }));

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
    mockApi.updateSettings.mockResolvedValue(makeSettings({ discovery: { enabled: false, intervalHours: 12, maxSuggestionsPerAuthor: 5 } }));

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

    // Form should not submit with invalid value
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
    vi.mock('sonner', () => ({
      toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    }));
    const { toast } = await import('sonner');

    const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');

    mockApi.updateSettings.mockResolvedValue(makeSettings({
      discovery: { enabled: true, intervalHours: 24, maxSuggestionsPerAuthor: 5 },
    }));

    renderWithProviders(<DiscoverySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText(/enable discovery/i)).toBeInTheDocument();
    });

    // Make the form dirty
    await userEvent.click(screen.getByLabelText(/enable discovery/i));
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();

    // Submit
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Discovery settings saved');
    });

    // Settings cache must be invalidated so other consumers refetch
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['settings'] });

    // Save button should disappear (form is no longer dirty after reset)
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    invalidateSpy.mockRestore();
  });

  // --- #408: Expiry & Snooze settings fields ---

  describe('expiryDays field', () => {
    it('renders expiry days input with default value', async () => {
      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/suggestion expiry/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText(/suggestion expiry/i)).toHaveValue(90);
    });

    it('changing expiry days persists via settings mutation', async () => {
      mockApi.updateSettings.mockResolvedValue(makeSettings({
        discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5, expiryDays: 60, snoozeDays: 30 },
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

  describe('snoozeDays field', () => {
    it('renders snooze days input with default value', async () => {
      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/default snooze duration/i)).toBeInTheDocument();
      });

      expect(screen.getByLabelText(/default snooze duration/i)).toHaveValue(30);
    });

    it('changing snooze days persists via settings mutation', async () => {
      mockApi.updateSettings.mockResolvedValue(makeSettings({
        discovery: { enabled: false, intervalHours: 24, maxSuggestionsPerAuthor: 5, expiryDays: 90, snoozeDays: 14 },
      }));

      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/default snooze duration/i)).toBeInTheDocument();
      });

      const snoozeInput = screen.getByLabelText(/default snooze duration/i);
      await userEvent.clear(snoozeInput);
      await userEvent.type(snoozeInput, '14');
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          discovery: expect.objectContaining({ snoozeDays: 14 }),
        });
      });
    });

    it('does not submit when snoozeDays is 0 (below min)', async () => {
      renderWithProviders(<DiscoverySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText(/default snooze duration/i)).toBeInTheDocument();
      });

      const snoozeInput = screen.getByLabelText(/default snooze duration/i);
      await userEvent.clear(snoozeInput);
      await userEvent.type(snoozeInput, '0');
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
    // Checkbox must be visually hidden (sr-only) — not a raw visible checkbox
    expect(checkbox).toHaveClass('sr-only');
    // Visual slider track div must be rendered immediately after the hidden checkbox
    const sliderTrack = checkbox.nextElementSibling as HTMLElement | null;
    expect(sliderTrack).toBeInTheDocument();
    expect(sliderTrack!.tagName).toBe('DIV');
    expect(sliderTrack).toHaveClass('rounded-full');
  });

  it('save failure shows error toast', async () => {
    vi.mock('sonner', () => ({
      toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
    }));
    const { toast } = await import('sonner');

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
});
