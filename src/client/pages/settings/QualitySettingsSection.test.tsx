import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { QualitySettingsSection } from './QualitySettingsSection';

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
  quality: {
    grabFloor: 50,
    protocolPreference: 'usenet',
    minSeeders: 3,
    rejectWords: 'German',
    requiredWords: 'M4B',
  },
});

describe('QualitySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders all quality fields', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    expect(screen.getByLabelText('Minimum Seeders')).toBeInTheDocument();
    expect(screen.getByLabelText('Reject Words')).toBeInTheDocument();
    expect(screen.getByLabelText('Required Words')).toBeInTheDocument();
    expect(screen.getByLabelText('Preferred Language')).toBeInTheDocument();
  });

  it('protocol preference select uses shared SelectWithChevron contract', async () => {
    renderWithProviders(<QualitySettingsSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    });
    const select = screen.getByLabelText('Protocol Preference');
    expect(select).toHaveClass('appearance-none');
    expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
  });

  it('protocol preference select has all three options', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Protocol Preference')).toBeInTheDocument();
    });

    expect(screen.getByText('No Preference')).toBeInTheDocument();
    expect(screen.getByText('Prefer Usenet')).toBeInTheDocument();
    expect(screen.getByText('Prefer Torrent')).toBeInTheDocument();
  });

  it('loads settings values into form', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });
    expect(screen.getByLabelText('Minimum Seeders')).toHaveValue(3);
    expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    expect(screen.getByLabelText('Required Words')).toHaveValue('M4B');
    expect(screen.getByLabelText('Protocol Preference')).toHaveValue('usenet');
    expect(screen.getByLabelText('Preferred Language')).toHaveValue('');
  });

  it('blocks submit when grabFloor is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('MB/hr Grab Minimum');
    await user.clear(input);
    await user.type(input, '-1');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('sends quality category on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    // Make form dirty by changing a value
    const user = userEvent.setup();
    const rejectInput = screen.getByLabelText('Reject Words');
    await user.clear(rejectInput);
    await user.type(rejectInput, 'Abridged');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        quality: {
          grabFloor: 50,
          protocolPreference: 'usenet',
          minSeeders: 3,
          rejectWords: 'Abridged',
          requiredWords: 'M4B',
          preferredLanguage: '',
        },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const user = userEvent.setup();
    const input = screen.getByLabelText('Reject Words');
    await user.clear(input);
    await user.type(input, 'test');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Quality settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const user = userEvent.setup();
    const input = screen.getByLabelText('Reject Words');
    await user.clear(input);
    await user.type(input, 'test');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });

  describe('after toggle relocation (#265)', () => {
    it('does NOT render Search Immediately toggle', async () => {
      renderWithProviders(<QualitySettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
      });
      expect(screen.queryByLabelText('Search Immediately')).not.toBeInTheDocument();
    });

    it('does NOT render Monitor for Upgrades toggle', async () => {
      renderWithProviders(<QualitySettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
      });
      expect(screen.queryByLabelText('Monitor for Upgrades')).not.toBeInTheDocument();
    });

    it('does NOT render Defaults for New Books subsection heading', async () => {
      renderWithProviders(<QualitySettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
      });
      expect(screen.queryByText('Defaults for New Books')).not.toBeInTheDocument();
      expect(screen.queryByText('When a New Book Is Added')).not.toBeInTheDocument();
    });

    it('save payload excludes searchImmediately and monitorForUpgrades', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<QualitySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
      });

      const user = userEvent.setup();
      const rejectInput = screen.getByLabelText('Reject Words');
      await user.clear(rejectInput);
      await user.type(rejectInput, 'Abridged');

      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalled();
      });

      const callArg = mockApi.updateSettings.mock.calls[0][0];
      expect(callArg.quality).not.toHaveProperty('searchImmediately');
      expect(callArg.quality).not.toHaveProperty('monitorForUpgrades');
    });
  });
});
