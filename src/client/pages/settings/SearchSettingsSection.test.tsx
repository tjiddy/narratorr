import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
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
  quality: { protocolPreference: 'none' },
});

describe('SearchSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders search fields', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Scheduled search')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Search interval')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();
  });

  it('toggles search enabled checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    const checkbox = () => screen.getByLabelText('Scheduled search') as HTMLInputElement;

    // Wait for settings to load and reset form
    await waitFor(() => {
      expect(checkbox().checked).toBe(false);
    });

    await user.click(checkbox());
    expect(checkbox().checked).toBe(true);
  });

  it('RSS toggle renders and persists state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('RSS sync')).toBeInTheDocument();
    });

    const rssCheckbox = screen.getByLabelText('RSS sync') as HTMLInputElement;

    expect(rssCheckbox.checked).toBe(false);
    await user.click(rssCheckbox);
    expect(rssCheckbox.checked).toBe(true);
  });

  it('RSS interval input renders', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('RSS interval')).toBeInTheDocument();
    });
  });

  it('both search and RSS controls exist', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Scheduled search')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('RSS sync')).toBeInTheDocument();
  });

  it('describes that search includes grabbing', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/grab the best result/)).toBeInTheDocument();
    });
  });

  it('renders blacklist TTL input', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Blacklist TTL')).toBeInTheDocument();
    });
  });

  it('has min=1 attribute on blacklist TTL', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Blacklist TTL')).toHaveAttribute('min', '1');
    });
  });

  it('renders each number input with step="1"', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search interval')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Search interval').getAttribute('step')).toBe('1');
    expect(screen.getByLabelText('Blacklist TTL').getAttribute('step')).toBe('1');
    expect(screen.getByLabelText('RSS interval').getAttribute('step')).toBe('1');
  });

  it('sends search and rss categories on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for settings to load and form to reset
    const checkbox = () => screen.getByLabelText('Scheduled search') as HTMLInputElement;
    await waitFor(() => {
      expect(checkbox().checked).toBe(false);
    });

    // Toggle checkbox on to dirty the form so Save button appears
    await user.click(checkbox());

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: true, intervalMinutes: 360, blacklistTtlDays: 7, searchPriority: 'accuracy' },
        rss: { enabled: false, intervalMinutes: 30 },
        quality: { protocolPreference: 'none' },
      });
    });
  });

  it('renders protocol preference dropdown with correct options', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Protocol preference')).toBeInTheDocument();
    });

    const options = screen.getByLabelText('Protocol preference').querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('Prefer Usenet');
    expect(options[1]).toHaveTextContent('Prefer Torrent');
    expect(options[2]).toHaveTextContent('No Preference');
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for settings to load
    const checkbox = () => screen.getByLabelText('Scheduled search') as HTMLInputElement;
    await waitFor(() => {
      expect(checkbox()).toBeInTheDocument();
    });

    // Toggle checkbox on to dirty the form so Save button appears
    await user.click(checkbox());

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Search settings saved');
    });
  });

  it('rejects searchIntervalMinutes < 5', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search interval')).toHaveValue(360);
    });

    const input = screen.getByLabelText('Search interval');
    await user.tripleClick(input);
    await user.keyboard('4');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('rejects blacklistTtlDays < 1', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Blacklist TTL')).toHaveValue(7);
    });

    const input = screen.getByLabelText('Blacklist TTL');
    await user.tripleClick(input);
    await user.keyboard('0');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('rejects rssIntervalMinutes < 5', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('RSS interval')).toHaveValue(30);
    });

    const input = screen.getByLabelText('RSS interval');
    await user.tripleClick(input);
    await user.keyboard('4');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('sends edited numeric values in save payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Blacklist TTL')).toHaveValue(7);
    });

    const ttlInput = screen.getByLabelText('Blacklist TTL');
    await user.tripleClick(ttlInput);
    await user.keyboard('14');

    const rssInput = screen.getByLabelText('RSS interval');
    await user.tripleClick(rssInput);
    await user.keyboard('60');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 14, searchPriority: 'accuracy' },
        rss: { enabled: false, intervalMinutes: 60 },
        quality: { protocolPreference: 'none' },
      });
    });
  });

  it('loads non-default protocol preference and saves changed value', async () => {
    const torrentSettings = createMockSettings({
      search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
      rss: { enabled: false, intervalMinutes: 30 },
      quality: { protocolPreference: 'torrent' },
    });
    mockApi.getSettings.mockResolvedValue(torrentSettings);
    mockApi.updateSettings.mockResolvedValue(torrentSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for server value to load
    await waitFor(() => {
      expect(screen.getByLabelText('Protocol preference')).toHaveValue('torrent');
    });

    // Change to usenet
    await user.selectOptions(screen.getByLabelText('Protocol preference'), 'usenet');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7, searchPriority: 'accuracy' },
        rss: { enabled: false, intervalMinutes: 30 },
        quality: { protocolPreference: 'usenet' },
      });
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Scheduled search')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Scheduled search'));

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });

  describe('search priority dropdown (#439)', () => {
    it('renders search priority dropdown with both options and per-option descriptions', async () => {
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search priority')).toBeInTheDocument();
      });

      const options = screen.getByLabelText('Search priority').querySelectorAll('option');
      expect(options).toHaveLength(2);
      expect(options[0]).toHaveTextContent('Audio Quality');
      expect(options[1]).toHaveTextContent('Narrator Accuracy');

      expect(screen.getByText(/Prioritize higher bitrate releases/)).toBeInTheDocument();
      expect(screen.getByText(/Prioritize releases matching the narrator/)).toBeInTheDocument();
    });

    it('selecting quality and saving fires mutation with correct payload', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search priority')).toBeInTheDocument();
      });

      // 'accuracy' is the default, so select 'quality' to dirty the form
      await user.selectOptions(screen.getByLabelText('Search priority'), 'quality');

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            search: expect.objectContaining({ searchPriority: 'quality' }),
          }),
        );
      });
    });

    it('form loads with current saved searchPriority value', async () => {
      const accuracySettings = createMockSettings({
        search: { enabled: true, intervalMinutes: 360, blacklistTtlDays: 7, searchPriority: 'accuracy' },
      });
      mockApi.getSettings.mockResolvedValue(accuracySettings);
      renderWithProviders(<SearchSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search priority')).toHaveValue('accuracy');
      });
    });
  });
});
