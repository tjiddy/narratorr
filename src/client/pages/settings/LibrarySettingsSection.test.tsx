import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { queryKeys } from '@/lib/queryKeys';
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

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate'),
  renderFilename: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FOLDER_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
  NAMING_PRESETS: [
    { id: 'standard', name: 'Standard', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    { id: 'audiobookshelf', name: 'Audiobookshelf', folderFormat: '{author}/{series/}{title}', fileFormat: '{title}' },
    { id: 'plex', name: 'Plex', folderFormat: '{author}/{series/}{year? - }{title}', fileFormat: '{title}{trackNumber:00? - pt}' },
    { id: 'last-first', name: 'Last, First', folderFormat: '{authorLastFirst}/{titleSort}', fileFormat: '{authorLastFirst} - {titleSort}' },
  ],
  detectPreset: (folder: string, file: string) => {
    if (folder === '{author}/{title}' && file === '{author} - {title}') return 'standard';
    return 'custom';
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

  it('renders fields and preview', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });
    expect(screen.getByText('Folder Format')).toBeInTheDocument();
    expect(screen.getByText('File Format')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
  });

  it('loads settings values into form', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
    });
    expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author} - {title}');
  });

  it('accepts path input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toBeInTheDocument();
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.tripleClick(pathInput);
    await user.keyboard('/new-lib');
    expect(pathInput).toHaveValue('/new-lib');
  });

  it('renders ? buttons for folder and file format token reference', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
    expect(screen.getByLabelText('File token reference')).toBeInTheDocument();
  });

  it('opens file token modal and shows file-specific tokens', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('File Format')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('File token reference'));

    expect(screen.getByText('File Token Reference')).toBeInTheDocument();
    expect(screen.getByText('{trackNumber}')).toBeInTheDocument();
    expect(screen.getByText('{trackTotal}')).toBeInTheDocument();
    expect(screen.getByText('{partName}')).toBeInTheDocument();
  });

  it('shows preview sections', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('With series')).toBeInTheDocument();
    });
    expect(screen.getByText('Without series')).toBeInTheDocument();
  });

  it('inserts token into folder format when token button is clicked in modal', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
    });

    // Open folder token modal
    await user.click(screen.getByLabelText('Folder token reference'));

    // Click the {series} token button
    await user.click(screen.getByText('{series}'));

    // Save button should become enabled (form is dirty from token insertion)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
    });
  });

  it('shows warning when title token is missing from folder format', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      library: { path: '/audiobooks', folderFormat: '{author}/books', fileFormat: '{author} - {title}' },
    }));
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/Template must include/)).toBeInTheDocument();
    });
  });

  it('shows author suggestion when title present but author missing', async () => {
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      library: { path: '/audiobooks', folderFormat: '{title}', fileFormat: '{author} - {title}' },
    }));
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText(/Consider including/)).toBeInTheDocument();
    });
  });

  it('blocks submit and shows inline error when library path is empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    // Clear the path — should trigger validation error
    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.clear(pathInput);

    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/library path is required/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  it('sends library category on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.tripleClick(pathInput);
    await user.keyboard('/new-path');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        library: { path: '/new-path', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
    });
  });

  it('shows success toast on save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.tripleClick(pathInput);
    await user.keyboard('/changed');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Library settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Save failed'));
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks');
    });

    const pathInput = screen.getByPlaceholderText('/audiobooks');
    await user.tripleClick(pathInput);
    await user.keyboard('/changed');

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Save failed');
    });
  });

  describe('library path blur → rescan prompt', () => {
    const mockSettingsLib1 = createMockSettings({
      library: { path: '/lib1', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
    });

    beforeEach(() => {
      mockApi.getSettings.mockResolvedValue(mockSettingsLib1);
      mockApi.updateSettings.mockResolvedValue(mockSettingsLib1);
      mockApi.rescanLibrary.mockResolvedValue({ scanned: 3, missing: 1, restored: 0 });
    });

    it('calls updateSettings with only library.path when path changes on blur', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ library: { path: '/lib2' } });
      });
    });

    it('does NOT call updateSettings when blurred with unchanged path', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.click(pathInput);
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalled());
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });

    it('shows rescan prompt modal after successful path auto-save on blur', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(screen.getByText('Scan Library?')).toBeInTheDocument();
    });

    it('does NOT show rescan prompt modal when updateSettings fails on blur', async () => {
      mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith('Network error'));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does NOT show rescan prompt or call updateSettings when blurred with empty path', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.clear(pathInput);
      await act(async () => { fireEvent.blur(pathInput); });

      expect(mockApi.updateSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does NOT show rescan prompt when path is reverted to the saved value before blur', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib1');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(mockApi.getSettings).toHaveBeenCalled());
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('calls rescanLibrary and shows success toast when user clicks Scan in the prompt', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /scan/i }));

      await waitFor(() => {
        expect(mockApi.rescanLibrary).toHaveBeenCalled();
        expect(mockToast.success).toHaveBeenCalledWith('Library scan complete: 3 scanned, 1 missing, 0 restored');
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes prompt without calling rescanLibrary when user clicks Skip', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /skip/i }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockApi.rescanLibrary).not.toHaveBeenCalled();
    });

    it('closes prompt without calling rescanLibrary when backdrop is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('modal-backdrop'));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(mockApi.rescanLibrary).not.toHaveBeenCalled();
    });

    it('shows error toast when rescanLibrary fails after accepting prompt', async () => {
      mockApi.rescanLibrary.mockRejectedValue(new Error('Library path is not accessible'));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /scan/i }));

      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Library path is not accessible');
      });
    });

    it('only auto-saves library.path on blur — dirty folderFormat is not submitted', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      // Dirty the folderFormat field
      const folderInput = screen.getByPlaceholderText('{author}/{title}');
      await user.clear(folderInput);
      await user.type(folderInput, 'changed-format');

      // Now change path and blur
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({ library: { path: '/lib2' } });
      });
      // Should NOT have sent folderFormat in the blur-save call
      expect(mockApi.updateSettings).not.toHaveBeenCalledWith(
        expect.objectContaining({ library: expect.objectContaining({ folderFormat: expect.anything() }) }),
      );
    });

    it('shows rescan prompt after Browse selection changes path and user blurs field', async () => {
      mockApi.browseDirectory
        .mockResolvedValueOnce({ dirs: ['lib2'], parent: '/' })
        .mockResolvedValueOnce({ dirs: [], parent: '/lib2' });

      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument());

      // Select via Browse
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(await screen.findByText('lib2'));
      await user.click(screen.getByRole('button', { name: 'Select' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Path field now shows the selected path (subdir of /lib1) — blur it to trigger auto-save
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1/lib2'));
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      expect(screen.getByText('Scan Library?')).toBeInTheDocument();
    });

    it('hides Save button after path-only autosave when no sibling fields are dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      // Path auto-saved and path dirty state cleared → no sibling fields dirty → Save button gone
      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ library: { path: '/lib2' } }));
      await waitFor(() => expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument());
    });

    it('keeps Save button visible when sibling fields are dirty after path-only autosave', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      // Dirty folderFormat
      const folderInput = screen.getByPlaceholderText('{author}/{title}');
      await user.clear(folderInput);
      await user.type(folderInput, 'changed-format');

      // Path change + blur → auto-save → path no longer dirty, but folderFormat still is
      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalledWith({ library: { path: '/lib2' } }));
      // Save button stays because folderFormat is still dirty
      await waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument());
    });

    it('invalidates books query after rescan completes', async () => {
      const invalidateSpy = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/lib1'));

      const pathInput = screen.getByPlaceholderText('/audiobooks');
      await user.tripleClick(pathInput);
      await user.keyboard('/lib2');
      await act(async () => { fireEvent.blur(pathInput); });

      await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /scan/i }));

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
      invalidateSpy.mockRestore();
    });
  });

  describe('library path browse integration', () => {
    it('Library Path field renders a Browse button', async () => {
      renderWithProviders(<LibrarySettingsSection />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });
    });

    it('selecting a path via Browse updates the RHF field value and form becomes dirty', async () => {
      const { api: mockApiModule } = await import('@/lib/api');
      // Return a subdirectory so user can navigate into it and select a new path
      (mockApiModule.browseDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ dirs: ['new-library'], parent: '/' })
        .mockResolvedValueOnce({ dirs: [], parent: '/audiobooks' });

      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');

      // Navigate into a different directory
      await user.click(await screen.findByText('new-library'));
      await user.click(screen.getByRole('button', { name: 'Select' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

      // Input should show the selected path
      await waitFor(() => {
        expect(screen.getByPlaceholderText('/audiobooks')).toHaveValue('/audiobooks/new-library');
      });
    });

    it('modal Cancel, Close, breadcrumb, and directory-row clicks inside the form do not submit the form', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });

      // Open and dismiss via Cancel — must not submit
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();

      // Open and dismiss via header Close button — must not submit
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();

      // Open, navigate via breadcrumb — must not submit the form
      mockApi.browseDirectory
        .mockResolvedValueOnce({ dirs: ['books'], parent: '/' })      // initial /audiobooks
        .mockResolvedValueOnce({ dirs: [], parent: '/audiobooks' })   // /audiobooks/books after dir-row click
        .mockResolvedValueOnce({ dirs: ['books'], parent: '/' });     // back to /audiobooks after breadcrumb click
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(await screen.findByText('books'));             // navigate into books/
      // Now at /audiobooks/books — breadcrumbs show / > audiobooks > books
      await user.click(await screen.findByRole('button', { name: 'audiobooks' })); // click breadcrumb
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();

      // Open, navigate via directory row, select — must not submit the form (only updates the field)
      mockApi.browseDirectory.mockResolvedValueOnce({ dirs: ['books'], parent: '/' }).mockResolvedValueOnce({ dirs: [], parent: '/audiobooks' });
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(await screen.findByText('books'));
      await user.click(screen.getByRole('button', { name: 'Select' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });

    it('saving the form after a browse selection persists the chosen path', async () => {
      const { api: mockApiModule } = await import('@/lib/api');
      (mockApiModule.browseDirectory as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ dirs: ['new-library'], parent: '/' })
        .mockResolvedValueOnce({ dirs: [], parent: '/' });
      mockApi.updateSettings.mockResolvedValue(mockSettings);

      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
      });

      // Open browse modal, navigate into new-library, select it
      await user.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');
      await user.click(await screen.findByText('new-library'));
      await user.click(screen.getByRole('button', { name: 'Select' }));

      // Submit the form
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            library: expect.objectContaining({ path: '/audiobooks/new-library' }),
          }),
        );
      });
    });
  });

  describe('format coverage (#93)', () => {
    it('fileFormat missing title token shows validation error and does not call updateSettings', async () => {
      mockApi.getSettings.mockResolvedValue(createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author}-{narrator}' },
      }));
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author}-{narrator}'));

      // The watch-based warning is already visible (1 instance) before any submit attempt
      expect(screen.getAllByText(/Template must include/).length).toBe(1);

      // Dirty the form so Save button appears (use a non-empty value that still fails refine)
      const fileInput = screen.getByPlaceholderText('{author} - {title}');
      await user.tripleClick(fileInput);
      await user.keyboard('x');

      const saveBtn = await screen.findByRole('button', { name: /save/i });
      await user.click(saveBtn);

      // After submit: watch-based warning + resolver errors.fileFormat = 2 instances.
      // The count increasing to 2 proves the submit-time errors.fileFormat render path fired,
      // not just the pre-existing watch warning.
      await waitFor(() => expect(screen.getAllByText(/Template must include/).length).toBe(2));
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });

    it('preview with series shows interpolated folder and file path from format tokens', async () => {
      renderWithProviders(<LibrarySettingsSection />);

      // Default mockSettings: folderFormat='{author}/{title}', fileFormat='{author} - {title}'
      // renderTemplate mock: {author}→'Brandon Sanderson', {title}→'The Way of Kings'
      // renderFilename mock: {author}→'Brandon Sanderson', {title}→'The Way of Kings'
      // renderTemplate mock substitutes {author}/{title} with sample values for both "With series" and "Without series" sections
      // (mock ignores the token map argument, so both sections produce the same output)
      await waitFor(() => {
        const pathSpans = screen.getAllByText('Brandon Sanderson/The Way of Kings/');
        expect(pathSpans.length).toBeGreaterThanOrEqual(1);
        const fileSpans = screen.getAllByText('Brandon Sanderson - The Way of Kings.m4b');
        expect(fileSpans.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('Save button disappears after successful save (dirty state resets)', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}'));

      // Dirty the form
      const folderInput = screen.getByPlaceholderText('{author}/{title}');
      await user.click(folderInput);
      await user.type(folderInput, '/extra');

      const saveBtn = await screen.findByRole('button', { name: /save/i });
      await user.click(saveBtn);

      await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Library settings saved'));
      // After successful save, form is reset (isDirty=false) → Save button hidden
      await waitFor(() => expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument());
    });
  });

  describe('form validation (#82)', () => {
    it('submitting with empty folderFormat shows "Folder format is required" and does not call updateSettings', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}'));

      // Clear folderFormat to make it empty and dirty
      const folderInput = screen.getByPlaceholderText('{author}/{title}');
      await user.tripleClick(folderInput);
      await user.keyboard('[Backspace]');

      // Save button should now be visible
      const saveBtn = await screen.findByRole('button', { name: /save/i });
      await user.click(saveBtn);

      await waitFor(() => expect(screen.getByText('Folder format is required')).toBeInTheDocument());
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });

    it('Save button is disabled and shows "Saving..." while mutation is pending', async () => {
      let resolveUpdate!: () => void;
      mockApi.updateSettings.mockReturnValue(new Promise<typeof mockSettings>(resolve => { resolveUpdate = () => resolve(mockSettings); }));

      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}'));

      // Dirty the form by appending valid text (keeps {title} token → form stays valid)
      const folderInput = screen.getByPlaceholderText('{author}/{title}');
      await user.click(folderInput);
      await user.type(folderInput, '/extra');

      // Click Save — mutation starts (pending)
      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        const btn = screen.getByRole('button', { name: /saving/i });
        expect(btn).toBeDisabled();
        expect(btn).toHaveTextContent('Saving...');
      });

      resolveUpdate();
    });
  });

  describe('token insertion (#82)', () => {
    it('clicking a token button inserts token at cursor position and cursor is positioned after the inserted token', async () => {
      const user = userEvent.setup();
      renderWithProviders(<LibrarySettingsSection />);

      await waitFor(() => expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}'));

      const folderInput = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
      // Focus input — cursor lands at end of value
      await user.click(folderInput);
      const cursorPos = folderInput.value.length; // 15 for '{author}/{title}'

      // Open folder token modal
      await user.click(screen.getByLabelText('Folder token reference'));

      // Click {year} token — insertTokenAtCursor schedules setSelectionRange via rAF
      await user.click(screen.getByText('{year}'));

      // Flush the requestAnimationFrame (jsdom implements rAF as setTimeout)
      await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });

      expect(folderInput).toHaveValue('{author}/{title}{year}');
      // Cursor should be after inserted '{year}': start(15) + 'year'.length(4) + 2 braces = 21
      expect(folderInput.selectionStart).toBe(cursorPos + 'year'.length + 2);
    });
  });
});

