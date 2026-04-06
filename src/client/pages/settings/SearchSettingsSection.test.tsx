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
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });
    expect(screen.getByText('Search Interval (minutes)')).toBeInTheDocument();
    expect(screen.queryByText('Auto-Grab Best Result')).not.toBeInTheDocument();
  });

  it('toggles search enabled checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    const checkbox = () => screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

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
      expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
    });

    const rssCheckbox = screen.getByText('Enable RSS Sync')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(rssCheckbox.checked).toBe(false);
    await user.click(rssCheckbox);
    expect(rssCheckbox.checked).toBe(true);
  });

  it('RSS interval input renders', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('RSS Interval (minutes)')).toBeInTheDocument();
    });
  });

  it('both search and RSS controls exist', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });
    expect(screen.getByText('Enable RSS Sync')).toBeInTheDocument();
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
      expect(screen.getByText('Blacklist TTL (days)')).toBeInTheDocument();
    });
  });

  it('has min=1 attribute on blacklist TTL', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Blacklist TTL (days)')).toHaveAttribute('min', '1');
    });
  });

  it('sends search and rss categories on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<SearchSettingsSection />);

    // Wait for settings to load and form to reset
    const checkbox = () => screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await waitFor(() => {
      expect(checkbox().checked).toBe(false);
    });

    // Toggle checkbox on to dirty the form so Save button appears
    await user.click(checkbox());

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: true, intervalMinutes: 360, blacklistTtlDays: 7 },
        rss: { enabled: false, intervalMinutes: 30 },
        quality: { protocolPreference: 'none' },
      });
    });
  });

  it('renders protocol preference dropdown with correct options', async () => {
    renderWithProviders(<SearchSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    });

    const options = screen.getByLabelText('Protocol Preference').querySelectorAll('option');
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
    const checkbox = () => screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await waitFor(() => {
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
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
      expect(screen.getByLabelText('Search Interval (minutes)')).toHaveValue(360);
    });

    const input = screen.getByLabelText('Search Interval (minutes)');
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
      expect(screen.getByLabelText('Blacklist TTL (days)')).toHaveValue(7);
    });

    const input = screen.getByLabelText('Blacklist TTL (days)');
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
      expect(screen.getByLabelText('RSS Interval (minutes)')).toHaveValue(30);
    });

    const input = screen.getByLabelText('RSS Interval (minutes)');
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
      expect(screen.getByLabelText('Blacklist TTL (days)')).toHaveValue(7);
    });

    const ttlInput = screen.getByLabelText('Blacklist TTL (days)');
    await user.tripleClick(ttlInput);
    await user.keyboard('14');

    const rssInput = screen.getByLabelText('RSS Interval (minutes)');
    await user.tripleClick(rssInput);
    await user.keyboard('60');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 14 },
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
      expect(screen.getByLabelText('Protocol Preference')).toHaveValue('torrent');
    });

    // Change to usenet
    await user.selectOptions(screen.getByLabelText('Protocol Preference'), 'usenet');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        search: { enabled: false, intervalMinutes: 360, blacklistTtlDays: 7 },
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
      expect(screen.getByText('Enable Scheduled Search')).toBeInTheDocument();
    });

    const checkbox = screen.getByText('Enable Scheduled Search')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await user.click(checkbox);

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });
});
