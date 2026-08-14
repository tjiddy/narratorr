import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
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
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum seeders')).toBeInTheDocument();
  });

  it('does NOT render moved fields (protocol preference, reject/required words, preferred language)', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Protocol preference')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Reject words')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Required words')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Preferred Language')).not.toBeInTheDocument();
  });

  it('loads settings values into form', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });
    expect(screen.getByLabelText('Minimum seeders')).toHaveValue(3);
  });

  it('MB/hr input accepts decimal values', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Grab minimum')).toHaveAttribute('step', 'any');
  });

  it('min seeders input uses integer step', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum seeders')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Minimum seeders')).toHaveAttribute('step', '1');
  });

  it('blocks submit when grabFloor is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('Grab minimum');
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
      expect(screen.getByLabelText('Minimum seeders')).toHaveValue(3);
    });

    const input = screen.getByLabelText('Minimum seeders');
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
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('Grab minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        quality: { grabFloor: 100, minSeeders: 3, minDownloadSize: 50, maxDownloadSize: 5 },
      });
    });

    const callArg = mockApi.updateSettings.mock.calls[0]![0];
    expect(callArg.quality).not.toHaveProperty('protocolPreference');
    expect(callArg.quality).not.toHaveProperty('rejectWords');
    expect(callArg.quality).not.toHaveProperty('requiredWords');
    expect(callArg.quality).not.toHaveProperty('preferredLanguage');
    expect(callArg.quality).not.toHaveProperty('searchImmediately');
  });

  it('hides save button when form is not dirty', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('Grab minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Quality settings saved');
    });
  });

  it('max download size input accepts decimal values', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max download size')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Max download size')).toHaveAttribute('step', 'any');
  });

  it('renders max download size field', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max download size')).toBeInTheDocument();
    });
  });

  it('loads maxDownloadSize setting value into form', async () => {
    const settings = createMockSettings({ quality: { grabFloor: 50, minSeeders: 3, maxDownloadSize: 10 } });
    mockApi.getSettings.mockResolvedValue(settings);
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max download size')).toHaveValue(10);
    });
  });

  it('includes maxDownloadSize in save payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max download size')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Max download size');
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
      expect(screen.getByLabelText('Max download size')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Max download size');
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
      expect(screen.getByLabelText('Max download size')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

    const input = screen.getByLabelText('Max download size');
    await user.tripleClick(input);
    await user.keyboard('10');

    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('renders min download size field with MB unit suffix', async () => {
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Min download size')).toBeInTheDocument();
    });
    expect(screen.getByText('MB')).toBeInTheDocument();
  });

  it('loads minDownloadSize setting value into form', async () => {
    const settings = createMockSettings({ quality: { grabFloor: 50, minSeeders: 3, minDownloadSize: 50 } });
    mockApi.getSettings.mockResolvedValue(settings);
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Min download size')).toHaveValue(50);
    });
  });

  it('includes minDownloadSize in save payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Min download size')).toBeInTheDocument();
    });

    // Use 75 instead of the default 50 so Save renders and the payload path is exercised.
    const input = screen.getByLabelText('Min download size');
    await user.tripleClick(input);
    await user.keyboard('75');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: expect.objectContaining({ minDownloadSize: 75 }),
        }),
      );
    });
  });

  it('blocks submit when minDownloadSize is negative', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Min download size')).toBeInTheDocument();
    });

    const input = screen.getByLabelText('Min download size');
    await user.clear(input);
    await user.type(input, '-1');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/too small/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<QualitySettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Grab minimum')).toHaveValue(50);
    });

    const input = screen.getByLabelText('Grab minimum');
    await user.tripleClick(input);
    await user.keyboard('100');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });

  // #2338 retired the #2320 blast-radius pin that lived here ("renders its fields at their
  // defaults under a rejected settings read, with no error affordance"). That pinned the
  // pre-#2338 behaviour this issue deliberately inverts; the pair below replaces it.
  describe('when the shared settings read fails', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks: the tests below queue `*Once()` responses and
      // clearAllMocks does not drain those queues.
      vi.resetAllMocks();
    });

    it('reports the read failure instead of showing the schema defaults as saved thresholds', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<QualitySettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load quality settings.')).toBeInTheDocument();
      });
      // A 0 in Grab minimum reads as "no floor is configured"; that is the schema default,
      // not a value this card ever read from the server.
      expect(screen.queryByLabelText('Grab minimum')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Minimum seeders')).not.toBeInTheDocument();
    });

    it('refetches and shows the saved thresholds when the operator clicks Retry', async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ quality: { grabFloor: 77 } }));
      const user = userEvent.setup();

      renderWithProviders(<QualitySettingsSection />);
      await waitFor(() => expect(screen.getByText('Failed to load quality settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading quality settings' }));

      // 77, not the schema default 0: only a real refetch can produce this value.
      await waitFor(() => expect(screen.getByLabelText('Grab minimum')).toHaveValue(77));
      expect(screen.queryByText('Failed to load quality settings.')).not.toBeInTheDocument();
      expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
    });

    it('keeps rendering the form while the read is merely pending', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      let settle: ((value: unknown) => void) | undefined;
      mockApi.getSettings.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));

      renderWithProviders(<QualitySettingsSection />, { queryClient: client });

      // Observation point is the query's own non-terminal state, so this is not an
      // assertion that any implementation satisfies at t=0 by accident.
      expect(client.getQueryState(queryKeys.settings())?.status).toBe('pending');
      expect(screen.getByLabelText('Grab minimum')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load quality settings.')).not.toBeInTheDocument();

      await act(async () => { settle!(createMockSettings({ quality: { grabFloor: 77 } })); });

      await waitFor(() => expect(screen.getByLabelText('Grab minimum')).toHaveValue(77));
    });

    it('hides but does not destroy an in-flight draft when the post-save refetch fails', async () => {
      let settleSave: ((value: unknown) => void) | undefined;
      mockApi.getSettings.mockResolvedValueOnce(createMockSettings({ quality: { grabFloor: 50 } }));
      mockApi.updateSettings.mockReturnValueOnce(new Promise((resolve) => { settleSave = resolve; }));
      const user = userEvent.setup();

      renderWithProviders(<QualitySettingsSection />);
      await waitFor(() => expect(screen.getByLabelText('Grab minimum')).toHaveValue(50));

      await user.tripleClick(screen.getByLabelText('Grab minimum'));
      await user.keyboard('100');
      await user.click(screen.getByRole('button', { name: /save/i }));

      // Editing *while the save is in flight* is what makes the hook's drift path fire:
      // an ordinary save resets clean and would leave no draft for this test to protect.
      await user.tripleClick(screen.getByLabelText('Grab minimum'));
      await user.keyboard('125');

      mockApi.getSettings.mockRejectedValueOnce(new Error('settings unreadable'));
      await act(async () => { settleSave!(createMockSettings({ quality: { grabFloor: 100 } })); });

      await waitFor(() => expect(screen.getByText('Failed to load quality settings.')).toBeInTheDocument());
      expect(screen.queryByLabelText('Grab minimum')).not.toBeInTheDocument();

      mockApi.getSettings.mockResolvedValue(createMockSettings({ quality: { grabFloor: 100 } }));
      await user.click(screen.getByRole('button', { name: 'Retry loading quality settings' }));

      // 125 (the draft), not the server's 100: the gate hides the draft, it does not clobber it.
      await waitFor(() => expect(screen.getByLabelText('Grab minimum')).toHaveValue(125));
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      expect(screen.queryByText('Failed to load quality settings.')).not.toBeInTheDocument();
    });
  });
});
