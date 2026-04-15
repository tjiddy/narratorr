import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { BackupScheduleForm } from './BackupScheduleForm';

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
  system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
});

describe('BackupScheduleForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders interval and retention inputs with values from settings', async () => {
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
      expect(screen.getByLabelText(/backup retention/i)).toHaveValue(7);
    });
  });

  it('hides save button when form is clean', async () => {
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('calls updateSettings with system category on form submit', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
    });

    // Direct form submit — number inputs can't be made dirty via userEvent in jsdom
    fireEvent.submit(screen.getByLabelText(/backup interval/i).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        system: { backupIntervalMinutes: 10080, backupRetention: 7 },
      });
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('System settings saved');
    });

    // Cache invalidation triggers refetch
    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows error toast when save fails', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup retention/i)).toHaveValue(7);
    });

    fireEvent.submit(screen.getByLabelText(/backup interval/i).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });

  it('zodResolver blocks invalid input and shows inline error', async () => {
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
    });

    // Set value below minimum (60) — zodResolver should reject
    fireEvent.change(screen.getByLabelText(/backup interval/i), { target: { value: '1' } });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText(/backup interval/i).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });
});
