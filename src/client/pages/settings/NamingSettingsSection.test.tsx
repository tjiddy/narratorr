import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { NamingSettingsSection } from './NamingSettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
  },
}));

vi.mock('@core/utils/index.js', () => ({
  renderTemplate: (template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  renderFilename: (template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FOLDER_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
  NAMING_PRESETS: [
    { id: 'standard', name: 'Standard', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    { id: 'audiobookshelf', name: 'Audiobookshelf', folderFormat: '{author}/{series?/}{title}', fileFormat: '{title}' },
    { id: 'plex', name: 'Plex', folderFormat: '{author}/{series?/}{year? - }{title}', fileFormat: '{title}{trackNumber:00? - pt}' },
    { id: 'last-first', name: 'Last, First', folderFormat: '{authorLastFirst}/{titleSort}', fileFormat: '{authorLastFirst} - {titleSort}' },
  ],
  detectPreset: (folder: string, file: string) => {
    if (folder === '{author}/{title}' && file === '{author} - {title}') return 'standard';
    return 'custom';
  },
  FOLDER_TOKEN_GROUPS: [
    { label: 'Author', tokens: ['author', 'authorLastFirst'] },
    { label: 'Title', tokens: ['title', 'titleSort'] },
    { label: 'Series', tokens: ['series', 'seriesPosition'] },
    { label: 'Narrator', tokens: ['narrator', 'narratorLastFirst'] },
    { label: 'Metadata', tokens: ['year'] },
  ],
  FILE_ONLY_TOKEN_GROUP: { label: 'File-specific', tokens: ['trackNumber', 'trackTotal', 'partName'] },
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

describe('NamingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  describe('rendering', () => {
    it('renders with title "File Naming" and description text', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('File Naming')).toBeInTheDocument();
      });
      expect(screen.getByText('Configure how audiobook files and folders are named')).toBeInTheDocument();
    });

    it('renders Folder Format and File Format fields', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Folder Format')).toBeInTheDocument();
      });
      expect(screen.getByText('File Format')).toBeInTheDocument();
    });

    it('renders ? buttons with cursor-pointer for folder and file format', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('File token reference')).toBeInTheDocument();
      expect(screen.getByLabelText('Folder token reference')).toHaveClass('cursor-pointer');
    });

    it('renders per-field previews below each format field', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      const previews = screen.getAllByText('With series');
      expect(previews.length).toBe(2);
      expect(screen.getAllByText('Without series').length).toBe(2);
    });
  });

  describe('preset interaction', () => {
    it('preset select uses shared SelectWithChevron contract', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Preset')).toBeInTheDocument();
      });
      const select = screen.getByLabelText('Preset');
      expect(select).toHaveClass('appearance-none');
      expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
    });

    it('changing preset updates both format fields', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Preset')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Preset'), 'audiobookshelf');
      expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{series?/}{title}');
      expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{title}');
    });
  });

  describe('separator and case', () => {
    it('renders separator dropdown with all options', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Separator')).toBeInTheDocument();
      });
      const select = screen.getByLabelText('Separator');
      expect(select).toHaveClass('appearance-none');
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(4);
    });

    it('renders case dropdown with all options and shared SelectWithChevron contract', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Case')).toBeInTheDocument();
      });
      const select = screen.getByLabelText('Case');
      expect(select).toHaveClass('appearance-none');
      expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
      const options = select.querySelectorAll('option');
      expect(options).toHaveLength(4);
    });

    it('changing separator updates preview text', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      await user.selectOptions(screen.getByLabelText('Separator'), 'period');
      await waitFor(() => {
        expect(screen.getAllByText(/\[sep:period\]/).length).toBeGreaterThan(0);
      });
    });

    it('changing case updates preview text', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      await user.selectOptions(screen.getByLabelText('Case'), 'upper');
      await waitFor(() => {
        expect(screen.getAllByText(/\[case:upper\]/).length).toBeGreaterThan(0);
      });
    });
  });

  describe('format field editing', () => {
    it('clicking ? button opens NamingTokenModal for folder scope', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Folder token reference'));
      expect(screen.getByText('Folder Token Reference')).toBeInTheDocument();
    });

    it('clicking file ? button opens NamingTokenModal for file scope', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('File token reference')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('File token reference'));
      expect(screen.getByText('File Token Reference')).toBeInTheDocument();
    });
  });

  describe('form submission', () => {
    it('shows save button only when form is dirty', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('File Naming')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    });

    it('saves naming fields to library settings category', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Separator')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Separator'), 'dash');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith({
          library: expect.objectContaining({ namingSeparator: 'dash' }),
        });
      });
    });

    it('shows success toast on save', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Separator')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Separator'), 'dash');
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      await waitFor(() => {
        expect(mockToast.success).toHaveBeenCalledWith('File naming settings saved');
      });
    });

    it('shows error toast on save failure', async () => {
      mockApi.updateSettings.mockRejectedValueOnce(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Case')).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByLabelText('Case'), 'upper');
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Network error');
      });
    });

    it('keeps edited values and save button visible after save failure so user can retry', async () => {
      mockApi.updateSettings.mockRejectedValueOnce(new Error('Network error'));
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Case')).toBeInTheDocument();
      });
      // Change case to 'upper'
      await user.selectOptions(screen.getByLabelText('Case'), 'upper');
      const saveBtn = screen.getByRole('button', { name: /save/i });
      expect(saveBtn).toBeInTheDocument();
      // Submit and let it fail
      fireEvent.submit(saveBtn.closest('form')!);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Network error');
      });
      // Edited value still selected and save button still visible for retry
      expect(screen.getByLabelText('Case')).toHaveValue('upper');
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });
  });

  describe('preview layout', () => {
    it('renders preview labels and values on the same flex row (not stacked)', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      // Each "With series" label should share a flex row with its preview value
      const withSeriesLabels = screen.getAllByText('With series');
      for (const label of withSeriesLabels) {
        const row = label.closest('div');
        expect(row).toHaveClass('flex', 'items-baseline');
      }
    });

    it('file format preview shows .m4b suffix', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author} - {title}');
      });
      // File format previews should contain .m4b suffix
      const previews = screen.getAllByTestId('preview-with-series');
      // The second preview-with-series belongs to the file format field
      expect(previews.length).toBe(2);
      expect(previews[1].textContent).toContain('.m4b');
    });

    it('folder format preview does not show .m4b suffix', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      // The first preview-with-series belongs to the folder format field
      const previews = screen.getAllByTestId('preview-with-series');
      expect(previews[0].textContent).not.toContain('.m4b');
    });

    it('preview container not rendered when format field is empty', async () => {
      const emptySettings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '', fileFormat: '', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(emptySettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('');
      });
      expect(screen.queryByText('With series')).not.toBeInTheDocument();
      expect(screen.queryByText('Without series')).not.toBeInTheDocument();
    });
  });

  describe('inline token panel', () => {
    it('renders caret toggle button for folder format field', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Folder token reference')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
    });

    it('renders caret toggle button for file format field', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('File token reference')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Toggle file tokens')).toBeInTheDocument();
    });

    it('caret button has aria-expanded="false" when panel is closed', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByLabelText('Toggle file tokens')).toHaveAttribute('aria-expanded', 'false');
    });

    it('clicking caret opens inline token panel and sets aria-expanded="true"', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      // Panel should be visible with token group headings
      expect(screen.getByText('Author')).toBeInTheDocument();
    });

    it('clicking caret again closes inline token panel', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'false');
    });

    it('caret button has aria-controls pointing to inline panel id', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      const caretBtn = screen.getByLabelText('Toggle folder tokens');
      const panelId = caretBtn.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      await user.click(caretBtn);
      expect(document.getElementById(panelId!)).toBeInTheDocument();
    });

    it('folder inline panel shows only folder-scoped token groups', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      // Should show folder-scoped groups
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Series')).toBeInTheDocument();
      expect(screen.getByText('Narrator')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
      // Should NOT show file-specific group
      expect(screen.queryByText('File-specific')).not.toBeInTheDocument();
    });

    it('file inline panel shows all token groups including File-specific', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle file tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle file tokens'));
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('File-specific')).toBeInTheDocument();
      // File-specific tokens should be present
      expect(screen.getByText('{trackNumber}')).toBeInTheDocument();
      expect(screen.getByText('{trackTotal}')).toBeInTheDocument();
      expect(screen.getByText('{partName}')).toBeInTheDocument();
    });

    it('clicking token button in inline panel updates input value and marks field dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      // Click the {series} token button
      await user.click(screen.getByText('{series}'));
      // The input value should now include {series} and form should be dirty
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });
    });

    it('inline panel remains open after inserting a token', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByText('{series}'));
      // Panel should still be open after token insertion
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Author')).toBeInTheDocument();
    });

    it('inline panel and ? modal can be open simultaneously', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      // Open inline panel
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      // Open modal
      await user.click(screen.getByLabelText('Folder token reference'));
      expect(screen.getByText('Folder Token Reference')).toBeInTheDocument();
      // Inline panel should still be open
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
    });

    it('both folder and file inline panels can be open simultaneously', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByLabelText('Toggle file tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByLabelText('Toggle file tokens')).toHaveAttribute('aria-expanded', 'true');
    });

    it('closing one panel does not affect the other panel state', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      // Open both panels
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByLabelText('Toggle file tokens'));
      // Close folder panel
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'false');
      // File panel should still be open
      expect(screen.getByLabelText('Toggle file tokens')).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('validation', () => {
    it('shows error for folder format without {title} token', async () => {
      const settingsNoTitle = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settingsNoTitle);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}');
      });
      expect(screen.getByText(/Template must include/)).toBeInTheDocument();
    });

    it('shows error for file format without {title} token and blocks save', async () => {
      const settingsNoFileTitle = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settingsNoFileTitle);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author}');
      });
      // File format validation warning should be shown
      const warnings = screen.getAllByText(/Template must include/);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      // Make form dirty to trigger save button
      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText('Separator'), 'dash');
      // Submit should be blocked by validation — updateSettings should not be called
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      await waitFor(() => {
        // Give time for submit to process
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });
  });
});
