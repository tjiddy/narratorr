import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { LibrarySettingsSection } from './LibrarySettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    browseDirectory: vi.fn().mockResolvedValue({ dirs: [], parent: '/' }),
  },
}));

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate'),
  renderFilename: (template: string) => template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  browseDirectory: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const mockSettings = createMockSettings({
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
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

  it('token panels collapsed by default', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Library Path')).toBeInTheDocument();
    });

    // Token buttons not visible
    expect(screen.queryByText('{series}')).not.toBeInTheDocument();
    // But toggle buttons are
    const toggles = screen.getAllByText('Insert token');
    expect(toggles).toHaveLength(2);
  });

  it('expands file format token panel and shows file-specific tokens', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('File Format')).toBeInTheDocument();
    });

    // Expand file format token panel (second toggle)
    const toggles = screen.getAllByText('Insert token');
    await user.click(toggles[1]);

    expect(screen.getAllByText('{trackNumber}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{trackTotal}').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('{partName}').length).toBeGreaterThanOrEqual(1);
  });

  it('shows preview sections', async () => {
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('With series')).toBeInTheDocument();
    });
    expect(screen.getByText('Without series')).toBeInTheDocument();
  });

  it('inserts token into folder format when token button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LibrarySettingsSection />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
    });

    // Expand folder format token panel (first toggle)
    const toggles = screen.getAllByText('Insert token');
    await user.click(toggles[0]);

    // Click the {series} token button
    await user.click(screen.getAllByText('{series}')[0]);

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
        library: { path: '/new-path', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
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
});
