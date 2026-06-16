import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { EarwitnessSettings } from './EarwitnessSettings';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// importOriginal preserves the real barrel exports so consumer code paths that
// reference other named exports at runtime don't resolve to undefined
// (see learning vimock-barrel-replace-drops-named-exports / #1404).
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      testEarwitness: vi.fn(),
    },
  };
});

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  testEarwitness: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

describe('EarwitnessSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: false, baseUrl: '', apiKey: '' } }),
    );
  });

  it('renders the enable toggle, Base URL, password API Key, and a non-submit Test Connection button', async () => {
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable earwitness')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    const apiKey = screen.getByLabelText('API Key');
    expect(apiKey).toHaveAttribute('type', 'password');
    const testButton = screen.getByRole('button', { name: /test connection/i });
    expect(testButton).toHaveAttribute('type', 'button');
  });

  it('loads a stored key as the masked sentinel', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } }),
    );
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toHaveValue('********');
    });
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://host');
  });

  it('Test Connection is disabled until both Base URL and API Key are non-empty', async () => {
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Base URL')).toHaveValue('');
    });
    expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Base URL'), 'https://host');
    expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();
    await user.type(screen.getByLabelText('API Key'), 'k');
    expect(screen.getByRole('button', { name: /test connection/i })).not.toBeDisabled();
  });

  it('Test without editing posts the stored baseUrl and the sentinel apiKey', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } }),
    );
    mockApi.testEarwitness.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('API Key')).toHaveValue('********');
    });
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(mockApi.testEarwitness).toHaveBeenCalledWith({ baseUrl: 'https://host', apiKey: '********' });
    });
  });

  it('surfaces a success toast on { success: true }', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } }),
    );
    mockApi.testEarwitness.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue('********'));
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  });

  it('surfaces the "Invalid API key" message on a failed test', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } }),
    );
    mockApi.testEarwitness.mockResolvedValue({ success: false, message: 'Invalid API key' });
    const user = userEvent.setup();
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue('********'));
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Invalid API key'));
  });

  it('surfaces the "Unable to reach server" message on a failed test', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ earwitness: { enabled: true, baseUrl: 'https://host', apiKey: '********' } }),
    );
    mockApi.testEarwitness.mockResolvedValue({ success: false, message: 'Unable to reach server' });
    const user = userEvent.setup();
    renderWithProviders(<EarwitnessSettings />);

    await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue('********'));
    await user.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Unable to reach server'));
  });
});