describe('LibrarySettingsSection — Scan Library button (#133)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders Scan Library button', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /scan library/i })).toBeInTheDocument();
    });
  });

  it('Scan Library button navigates to /library-import on click', async () => {
    renderWithProviders(<LibrarySettingsSection />);
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /scan library/i });
      expect(link).toHaveAttribute('href', '/library-import');
    });
  });

  describe('presets', () => {
    it.todo('renders preset dropdown');
    it.todo('selecting Standard preset populates both format fields');
    it.todo('selecting Audiobookshelf preset populates both format fields');
    it.todo('selecting Plex preset populates both format fields');
    it.todo('selecting "Last, First" preset populates both format fields');
    it.todo('selecting a preset marks form as dirty');
    it.todo('manual edit after preset selection switches dropdown to Custom');
    it.todo('shows Custom when format values do not match any preset');
    it.todo('preset selection updates preview');
  });

  describe('separator and case dropdowns', () => {
    it.todo('renders separator dropdown with Space/Period/Underscore/Dash options');
    it.todo('renders case dropdown with Default/lowercase/UPPERCASE/Title Case options');
    it.todo('changing separator updates preview');
    it.todo('changing case updates preview');
    it.todo('separator and case values included in save payload');
  });

  describe('token reference modal', () => {
    it.todo('folder format ? button opens modal scoped to folder tokens');
    it.todo('file format ? button opens modal with all tokens including file-specific');
    it.todo('modal shows tokens grouped by category');
    it.todo('clicking a token inserts it into the associated format input');
    it.todo('modal shows syntax reference section');
    it.todo('modal shows "Good to know" section');
    it.todo('modal footer shows live preview');
    it.todo('modal closes via X button');
    it.todo('modal closes via backdrop click');
    it.todo('format field retains changes after modal close');
  });

  describe('inline TokenPanel removed', () => {
    it.todo('no "Insert token" toggle buttons rendered');
    it.todo('no inline help text paragraph rendered');
  });

  describe('validation regression', () => {
    it.todo('folder format without title/titleSort shows error after preset + manual edit');
    it.todo('file format without title/titleSort shows error');
  });
});
