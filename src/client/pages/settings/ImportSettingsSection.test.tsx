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
  import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 5 },
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
      expect(screen.getByText(/Set to 0 to disable/)).toBeInTheDocument();
    });
  });

  it('allows changing the minimum seed time', async () => {
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
    mockApi.updateSettings.mockResolvedValue(mockSettings);
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
    mockApi.updateSettings.mockResolvedValue(mockSettings);
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
        import: { deleteAfterImport: false, minSeedTime: 120, minFreeSpaceGB: 5, redownloadFailed: true },
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
        import: { deleteAfterImport: false, minSeedTime: 60, minFreeSpaceGB: 10, redownloadFailed: true },
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
        import: expect.objectContaining({ redownloadFailed: false }),
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
});
