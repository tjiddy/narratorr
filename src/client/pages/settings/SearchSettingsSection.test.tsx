import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { SearchSettingsSection } from './SearchSettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const mockSettings = createMockSettings({
  search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
  rss: { enabled: false, intervalMinutes: 30 },
});

describe('SearchSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders search fields without auto-grab toggle', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for mock data to populate form (search.enabled = false from mock)
    await waitFor(() => {
      expect(screen.getByLabelText('Enable Scheduled Search')).not.toBeChecked();
    });
    expect(screen.getByText('Search Interval (minutes)')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();

    const checkbox = screen.getByLabelText('Enable Scheduled Search');
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('toggles search enabled checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Mock has search.enabled = false — wait for the form to reset with mock data
    await waitFor(() => {
      expect(screen.getByLabelText('Enable Scheduled Search')).not.toBeChecked();
    });

    const checkbox = screen.getByLabelText('Enable Scheduled Search');
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('RSS toggle renders and persists state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
    });

    const rssCheckbox = screen.getByLabelText('Enable RSS Sync');
    expect(rssCheckbox).not.toBeChecked();
    await user.click(rssCheckbox);
    expect(rssCheckbox).toBeChecked();
  });

  it('RSS interval input renders and accepts value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('RSS Interval (minutes)')).toBeInTheDocument();
    });

    const rssIntervalInput = screen.getByPlaceholderText('30');
    await user.clear(rssIntervalInput);
    await user.type(rssIntervalInput, '60');
    expect(rssIntervalInput).toHaveValue(60);
  });

  it('RSS controls are separate from existing scheduled search controls', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });

    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('360')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('30')).toBeInTheDocument();
  });

  it('describes that search includes grabbing', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/grab the best result/)).toBeInTheDocument();
    });
  });

  describe('Blacklist TTL setting', () => {
    it('renders TTL input field with label and default value', async () => {
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Blacklist TTL (days)')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('7')).toBeInTheDocument();
    });

    it('accepts positive integer value for TTL days', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('7')).toHaveValue(7);
      });

      const ttlInput = screen.getByPlaceholderText('7');
      await user.clear(ttlInput);
      await user.type(ttlInput, '14');
      expect(ttlInput).toHaveValue(14);
    });

    it('has min=1 attribute to prevent TTL < 1', async () => {
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('7')).toBeInTheDocument();
      });

      expect(screen.getByPlaceholderText('7')).toHaveAttribute('min', '1');
    });
  });

  it('blocks submit when search interval is below minimum', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('360')).toHaveValue(360);
    });

    // Enter 4 — below the 5-1440 range
    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '4');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('blocks submit when blacklist TTL is below minimum', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('7')).toHaveValue(7);
    });

    // Enter 0 — below the 1-365 range
    const ttlInput = screen.getByPlaceholderText('7');
    await user.clear(ttlInput);
    await user.type(ttlInput, '0');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('blocks submit when RSS interval is below minimum', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('30')).toHaveValue(30);
    });

    // Enter 4 — below the 5-1440 range
    const rssInput = screen.getByPlaceholderText('30');
    await user.clear(rssInput);
    await user.type(rssInput, '4');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('sends search and rss categories on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for mock data to populate (search.enabled = false from mock)
    await waitFor(() => {
      expect(screen.getByLabelText('Enable Scheduled Search')).not.toBeChecked();
    });

    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: false, intervalMinutes: 120, blacklistTtlDays: 7 },
        rss: { enabled: false, intervalMinutes: 30 },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('360')).toHaveValue(360);
    });

    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Search settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('360')).toHaveValue(360);
    });

    const intervalInput = screen.getByPlaceholderText('360');
    await user.clear(intervalInput);
    await user.type(intervalInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });
});
