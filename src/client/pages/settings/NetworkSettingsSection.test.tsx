import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';
import type { Mock } from 'vitest';
import type { Settings } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testProxy: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NetworkSettingsSection', () => {
  it('renders proxy URL text field', async () => {
    const mockSettings: Settings = createMockSettings();
    (api.getSettings as Mock).mockResolvedValue(mockSettings);

    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('http://gluetun:8888 or socks5://localhost:1080')).toBeInTheDocument();
  });

  it('renders empty proxy URL field on fresh install', async () => {
    const mockSettings: Settings = createMockSettings();
    (api.getSettings as Mock).mockResolvedValue(mockSettings);

    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Proxy URL')).toHaveValue('');
  });

  it('shows saved proxy URL value on load', async () => {
    const mockSettings: Settings = createMockSettings({
      network: { proxyUrl: 'http://gluetun:8888' },
    });
    (api.getSettings as Mock).mockResolvedValue(mockSettings);

    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toHaveValue('http://gluetun:8888');
    });
  });

  it('shows validation error for invalid proxy URL', async () => {
    const user = userEvent.setup();
    const mockSettings: Settings = createMockSettings();
    (api.getSettings as Mock).mockResolvedValue(mockSettings);

    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Proxy URL'), 'not-a-valid-url');

    // Submit the form to trigger validation
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByText(/must be a valid url/i)).toBeInTheDocument();
    });
  });

  describe('Test Proxy button', () => {
    it('is disabled when proxy URL field is empty', async () => {
      const mockSettings: Settings = createMockSettings();
      (api.getSettings as Mock).mockResolvedValue(mockSettings);

      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /test proxy/i })).toBeInTheDocument();
      });
      expect(screen.getByRole('button', { name: /test proxy/i })).toBeDisabled();
    });

    it('shows success toast with exit IP on successful test', async () => {
      const user = userEvent.setup();
      const mockSettings: Settings = createMockSettings();
      (api.getSettings as Mock).mockResolvedValue(mockSettings);
      (api.testProxy as Mock).mockResolvedValue({ success: true, ip: '1.2.3.4' });

      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(api.testProxy).toHaveBeenCalledWith('http://gluetun:8888');
        expect(toast.success).toHaveBeenCalledWith('Proxy connected — exit IP: 1.2.3.4');
      });
    });

    it('shows error toast on proxy connection failure', async () => {
      const user = userEvent.setup();
      const mockSettings: Settings = createMockSettings();
      (api.getSettings as Mock).mockResolvedValue(mockSettings);
      (api.testProxy as Mock).mockResolvedValue({ success: false, message: 'Connection refused' });

      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Connection refused');
      });
    });

    it('shows loading state during test', async () => {
      const user = userEvent.setup();
      const mockSettings: Settings = createMockSettings();
      (api.getSettings as Mock).mockResolvedValue(mockSettings);

      // Create a promise we can control to keep the test in loading state
      let resolveProxy!: (value: { success: boolean; ip: string }) => void;
      (api.testProxy as Mock).mockReturnValue(
        new Promise((resolve) => {
          resolveProxy = resolve;
        }),
      );

      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Proxy URL')).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Proxy URL'), 'http://gluetun:8888');
      await user.click(screen.getByRole('button', { name: /test proxy/i }));

      await waitFor(() => {
        expect(screen.getByText('Testing...')).toBeInTheDocument();
      });

      // Resolve the pending promise to clean up
      resolveProxy({ success: true, ip: '1.2.3.4' });

      await waitFor(() => {
        expect(screen.queryByText('Testing...')).not.toBeInTheDocument();
      });
    });
  });
});
