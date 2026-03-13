import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
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
    });
    expect(screen.getByText('Minimum Seed Time (minutes)')).toBeInTheDocument();

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it('renders minimum free space field', async () => {
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Minimum Free Space (GB)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
  });

  it('allows changing minimum free space value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Free Space (GB)')).toHaveValue(5);
    });

    const input = screen.getByLabelText('Minimum Free Space (GB)');
    expect(input).toHaveValue(5);
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
      expect(screen.getByPlaceholderText('60')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByLabelText('Minimum Seed Time (minutes)');
    expect(seedTimeInput).toHaveValue(60);
    await user.tripleClick(seedTimeInput);
    await user.keyboard('120');
    expect(seedTimeInput).toHaveValue(120);
  });

  it('blocks submit when minSeedTime is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('60')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByPlaceholderText('60');
    await user.clear(seedTimeInput);
    await user.type(seedTimeInput, '-1');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('sends import category on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('60')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByPlaceholderText('60');
    await user.clear(seedTimeInput);
    await user.type(seedTimeInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        import: { deleteAfterImport: false, minSeedTime: 120, minFreeSpaceGB: 5 },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('60')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByPlaceholderText('60');
    await user.clear(seedTimeInput);
    await user.type(seedTimeInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Import settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<ImportSettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('60')).toHaveValue(60);
    });

    const seedTimeInput = screen.getByPlaceholderText('60');
    await user.clear(seedTimeInput);
    await user.type(seedTimeInput, '120');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });
});
