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
  quality: { grabFloor: 50, minSeeders: 3 },
});

describe('QualitySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders MB/hr minimum and min seeders fields', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Seeders')).toBeInTheDocument();
  });

  it('does NOT render moved fields (protocol preference, reject/required words, preferred language)', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Protocol Preference')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reject Words')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Required Words')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preferred Language')).not.toBeInTheDocument();
  });

  it('loads settings values into form', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });
    expect(screen.getByLabelText('Minimum Seeders')).toHaveValue(3);
  });

  it('MB/hr input accepts decimal values', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveAttribute('step', 'any');
  });

  it('min seeders input uses integer step', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seeders')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Seeders')).toHaveAttribute('step', '1');
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

  it('blocks submit when minSeeders is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seeders')).toHaveValue(3);
    });

    const input = screen.getByLabelText('Minimum Seeders');
    await user.clear(input);
    await user.type(input, '-1');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('saves payload with only quality gate fields', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('MB/hr Grab Minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        quality: { grabFloor: 100, minSeeders: 3, maxDownloadSize: 5 },
      });
    });

    // Verify no extra fields leak into the payload
    const callArg = mockApi.updateSettings.mock.calls[0][0];
    expect(callArg.quality).not.toHaveProperty('protocolPreference');
    expect(callArg.quality).not.toHaveProperty('rejectWords');
    expect(callArg.quality).not.toHaveProperty('requiredWords');
    expect(callArg.quality).not.toHaveProperty('preferredLanguage');
    expect(callArg.quality).not.toHaveProperty('searchImmediately');
    expect(callArg.quality).not.toHaveProperty('monitorForUpgrades');
  });

  it('hides save button when form is not dirty', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('MB/hr Grab Minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Quality settings saved');
    });
  });

  it('renders max download size field', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Download Size (GB)')).toBeInTheDocument();
    });
  });

  it('loads maxDownloadSize setting value into form', async () => {
    const settings = createMockSettings({ quality: { grabFloor: 50, minSeeders: 3, maxDownloadSize: 10 } });
    mockApi.getSettings.mockResolvedValue(settings);
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Download Size (GB)')).toHaveValue(10);
    });
  });

  it('includes maxDownloadSize in save payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Download Size (GB)')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Max Download Size (GB)');
    await user.tripleClick(input);
    await user.keyboard('10');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: expect.objectContaining({ maxDownloadSize: 10 }),
        }),
      );
    });
  });

  it('blocks submit when maxDownloadSize is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Download Size (GB)')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Max Download Size (GB)');
    await user.clear(input);
    await user.type(input, '-1');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('tracks dirty state when maxDownloadSize changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Download Size (GB)')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

    const input = screen.getByLabelText('Max Download Size (GB)');
    await user.tripleClick(input);
    await user.keyboard('10');

    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('MB/hr Grab Minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('MB/hr Grab Minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });
});
