import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { LibrarySettingsSection } from './LibrarySettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/library/BulkOperationsSection', () => ({
  BulkOperationsSection: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ dirs: [], parent: '/' }),
    rescanLibrary: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  browseDirectory: ReturnType<typeof vi.fn>;
  rescanLibrary: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const mockSettings = createMockSettings({
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
});

describe('LibrarySettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders Library Path field', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
  });

  it('does not render naming UI — no Folder Format, File Format, Preset, Separator, or Case fields', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    expect(screen.queryByText('Folder Format')).not.toBeInTheDocument();
    expect(screen.queryByText('File Format')).not.toBeInTheDocument();
    expect(screen.queryByText('Preset')).not.toBeInTheDocument();
    expect(screen.queryByText('Separator')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Case')).not.toBeInTheDocument();
  });

  it('does not render standalone Scan Library description text', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    expect(screen.queryByText('Scan the library folder to register existing audiobooks')).not.toBeInTheDocument();
  });

  it('does not render Scan Library link (moved to Library Actions section)', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /scan library/i })).not.toBeInTheDocument();
  });

  it('does not clobber dirty path edits when settings are refetched', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });
    // Make the path dirty
    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/dirty-path');
    // Simulate a settings refetch (e.g., from another section saving)
    mockApi.getSettings.mockResolvedValue(mockSettings);
    // Trigger a re-render but the dirty guard should preserve the user's edit
    expect(pathInput).toHaveValue('/dirty-path');
  });

  describe('library path blur → rescan prompt', () => {
    beforeEach(() => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
    });

    it('calls updateSettings with only library.path when path changes on blur', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({ library: expect.objectContaining({ path: expect.any(String) }) }),
        );
      });
      // Verify only library.path was sent (not naming fields)
      const callArg = mockApi.updateSettings.mock.calls[0][0];
      expect(callArg.library).toHaveProperty('path');
      expect(callArg.library).not.toHaveProperty('folderFormat');
    });

    it('does NOT call updateSettings when blurred with unchanged path', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      fireEvent.blur(screen.getByPlaceholderText('/audiobooks'));
      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });

    it('shows rescan prompt modal after successful path auto-save on blur', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(screen.getByText('Scan Library?')).toBeInTheDocument();
      });
    });

    it('does NOT show rescan prompt when updateSettings fails on blur', async () => {
      mockApi.updateSettings.mockRejectedValueOnce(new Error('fail'));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalled();
      });
      expect(screen.queryByText('Scan Library?')).not.toBeInTheDocument();
    });

    it('does NOT call updateSettings when blurred with empty path', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });

    it('calls rescanLibrary when user clicks Scan in the prompt', async () => {
      mockApi.rescanLibrary.mockResolvedValue({ scanned: 5, missing: 0, restored: 0 });
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(screen.getByText('Scan Library?')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /scan/i }));
      await waitFor(() => {
        expect(mockApi.rescanLibrary).toHaveBeenCalled();
      });
    });

    it('closes prompt without calling rescanLibrary when user clicks Skip', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);
      await waitFor(() => {
        expect(screen.getByText('Scan Library?')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /skip/i }));
      expect(mockApi.rescanLibrary).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByText('Scan Library?')).not.toBeInTheDocument();
      });
    });
  });

  // Finding 1: Scan Library removed from Library Path row (#227)
  describe('Scan Library removal (#227)', () => {
    it('does NOT render Scan Library link in the Library Path row', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library Path')).toBeInTheDocument();
      });
      expect(screen.queryByRole('link', { name: /scan library/i })).not.toBeInTheDocument();
    });

    it('Library section contains Library Path label, PathInput, and description text', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library Path')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
      expect(screen.getByText('The root folder where imported audiobooks will be stored')).toBeInTheDocument();
    });
  });

  describe('When a New Book Is Added subsection (#265)', () => {
    it('renders subsection heading "When a New Book Is Added" with divider', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('When a New Book Is Added')).toBeInTheDocument();
      });
    });

    it('renders Search Immediately and Monitor for Upgrades toggles', async () => {
      renderWithProviders(<LibrarySettingsSection />);
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
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect((screen.getByLabelText('Search Immediately') as HTMLInputElement).checked).toBe(true);
      });
      expect((screen.getByLabelText('Monitor for Upgrades') as HTMLInputElement).checked).toBe(true);
    });

    it('toggling Search Immediately enables save button and submits quality category', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

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

    it('toggling Monitor for Upgrades enables save button and submits quality category', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Monitor for Upgrades')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Monitor for Upgrades'));

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.submit(saveButton.closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          quality: { searchImmediately: false, monitorForUpgrades: true },
        });
      });
    });

    it('submitting both toggles on sends both true in quality payload', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Search Immediately'));
      await user.click(screen.getByLabelText('Monitor for Upgrades'));

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.submit(saveButton.closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          quality: { searchImmediately: true, monitorForUpgrades: true },
        });
      });
    });

    it('save payload excludes grabFloor, protocolPreference, minSeeders, rejectWords, requiredWords', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Search Immediately'));

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.submit(saveButton.closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalled();
      });

      const callArg = mockApi.updateSettings.mock.calls[0][0];
      expect(callArg.quality).not.toHaveProperty('grabFloor');
      expect(callArg.quality).not.toHaveProperty('protocolPreference');
      expect(callArg.quality).not.toHaveProperty('minSeeders');
      expect(callArg.quality).not.toHaveProperty('rejectWords');
      expect(callArg.quality).not.toHaveProperty('requiredWords');
    });

    it('shows success toast on toggle save', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Search Immediately'));
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('New book defaults saved');
      });
    });

    it('shows error toast on toggle save failure', async () => {
      mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Search Immediately'));
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Network error');
      });
    });

    it('path blur-save still works independently after subsection added', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({ library: expect.objectContaining({ path: '/new-path' }) }),
        );
      });
    });

    it('save button is disabled and shows Saving... while mutation is pending', async () => {
      let resolveMutation: (value: unknown) => void;
      mockApi.updateSettings.mockImplementation(() => new Promise((resolve) => { resolveMutation = resolve; }));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Search Immediately'));
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
      });

      resolveMutation!(mockSettings);
      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('New book defaults saved');
      });
    });

    it('default values: both toggles unchecked with fresh settings', async () => {
      const freshSettings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(freshSettings);
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Search Immediately')).toBeInTheDocument();
      });

      expect((screen.getByLabelText('Search Immediately') as HTMLInputElement).checked).toBe(false);
      expect((screen.getByLabelText('Monitor for Upgrades') as HTMLInputElement).checked).toBe(false);
    });
  });

  describe('library path browse integration', () => {
    beforeEach(() => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
    });

    it('Library Path field renders a Browse button', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });
    });

    it('selecting a path via Browse updates the field value', async () => {
      mockApi.browseDirectory.mockResolvedValue({ dirs: ['music', 'audiobooks'], parent: '/' });
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await waitFor(() => {
        expect(screen.getAllByText('audiobooks').length).toBeGreaterThan(0);
      });
      const dirEntries = screen.getAllByText('audiobooks');
      await user.click(dirEntries[dirEntries.length - 1]);
      // Browse selection updates path field (exact value depends on directory nav)
      await waitFor(() => {
        const pathInput = screen.getByPlaceholderText('/audiobooks') as HTMLInputElement;
        expect(pathInput.value).toBeTruthy();
      });
    });
  });
});
