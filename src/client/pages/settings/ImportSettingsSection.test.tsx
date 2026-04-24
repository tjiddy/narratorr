import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { ImportSettingsSection } from './ImportSettingsSection';

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
  import: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5 },
});

describe('ImportSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders all import fields and toggles delete checkbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Delete After Import')).toBeInTheDocument();
      expect(screen.getByText('Minimum Seed Time (minutes)')).toBeInTheDocument();
    });

    const checkbox = screen.getByText('Delete After Import')
      .closest('div')!.parentElement!.querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(checkbox.checked).toBe(false);
    await user.click(checkbox);
    expect(checkbox.checked).toBe(true);
  });

  it('renders minimum free space field with value from settings', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });
  });

  it('allows changing minimum free space value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });

    const input = screen.getByLabelText('Minimum Free Space (GB)');
    await user.tripleClick(input);
    await user.keyboard('10');
    expect(input).toHaveValue(10);
  });

  it('shows helper text for free space field', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/Block imports when free disk space/)).toBeInTheDocument();
    });
  });

  it('minimum free space input accepts decimal values', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveAttribute('step', 'any');
  });

  it('minimum seed time input uses integer step', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toHaveAttribute('step', '1');
  });

  it('allows changing the minimum seed time', async () => {
    const enabledSettings = createMockSettings({
      import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
    });
    mockApi.getSettings.mockResolvedValue(enabledSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByLabelText('Minimum Seed Time (minutes)');
    await user.tripleClick(seedTimeInput);
    await user.keyboard('120');
    expect(seedTimeInput).toHaveValue(120);
  });

  it('rejects minSeedTime < 0', async () => {
    const enabledSettings = createMockSettings({
      import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
    });
    mockApi.getSettings.mockResolvedValue(enabledSettings);
    mockApi.updateSettings.mockResolvedValue(enabledSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toHaveValue(60);
    });

    const input = screen.getByLabelText('Minimum Seed Time (minutes)');
    await user.tripleClick(input);
    await user.keyboard('-1');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('sends edited minSeedTime in save payload', async () => {
    const enabledSettings = createMockSettings({
      import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
    });
    mockApi.getSettings.mockResolvedValue(enabledSettings);
    mockApi.updateSettings.mockResolvedValue(enabledSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toHaveValue(60);
    });

    const input = screen.getByLabelText('Minimum Seed Time (minutes)');
    await user.tripleClick(input);
    await user.keyboard('120');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        import: { deleteAfterImport: true, minSeedTime: 120, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
    });
  });

  it('sends import category payload on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });

    // Change a value to dirty the form so Save button appears
    const input = screen.getByLabelText('Minimum Free Space (GB)');
    await user.tripleClick(input);
    await user.keyboard('10');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        import: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 10, redownloadFailed: true },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });

    // Change a value to dirty the form so Save button appears
    const input = screen.getByLabelText('Minimum Free Space (GB)');
    await user.tripleClick(input);
    await user.keyboard('10');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Import settings saved');
    });
  });

  it('shows Redownload Failed toggle with correct description text', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Redownload Failed')).toBeInTheDocument();
      expect(screen.getByText('Automatically search for and attempt to download a different release when a download fails')).toBeInTheDocument();
    });
  });

  it('Redownload Failed toggle is checked by default (redownloadFailed: true)', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Redownload Failed')).toBeInTheDocument();
    });

    const checkbox = screen.getByLabelText('Redownload Failed') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('toggling Redownload Failed off and saving calls updateSettings with redownloadFailed: false', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Redownload Failed')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Redownload Failed'));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        import: { deleteAfterImport: false, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: false },
      });
    });
  });

  describe('field order', () => {
    it('renders fields in order: Delete After Import → Minimum Seed Time → Minimum Seed Ratio → Redownload Failed → Minimum Free Space', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Delete After Import')).toBeInTheDocument();
      });

      const form = screen.getByText('Delete After Import').closest('form')!;
      const labels = Array.from(form.querySelectorAll('label[for]')).map(
        (el) => el.getAttribute('for'),
      );

      const deleteIdx = labels.indexOf('deleteAfterImport');
      const seedIdx = labels.indexOf('minSeedTime');
      const ratioIdx = labels.indexOf('minSeedRatio');
      const redownloadIdx = labels.indexOf('redownloadFailed');
      const freeSpaceIdx = labels.indexOf('minFreeSpaceGB');

      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(seedIdx).toBeGreaterThan(deleteIdx);
      expect(ratioIdx).toBeGreaterThan(seedIdx);
      expect(redownloadIdx).toBeGreaterThan(ratioIdx);
      expect(freeSpaceIdx).toBeGreaterThan(redownloadIdx);
    });
  });

  describe('seed time disabled state', () => {
    it('seed time input is disabled when deleteAfterImport is off (default)', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
    });

    it('seed time input is enabled when deleteAfterImport is on', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });
    });

    it('toggling delete off disables seed time', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });

      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
      });
    });

    it('toggling delete on enables seed time', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
      });

      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });
    });

    it('shows validation error when invalid minSeedTime exists and field is disabled', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      mockApi.updateSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });

      // Enter invalid value
      const input = screen.getByLabelText('Minimum Seed Time (minutes)');
      await user.tripleClick(input);
      await user.keyboard('-1');

      // Toggle delete off — field becomes disabled
      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
      });

      // Try to save — should not call updateSettings (validation blocks it)
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });

      // Validation error should still be visible even though the field is disabled
      expect(screen.getByText(/Too small/i)).toBeInTheDocument();
    });

    it('preserves edited minSeedTime in save payload when field is disabled', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      mockApi.updateSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });

      // Edit minSeedTime
      const input = screen.getByLabelText('Minimum Seed Time (minutes)');
      await user.tripleClick(input);
      await user.keyboard('120');

      // Toggle delete off — seed time becomes disabled
      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
      });

      // Save — should include the edited minSeedTime value
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          import: { deleteAfterImport: false, minSeedTime: 120, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
        });
      });
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });

    const input = screen.getByLabelText('Minimum Free Space (GB)');
    await user.clear(input);
    await user.type(input, '10');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });

  // #318 — Minimum Seed Ratio field
  describe('seed ratio field rendering', () => {
    it('renders Minimum Seed Ratio field below Minimum Seed Time', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toBeInTheDocument();
      });

      const allLabels = screen.getAllByText(/Minimum Seed/);
      const seedTimeIdx = allLabels.findIndex(el => el.textContent?.includes('Time'));
      const seedRatioIdx = allLabels.findIndex(el => el.textContent === 'Minimum Seed Ratio');
      expect(seedRatioIdx).toBeGreaterThan(seedTimeIdx);
    });

    it('renders helper text', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText(/Minimum upload ratio before removing/)).toBeInTheDocument();
      });
    });

    it('ratio input has step="0.1" for fractional values', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Minimum Seed Ratio')).toHaveAttribute('step', '0.1');
    });

    it('rejects negative minSeedRatio via form validation', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      mockApi.updateSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).not.toBeDisabled();
      });

      const input = screen.getByLabelText('Minimum Seed Ratio');
      await user.tripleClick(input);
      await user.keyboard('-1');
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        // Validation should prevent the API call
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });

    it('sends minSeedRatio in save payload with correct numeric value', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      mockApi.updateSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toHaveValue(0);
      });

      const input = screen.getByLabelText('Minimum Seed Ratio');
      await user.tripleClick(input);
      await user.keyboard('1.5');
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          import: expect.objectContaining({ minSeedRatio: 1.5 }),
        });
      });
    });
  });

  describe('seed ratio disabled state', () => {
    it('seed ratio input is disabled when deleteAfterImport is off (default)', async () => {
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Minimum Seed Ratio')).toBeDisabled();
    });

    it('seed ratio input is enabled when deleteAfterImport is on', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).not.toBeDisabled();
      });
    });

    it('toggling delete off disables both seed time and seed ratio fields', async () => {
      const enabledSettings = createMockSettings({
        import: { deleteAfterImport: true, minSeedTime: 60, minSeedRatio: 0, minFreeSpaceGB: 5, redownloadFailed: true },
      });
      mockApi.getSettings.mockResolvedValue(enabledSettings);
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).not.toBeDisabled();
      });

      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toBeDisabled();
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).toBeDisabled();
      });
    });

    it('toggling delete on enables both seed time and seed ratio fields', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ImportSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).toBeDisabled();
      });

      await user.click(screen.getByLabelText('Delete After Import'));

      await waitFor(() => {
        expect(screen.getByLabelText('Minimum Seed Ratio')).not.toBeDisabled();
        expect(screen.getByLabelText('Minimum Seed Time (minutes)')).not.toBeDisabled();
      });
    });
  });
});
