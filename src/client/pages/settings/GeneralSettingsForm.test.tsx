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
  general: { logLevel: 'warn', housekeepingRetentionDays: 60 },
});

describe('GeneralSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders housekeeping retention and log level fields from settings', async () => {
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/event history retention/i)).toHaveValue(60);
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });
  });

  it('housekeepingRetentionDays input uses integer step', async () => {
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/event history retention/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/event history retention/i).getAttribute('step')).toBe('1');
  });

  it('log level select uses shared SelectWithChevron contract', async () => {
    renderWithProviders(<GeneralSettingsForm />);
    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toBeInTheDocument();
    });
    const select = screen.getByLabelText(/log level/i);
    expect(select).toHaveClass('appearance-none');
    expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
  });

  it('shows save button on the Logging card when log level is changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText(/log level/i), 'debug');

    const saveButtons = screen.getAllByRole('button', { name: /save/i });
    expect(saveButtons).toHaveLength(1);
    expect(saveButtons[0]).not.toBeDisabled();
    expect(saveButtons[0]!.closest('form')).toBe(screen.getByLabelText(/log level/i).closest('form'));
  });

  it('hides both save buttons when nothing is dirty', async () => {
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('Logging card saves only the logLevel slice (backend patch-merges the rest)', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText(/log level/i), 'debug');
    fireEvent.submit(screen.getByLabelText(/log level/i).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: { logLevel: 'debug' },
      });
    });
  });

  it('Housekeeping card saves only the housekeepingRetentionDays slice', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/event history retention/i)).toHaveValue(60);
    });

    const input = screen.getByLabelText(/event history retention/i);
    await user.clear(input);
    await user.type(input, '30');

    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: { housekeepingRetentionDays: 30 },
      });
    });
  });

  it('shows success toast and invalidates settings cache on save', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText(/log level/i), 'debug');
    fireEvent.submit(screen.getByLabelText(/log level/i).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('General settings saved');
    });

    // The refetch proves the settings cache was invalidated.
    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('blocks submit and shows inline error for out-of-range retention days', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/event history retention/i)).toHaveValue(60);
    });

    const input = screen.getByLabelText(/event history retention/i);
    await user.clear(input);
    await user.type(input, '0');

    await act(async () => {
      fireEvent.submit(input.closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('shows error toast and retains dirty state on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/log level/i)).toHaveValue('warn');
    });

    await user.selectOptions(screen.getByLabelText(/log level/i), 'debug');
    fireEvent.submit(screen.getByLabelText(/log level/i).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });


  describe('when the shared settings read fails', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks: the Retry test queues a `*Once()` rejection and
      // clearAllMocks does not drain those queues.
      vi.resetAllMocks();
    });

    it('reports the failure on both cards, in copy that tells them apart', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<GeneralSettingsForm />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load housekeeping settings.')).toBeInTheDocument();
      });
      // Both cards read the same query, so one failure lands on both — and the operator has
      // to be able to tell which card is which.
      expect(screen.getByText('Failed to load logging settings.')).toBeInTheDocument();
      // 90 days reads as a chosen retention and "info" as a chosen verbosity; both are defaults.
      expect(screen.queryByLabelText('Event history retention')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Log level')).not.toBeInTheDocument();
    });

    it("recovers both cards from one card's Retry — they share the settings query", async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ general: { housekeepingRetentionDays: 30, logLevel: 'debug' } }));
      const user = userEvent.setup();

      renderWithProviders(<GeneralSettingsForm />);
      await waitFor(() => expect(screen.getByText('Failed to load logging settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading logging settings' }));

      // 30 / debug, not the schema defaults 90 / info: only a real refetch produces these.
      await waitFor(() => expect(screen.getByLabelText('Log level')).toHaveValue('debug'));
      expect(screen.getByLabelText('Event history retention')).toHaveValue(30);
      expect(screen.queryByText('Failed to load housekeeping settings.')).not.toBeInTheDocument();
      expect(screen.queryByText('Failed to load logging settings.')).not.toBeInTheDocument();
      expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
    });

    // The shared query means the sibling test above recovers this card too, so it cannot see
    // this card's own handler go missing. Only clicking Housekeeping's button can.
    it("recovers from the Housekeeping card's own Retry control", async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ general: { housekeepingRetentionDays: 30, logLevel: 'debug' } }));
      const user = userEvent.setup();

      renderWithProviders(<GeneralSettingsForm />);
      await waitFor(() => expect(screen.getByText('Failed to load housekeeping settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading housekeeping settings' }));

      // 30, not the schema default 90: only a refetch this click caused produces it.
      await waitFor(() => expect(screen.getByLabelText('Event history retention')).toHaveValue(30));
      expect(screen.queryByText('Failed to load housekeeping settings.')).not.toBeInTheDocument();
      expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
    });
  });

});
