import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { MetadataSettingsSection } from './MetadataSettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testHardcoverApiKey: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  testHardcoverApiKey: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

describe('MetadataSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], hardcoverApiKey: '' },
      }),
    );
  });

  it('renders both audibleRegion select and hardcoverApiKey input', async () => {
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Hardcover API Key')).toBeInTheDocument();
  });

  it('renders stored key as masked sentinel', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], hardcoverApiKey: '********' },
      }),
    );
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('********');
    });
  });

  it('Test button is disabled when input is empty', async () => {
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const testButton = screen.getByRole('button', { name: /test/i });
    expect(testButton).toBeDisabled();
  });

  it('Test button is disabled for whitespace-only input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toBeInTheDocument();
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, '   ');
    const testButton = screen.getByRole('button', { name: /test/i });
    expect(testButton).toBeDisabled();
  });

  it('Test button enables when user types a non-empty value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toBeInTheDocument();
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'my-new-key');
    const testButton = screen.getByRole('button', { name: /test/i });
    expect(testButton).not.toBeDisabled();
  });

  it('clicking Test with typed plaintext sends the plaintext to api.testHardcoverApiKey', async () => {
    mockApi.testHardcoverApiKey.mockResolvedValue({ success: true, message: 'Connected.' });
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'my-new-key');
    await user.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockApi.testHardcoverApiKey).toHaveBeenCalledWith('my-new-key');
    });
  });

  it('saved-sentinel passthrough: with stored key, Test enabled and submits the sentinel', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], hardcoverApiKey: '********' },
      }),
    );
    mockApi.testHardcoverApiKey.mockResolvedValue({ success: true, message: 'Connected.' });
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('********');
    });
    const testButton = screen.getByRole('button', { name: /test/i });
    expect(testButton).not.toBeDisabled();
    await user.click(testButton);

    await waitFor(() => {
      expect(mockApi.testHardcoverApiKey).toHaveBeenCalledWith('********');
    });
  });

  it('success response shows success toast with response message', async () => {
    mockApi.testHardcoverApiKey.mockResolvedValue({ success: true, message: 'Connected.' });
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'key');
    await user.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Connected.');
    });
  });

  it('failure response shows error toast with response message', async () => {
    mockApi.testHardcoverApiKey.mockResolvedValue({ success: false, message: 'Invalid API key.' });
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'bad-key');
    await user.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Invalid API key.');
    });
  });

  it('button remains disabled and shows loading state while request is pending', async () => {
    let resolveTest: (value: unknown) => void = () => {};
    mockApi.testHardcoverApiKey.mockReturnValue(new Promise((resolve) => { resolveTest = resolve; }));
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'key');
    const testButton = screen.getByRole('button', { name: /test/i });
    await user.click(testButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /testing/i })).toBeDisabled();
    });

    resolveTest({ success: true, message: 'Connected.' });
  });

  // The Test button's onClick handler wraps the api call in try/catch — a rejected
  // promise (network error, 5xx, ApiError thrown by fetchApi) routes to toast.error
  // with getErrorMessage(error). Resolved {success: false} responses don't exercise
  // this catch arm, so we need an explicit rejection test.
  it('rejected api.testHardcoverApiKey shows error toast and exits the pending state', async () => {
    mockApi.testHardcoverApiKey.mockRejectedValue(new Error('Network unreachable'));
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });
    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'plain-key');
    await user.click(screen.getByRole('button', { name: /test/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network unreachable');
    });
    expect(mockToast.success).not.toHaveBeenCalled();

    // Button has left the pending state — back to "Test" (not "Testing...") and enabled
    // because the input still has a non-empty value.
    const finalButton = await screen.findByRole('button', { name: /^test$/i });
    expect(finalButton).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /testing/i })).not.toBeInTheDocument();
  });

  it('saves audibleRegion via metadata bag without languages, minDurationMinutes, or quality', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], hardcoverApiKey: '********' },
      }),
    );
    mockApi.updateSettings.mockResolvedValue(createMockSettings());
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toHaveValue('us');
    });

    await user.selectOptions(screen.getByLabelText('Region'), 'de');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { audibleRegion: 'de', hardcoverApiKey: '********' },
      });
    });

    const payload = mockApi.updateSettings.mock.calls[0]![0] as Record<string, Record<string, unknown>>;
    expect(payload.metadata).not.toHaveProperty('languages');
    expect(payload.metadata).not.toHaveProperty('minDurationMinutes');
    expect(payload).not.toHaveProperty('quality');
  });

  it('saves hardcoverApiKey plaintext when user types a new key', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], hardcoverApiKey: '' },
      }),
    );
    mockApi.updateSettings.mockResolvedValue(createMockSettings());
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Hardcover API Key')).toHaveValue('');
    });

    const input = screen.getByLabelText('Hardcover API Key');
    await user.type(input, 'sk-new-1234');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { audibleRegion: 'us', hardcoverApiKey: 'sk-new-1234' },
      });
    });

    const payload = mockApi.updateSettings.mock.calls[0]![0] as Record<string, Record<string, unknown>>;
    expect(payload.metadata).not.toHaveProperty('languages');
    expect(payload.metadata).not.toHaveProperty('minDurationMinutes');
    expect(payload).not.toHaveProperty('quality');
  });
});
