import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { NewBookDefaultsSection } from './NewBookDefaultsSection';

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
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
});

describe('NewBookDefaultsSection (#284)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders as a separate SettingsSection card with title and description', async () => {
    renderWithProviders(<NewBookDefaultsSection />);
    await waitFor(() => {
      expect(screen.getByText('When a New Book Is Added')).toBeInTheDocument();
    });
    expect(screen.getByText('Applied when books are added manually or via import lists or discovery')).toBeInTheDocument();
  });

  it('contains Search Immediately and Monitor for Upgrades toggles', async () => {
    renderWithProviders(<NewBookDefaultsSection />);
    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Monitor for Upgrades')).toBeInTheDocument();
  });

  it('loads quality settings values into toggles', async () => {
    const settingsWithToggles = createMockSettings({
      library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      quality: { searchImmediately: true, monitorForUpgrades: true },
    });
    mockApi.getSettings.mockResolvedValue(settingsWithToggles);
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect((screen.getByLabelText('Search Immediately') as HTMLInputElement).checked).toBe(true);
    });
    expect((screen.getByLabelText('Monitor for Upgrades') as HTMLInputElement).checked).toBe(true);
  });

  it('toggling a default field shows save button and submits correct quality payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Search Immediately'));

    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeInTheDocument();
    fireEvent.submit(saveButton.closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        quality: { searchImmediately: true, monitorForUpgrades: false },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Search Immediately'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('New book defaults saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Search Immediately'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });

  it('successful save resets dirty state and hides Save button', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Search Immediately'));
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('New book defaults saved');
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });
  });

  it('successful save triggers settings refetch via query invalidation', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    const initialGetCallCount = mockApi.getSettings.mock.calls.length;

    await user.click(screen.getByLabelText('Search Immediately'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('New book defaults saved');
    });

    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThan(initialGetCallCount);
    });
  });

  it('dirty defaults form survives unrelated settings refetch', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    renderWithProviders(<NewBookDefaultsSection />, { queryClient });

    await waitFor(() => {
      expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Search Immediately'));
    expect((screen.getByLabelText('Search Immediately') as HTMLInputElement).checked).toBe(true);

    const refetchedSettings = createMockSettings({
      library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
    });
    mockApi.getSettings.mockResolvedValue(refetchedSettings);
    const callsBefore = mockApi.getSettings.mock.calls.length;
    queryClient.invalidateQueries({ queryKey: ['settings'] });

    await waitFor(() => {
      expect(mockApi.getSettings.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    expect((screen.getByLabelText('Search Immediately') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });
});
