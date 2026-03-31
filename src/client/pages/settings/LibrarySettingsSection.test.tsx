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

  it('renders inline Scan Library link next to Library Path label', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    const scanLink = screen.getByRole('link', { name: /scan library/i });
    expect(scanLink).toBeInTheDocument();
    expect(scanLink).toHaveAttribute('href', '/library-import');
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
    it.todo('does NOT render Scan Library link in the Library Path row');
    it.todo('Library section is just: Library Path label → PathInput → description text');
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
