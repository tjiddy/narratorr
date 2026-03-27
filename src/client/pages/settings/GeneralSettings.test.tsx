import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { toast } = await import('sonner');
const mockToast = toast as unknown as { success: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

vi.mock('@/components/library/BulkOperationsSection', () => ({
  BulkOperationsSection: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    testProxy: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getSettings.mockResolvedValue(createMockSettings());
  mockApi.updateSettings.mockResolvedValue(createMockSettings());
});

// Tests verify section composition after #66 refactoring
describe('GeneralSettings', () => {
  it('renders all settings sections', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.getByText('Import')).toBeInTheDocument();
    expect(screen.getByText('Quality')).toBeInTheDocument();
    expect(screen.queryByText('Post Processing')).not.toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.queryByText('Housekeeping')).not.toBeInTheDocument();
    expect(screen.queryByText('Logging')).not.toBeInTheDocument();
    expect(screen.getByText('Metadata')).toBeInTheDocument();
  });

  it('renders Appearance section in the settings page', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('save buttons are hidden when all sections are clean', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    // No save buttons visible when no sections are dirty
    expect(screen.queryAllByRole('button', { name: /save/i })).toHaveLength(0);
  });

  it('does not render a single global save button', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Library')).toBeInTheDocument();
    });

    expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
  });

  it('preserves dirty state in one section when another section saves', async () => {
    const settings = createMockSettings();
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);

    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    // Wait for sections to load
    await waitFor(() => {
      expect(screen.getByLabelText('Blacklist TTL (days)')).toBeInTheDocument();
    });

    // Make Search section dirty by changing blacklist TTL
    const blacklistInput = screen.getByLabelText('Blacklist TTL (days)');
    await user.clear(blacklistInput);
    await user.type(blacklistInput, '14');

    // Also make Network section dirty with a valid proxy URL
    const proxyInput = screen.getByLabelText('Proxy URL');
    await user.type(proxyInput, 'http://proxy:8080');

    // Both sections should show their save buttons
    const saveButtons = screen.getAllByRole('button', { name: /^save$/i });
    expect(saveButtons.length).toBeGreaterThanOrEqual(2);

    // Save the Network section — click its save button and submit
    const networkForm = proxyInput.closest('form')!;
    fireEvent.submit(networkForm);

    // Wait for Network save to complete (updateSettings called)
    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalled();
    });

    // After Network save + cache invalidation refetch, Search section should
    // still have its dirty value preserved (the !isDirty guard prevents reset)
    expect(blacklistInput).toHaveValue(14);

    // General section save button should still be visible (still dirty)
    const remainingSaveButtons = screen.getAllByRole('button', { name: /^save$/i });
    expect(remainingSaveButtons.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Show Welcome Message escape hatch (#157)', () => {
  it('renders "Show Welcome Message" button in Settings → General', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });
  });

  it('clicking "Show Welcome Message" calls updateSettings({ general: { welcomeSeen: false } })', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        general: { welcomeSeen: false },
      });
    });
  });

  it('shows success toast after successful reset', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Welcome message will appear on next view');
    });
  });

  it('shows error toast on reset failure', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockRejectedValue(new Error('Reset failed'));
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Reset failed');
    });
  });

  it('"Show Welcome Message" button is disabled while mutation is in flight', async () => {
    let resolveUpdate!: (v: unknown) => void;
    mockApi.updateSettings.mockReturnValue(new Promise((res) => { resolveUpdate = res; }));
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();

    resolveUpdate(createMockSettings());
  });

  it('invalidates settings cache after reset so Layout re-reads welcomeSeen (F3)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /show welcome message/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /show welcome message/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({ general: { welcomeSeen: false } });
    });

    // Cache invalidation causes a refetch of settings — getSettings called again
    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
