import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { BackupScheduleForm } from './BackupScheduleForm';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
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

describe('BackupScheduleForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
    });
  });

  it('renders interval and retention inputs with values from settings', async () => {
    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
      expect(screen.getByLabelText(/backup retention/i)).toHaveValue(7);
    });
  });

  it('calls updateSettings with system category on form submit', async () => {
    mockApi.updateSettings.mockResolvedValue({
      system: { backupIntervalMinutes: 10080, backupRetention: 7, dismissedUpdateVersion: '' },
    });

    renderWithProviders(<BackupScheduleForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/backup interval/i)).toHaveValue(10080);
    });

    // Submit the form directly to bypass isDirty gating
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        system: { backupIntervalMinutes: 10080, backupRetention: 7 },
      });
    });

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('System settings saved');
    });

    // Cache invalidation causes settings to be refetched
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

    // Submit the form directly
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });
});
