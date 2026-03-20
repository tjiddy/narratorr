import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { NetworkSettingsSection } from './NetworkSettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testProxy: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  testProxy: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

describe('NetworkSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders proxy URL text field', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings());
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('http://gluetun:8888 or socks5://localhost:1080')).toBeInTheDocument();
    });
  });

  it('renders empty proxy URL field on fresh install', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings());
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('');
    });
  });

  it('shows saved proxy URL value on load', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      network: { proxyUrl: 'http://gluetun:8888' },
    }));
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://gluetun:8888');
    });
  });

  it('sends network category on save', async () => {
    const settings = createMockSettings({
      network: { proxyUrl: 'http://gluetun:8888' },
    });
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://gluetun:8888');
    });

    // Make form dirty
    const input = screen.getByLabelText('Proxy URL');
    await user.clear(input);
    await user.type(input, 'socks5://localhost:1080');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        network: { proxyUrl: 'socks5://localhost:1080' },
      });
    });
  });

  it('shows success toast on save', async () => {
    const settings = createMockSettings({
      network: { proxyUrl: 'http://gluetun:8888' },
    });
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://gluetun:8888');
    });

    const input = screen.getByLabelText('Proxy URL');
    await user.clear(input);
    await user.type(input, 'socks5://localhost:9090');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Network settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      network: { proxyUrl: 'http://gluetun:8888' },
    }));
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://gluetun:8888');
    });

    const input = screen.getByLabelText('Proxy URL');
    await user.clear(input);
    await user.type(input, 'socks5://localhost:9090');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });

  it('blocks submit and shows inline error for invalid proxy URL', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings());
    const user = userEvent.setup();
    renderWithProviders(<NetworkSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('');
    });

    await user.type(screen.getByLabelText('Proxy URL'), 'not-a-url');

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/must be a valid url with http, https, or socks5 scheme/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  describe('Test Proxy button', () => {
    it('is disabled when proxy URL field is empty', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings());
      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test proxy/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /test proxy/i })).toBeDisabled();
      });
    });

    it('shows success toast with exit IP on successful test', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings());
      mockApi.testProxy.mockResolvedValue({ success: true, ip: '1.2.3.4' });
      const user = userEvent.setup();
      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(mockApi.testProxy).toHaveBeenCalledWith('http://gluetun:8888');
        expect(mockToast.success).toHaveBeenCalledWith('Proxy connected — exit IP: 1.2.3.4');
      });
    });

    it('shows error toast on proxy connection failure', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings());
      mockApi.testProxy.mockResolvedValue({ success: false, message: 'Connection refused' });
      const user = userEvent.setup();
      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Connection refused');
      });
    });

    it('shows error toast on thrown error', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings());
      mockApi.testProxy.mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Network error');
      });
    });

    it('shows loading state during test', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings());
      const user = userEvent.setup();

      let resolveProxy!: (value: { success: boolean; ip: string }) => void;
      mockApi.testProxy.mockReturnValue(
        new Promise((resolve) => {
          resolveProxy = resolve;
        }),
      );

      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(screen.getByText('Testing...')).toBeInTheDocument();
      });

      resolveProxy({ success: true, ip: '1.2.3.4' });

      await waitFor(() => {
        expect(screen.queryByText('Testing...')).not.toBeInTheDocument();
      });
    });
  });

  describe('proxy sentinel handling', () => {
    it('shows empty input (placeholder) when proxyUrl is empty string from fresh database', async () => {
      const settings = createMockSettings({ network: { proxyUrl: '' } });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NetworkSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toHaveValue('');
      });
    });

    it('round-trips server-hydrated masked sentinel value through save', async () => {
      // When server returns a masked proxy URL (sentinel), saving the section
      // must pass it through unchanged without validation blocking it
      const SENTINEL = '********';
      const settings = createMockSettings({ network: { proxyUrl: SENTINEL } });
      mockApi.getSettings.mockResolvedValue(settings);
      mockApi.updateSettings.mockResolvedValue(settings);
      renderWithProviders(<NetworkSettingsSection />);

      // Wait for server-hydrated sentinel to populate the field
      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toHaveValue(SENTINEL);
      });

      // Submit the form directly — the sentinel must pass validation
      // We can't use the save button (only visible when isDirty) since retyping
      // the same value doesn't make RHF dirty. Submit the form element directly.
      const input = screen.getByLabelText('Proxy URL');
      fireEvent.submit(input.closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          network: { proxyUrl: SENTINEL },
        });
      });
    });
  });
});
