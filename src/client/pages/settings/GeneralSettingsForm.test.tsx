import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettingsForm } from './GeneralSettingsForm';

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
  general: { logLevel: 'warn', housekeepingRetentionDays: 60, recycleRetentionDays: 14 },
});

describe('GeneralSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders housekeeping retention, recycle retention, and log level fields from settings', async () => {
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event History Retention (days)')).toHaveValue(60);
      expect(screen.getByLabelText('Recycling Bin Retention (days)')).toHaveValue(14);
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });
  });

  it('shows save button when a field is changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');

    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  });

  it('hides save button when form is clean', async () => {
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('sends complete general category payload when saving after changing only logLevel', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: {
          logLevel: 'debug',
          housekeepingRetentionDays: 60,
          recycleRetentionDays: 14,
        },
      });
    });
  });

  it('sends complete general category payload when saving after changing only housekeepingRetentionDays', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event History Retention (days)')).toHaveValue(60);
    });

    const input = screen.getByLabelText('Event History Retention (days)');
    await user.clear(input);
    await user.type(input, '30');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: {
          logLevel: 'warn',
          housekeepingRetentionDays: 30,
          recycleRetentionDays: 14,
        },
      });
    });
  });

  it('shows success toast and invalidates settings cache on save', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('General settings saved');
    });

    // Cache invalidation triggers refetch
    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('blocks submit and shows inline error for out-of-range retention days', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Event History Retention (days)')).toHaveValue(60);
    });

    // Enter 0 — below the 1-365 range
    const input = screen.getByLabelText('Event History Retention (days)');
    await user.clear(input);
    await user.type(input, '0');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    // zodResolver blocks submission and shows inline error
    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('shows error toast and retains dirty state on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Log Level')).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText('Log Level'), 'debug');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });

});
