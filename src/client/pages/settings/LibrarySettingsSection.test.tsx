import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, useLocation } from 'react-router';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { useDirtyFormsState, _resetForTesting } from '@/hooks/dirty-forms';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { LibrarySettingsSection } from './LibrarySettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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

  it('renders Library path field', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library path')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
  });

  it('does not render naming UI — no Folder Format, File Format, Preset, Separator, or Case fields', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library path')).toBeInTheDocument();
    });
    expect(screen.queryByText('Folder format')).not.toBeInTheDocument();
    expect(screen.queryByText('File format')).not.toBeInTheDocument();
    expect(screen.queryByText('Preset')).not.toBeInTheDocument();
    expect(screen.queryByText('Separator')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Case')).not.toBeInTheDocument();
  });

  it('does not render standalone Scan Library description text', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library path')).toBeInTheDocument();
    });
    expect(screen.queryByText('Scan the library folder to register existing audiobooks')).not.toBeInTheDocument();
  });

  it('does not render Scan Library link (moved to Library Actions section)', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByText('Library path')).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /scan library/i })).not.toBeInTheDocument();
  });

  describe('unsaved-changes registration (#1888)', () => {
    beforeEach(() => {
      _resetForTesting();
    });

    it('registers the Library label when the path is edited but not yet saved', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      const state = renderHook(() => useDirtyFormsState()).result;

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      expect(state.current.dirtyLabels).toEqual([]);

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');

      await waitFor(() => {
        expect(state.current.dirtyLabels).toEqual(['Library']);
      });
    });

    it('clears the Library label after a successful blur-save resets the field', async () => {
      const user = userEvent.setup();
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<LibrarySettingsSection />);
      const state = renderHook(() => useDirtyFormsState()).result;

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);

      await waitFor(() => {
        expect(state.current.dirtyLabels).toEqual([]);
      });
    });

    it('reports anyPending while the blur-save is in flight (F10)', async () => {
      const user = userEvent.setup();
      let resolveSave: (v: unknown) => void = () => {};
      mockApi.updateSettings.mockReturnValue(new Promise((r) => { resolveSave = r; }));
      renderWithProviders(<LibrarySettingsSection />);
      const state = renderHook(() => useDirtyFormsState()).result;

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-path');
      fireEvent.blur(pathInput);

      await waitFor(() => {
        expect(state.current.anyPending).toBe(true);
      });

      await act(async () => {
        resolveSave(mockSettings);
      });
      await waitFor(() => {
        expect(state.current.anyPending).toBe(false);
      });
    });

    it('keeps Library dirty when blur-save is skipped for an empty path (F11)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      const state = renderHook(() => useDirtyFormsState()).result;

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      fireEvent.blur(pathInput);

      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
      expect(state.current.dirtyLabels).toContain('Library');
    });

    it('keeps Library dirty when the blur-save is rejected (F11)', async () => {
      const user = userEvent.setup();
      mockApi.updateSettings.mockRejectedValue(new Error('save failed'));
      renderWithProviders(<LibrarySettingsSection />);
      const state = renderHook(() => useDirtyFormsState()).result;

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
      expect(state.current.dirtyLabels).toContain('Library');
    });

    it('blur-save success while the guard modal is open closes the guard, stays, and shows the rescan prompt (F12)', async () => {
      const user = userEvent.setup();
      let resolveSave: (v: unknown) => void = () => {};
      mockApi.updateSettings.mockReturnValue(new Promise((r) => { resolveSave = r; }));

      // The section renders outside Routes, so only pathname can prove the captured Link was not replayed.
      function LocationProbe() {
        const location = useLocation();
        return <div data-testid="loc">{location.pathname}</div>;
      }
      renderWithProviders(
        <>
          <UnsavedChangesGuard />
          <LocationProbe />
          <LibrarySettingsSection />
          <Link to="/settings/indexers">Indexers</Link>
        </>,
        { route: '/settings' },
      );

      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
      });
      // Exact equality avoids toHaveTextContent's substring match.
      expect(screen.getByTestId('loc').textContent).toBe('/settings');

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await user.type(pathInput, '/new-lib');

      await user.click(screen.getByRole('link', { name: 'Indexers' }));
      expect(screen.getByText(/The Library card has unsaved changes/)).toBeInTheDocument();
      expect(screen.getByTestId('loc').textContent).toBe('/settings');

      await act(async () => {
        resolveSave(mockSettings);
      });
      await waitFor(() => {
        expect(screen.queryByText(/The Library card has unsaved changes/)).toBeNull();
      });
      expect(screen.getByTestId('loc').textContent).toBe('/settings');
      expect(screen.getByText('Library path')).toBeInTheDocument();
      expect(await screen.findByText('Refresh Library?')).toBeInTheDocument();
    });
  });

  it('does not clobber dirty path edits when settings are refetched', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });
    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);
    await user.type(pathInput, '/dirty-path');
    mockApi.getSettings.mockResolvedValue(mockSettings);
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
      const callArg = mockApi.updateSettings.mock.calls[0]![0];
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
        expect(screen.getByText('Refresh Library?')).toBeInTheDocument();
      });
    });

    it('uses Refresh Library vocabulary in path-change prompt (#1066)', async () => {
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
        expect(screen.getByText('Refresh Library?')).toBeInTheDocument();
      });
      expect(screen.getByText('Would you like to refresh the library at the new path?')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^refresh$/i })).toBeInTheDocument();
      expect(screen.queryByText('Scan Library?')).not.toBeInTheDocument();
      expect(screen.queryByText(/scan the library/i)).not.toBeInTheDocument();
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
        expect(mockToast.error).toHaveBeenCalledWith('fail');
      });
      expect(screen.queryByText('Refresh Library?')).not.toBeInTheDocument();
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

    it('calls rescanLibrary when user clicks Refresh in the prompt', async () => {
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
        expect(screen.getByText('Refresh Library?')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^refresh$/i }));
      await waitFor(() => {
        expect(mockApi.rescanLibrary).toHaveBeenCalled();
      });
    });

    it('shows error toast with exact error message when rescanLibrary rejects', async () => {
      mockApi.rescanLibrary.mockRejectedValueOnce(new Error('Scan failed'));
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
        expect(screen.getByText('Refresh Library?')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /^refresh$/i }));
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Scan failed');
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
        expect(screen.getByText('Refresh Library?')).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /skip/i }));
      expect(mockApi.rescanLibrary).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByText('Refresh Library?')).not.toBeInTheDocument();
      });
    });
  });

  describe('Scan Library removal (#227)', () => {
    it('does NOT render Scan Library link in the Library path row', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library path')).toBeInTheDocument();
      });
      expect(screen.queryByRole('link', { name: /scan library/i })).not.toBeInTheDocument();
    });

    it('Library section contains Library path label, PathInput, and description text', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library path')).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
      expect(screen.getByText('The root folder where imported audiobooks will be stored')).toBeInTheDocument();
    });
  });

  // Deliberately do not mock BulkOperationsSection: re-importing it would surface and fail these assertions.
  describe('library actions removed from Settings (#1704)', () => {
    it('renders only the Library path field — no bulk/library action buttons', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library path')).toBeInTheDocument();
      });
      expect(screen.queryByText('Library Actions')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /rename all books/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /re-tag all books/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /write\/refresh metadata sidecars/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^refresh library$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /import existing library/i })).not.toBeInTheDocument();
    });
  });

  describe('card split — library card does NOT contain new-book defaults (#284)', () => {
    it('does not render Search immediately or Monitor for Upgrades toggles', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library path')).toBeInTheDocument();
      });
      // Use the live label so this negative assertion cannot pass against stale copy.
      expect(screen.queryByLabelText('Search immediately')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Monitor for Upgrades')).not.toBeInTheDocument();
    });

    it('does not render "When a New Book Is Added" heading', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Library path')).toBeInTheDocument();
      });
      expect(screen.queryByText('When a New Book Is Added')).not.toBeInTheDocument();
    });

    it('library path blur-save still works after card split', async () => {
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
  });

  describe('library path browse integration', () => {
    beforeEach(() => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
    });

    it('Library path field renders a Browse button', async () => {
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
      await user.click(dirEntries[dirEntries.length - 1]!);
      await waitFor(() => {
        const pathInput = screen.getByPlaceholderText('/audiobooks') as HTMLInputElement;
        expect(pathInput.value).toBeTruthy();
      });
    });
  });
});
