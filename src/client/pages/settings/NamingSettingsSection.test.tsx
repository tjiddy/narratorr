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
  TOKEN_PATTERN_SOURCE: String.raw`\{(?:([^}?]*?)\?)?(\w+)(?::(\d+))?(?:\?([^}]*))?\}`,
  renderTemplate: (template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  renderFilename: vi.fn((template: string, _tokens: unknown, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  }),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FOLDER_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
  NAMING_PRESETS: [
    { id: 'standard', name: 'Standard', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
    { id: 'audiobookshelf', name: 'Audiobookshelf', folderFormat: '{author}/{series?/}{title}', fileFormat: '{title}' },
    { id: 'plex', name: 'Plex', folderFormat: '{author}/{series?/}{year? - }{title}', fileFormat: '{title}{ - pt?trackNumber:00}' },
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
const { renderFilename: mockRenderFilename } = await import('@core/utils/index.js') as unknown as { renderFilename: ReturnType<typeof vi.fn> };
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

    it('clicking token button in inline panel inserts token at cursor position and marks field dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      // Focus the input and move cursor to end
      const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
      await user.click(input);
      input.setSelectionRange(input.value.length, input.value.length);
      // Open inline panel and click a token
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByText('{series}'));
      // Token should be appended at the end since cursor was at the end
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}{series}');
      });
      // Form should be dirty — save button visible
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('clicking token button replaces selected text in the input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      // Focus and select "{title}" (characters 9-16 in "{author}/{title}")
      const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
      await user.click(input);
      input.setSelectionRange(9, 16);
      // Open inline panel and click {series} to replace the selection
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByText('{series}'));
      // {title} should be replaced with {series}
      await waitFor(() => {
        expect(input.value).toBe('{author}/{series}');
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

  describe('atomic token deletion — Backspace', () => {
    async function setupWithValue(folderFormat: string, fileFormat = '{author} - {title}') {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat, fileFormat, namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue(folderFormat);
      });
      return screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    }

    it('deletes entire {title} token when Backspace pressed after closing }', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Position cursor after } of {title} — position 16
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      // Cursor should be at position 9 (where { was) via requestAnimationFrame
      await waitFor(() => {
        expect(input.selectionStart).toBe(9);
      });
    });

    it('deletes entire {seriesPosition:00} token (format specifier) on Backspace', async () => {
      const input = await setupWithValue('{author}/{seriesPosition:00}');
      // After } at position 28 (string length = 28)
      input.setSelectionRange(28, 28);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
    });

    it('deletes entire {series? - } token (conditional text) on Backspace', async () => {
      const input = await setupWithValue('{author}/{series? - }{title}');
      // After } of {series? - } at position 21
      input.setSelectionRange(21, 21);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {series?} token (empty conditional) on Backspace', async () => {
      const input = await setupWithValue('{author}/{series?}{title}');
      // After } of {series?} at position 18
      input.setSelectionRange(18, 18);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {trackNumber:00? - pt} token (combined format+conditional) on Backspace', async () => {
      const input = await setupWithValue('{title}{trackNumber:00? - pt}');
      // After } at position 29 (string length = 29)
      input.setSelectionRange(29, 29);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });

    it('deletes entire {seriesPosition:00? - } token (combined format+conditional with trailing space) on Backspace', async () => {
      const input = await setupWithValue('{seriesPosition:00? - }{title}');
      // After } of {seriesPosition:00? - } at position 23
      input.setSelectionRange(23, 23);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });
  });

  describe('atomic token deletion — Delete', () => {
    async function setupWithValue(folderFormat: string) {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat, fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue(folderFormat);
      });
      return screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    }

    it('deletes entire {title} token when Delete pressed before opening {', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Position cursor before { of {title} — position 9
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      // Cursor should stay at position 9 via requestAnimationFrame
      await waitFor(() => {
        expect(input.selectionStart).toBe(9);
      });
    });

    it('deletes entire {seriesPosition:00} token (format specifier) on Delete', async () => {
      const input = await setupWithValue('{author}/{seriesPosition:00}');
      // Before { at position 9
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
    });

    it('deletes entire {series? - } token (conditional text) on Delete', async () => {
      const input = await setupWithValue('{author}/{series? - }{title}');
      // Before { of {series? - } at position 9
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {trackNumber:00? - pt} token (combined format+conditional) on Delete', async () => {
      const input = await setupWithValue('{title}{trackNumber:00? - pt}');
      // Before { at position 7
      input.setSelectionRange(7, 7);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });
  });

  describe('atomic token deletion — passthrough cases', () => {
    async function setupWithValue(folderFormat: string) {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat, fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue(folderFormat);
      });
      return screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    }

    it('does not intercept Backspace when cursor is inside a token (not at boundary)', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Cursor inside {title} — between t and i at position 11
      input.setSelectionRange(11, 11);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      // Should NOT prevent default — let browser handle normal deletion
      expect(prevented).toBe(false);
    });

    it('does not intercept Delete when cursor is inside a token (not at boundary)', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Cursor inside {title} — between t and l at position 12
      input.setSelectionRange(12, 12);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Backspace when text selection exists', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Select part of the token
      input.setSelectionRange(9, 13);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Backspace for non-token character /', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Cursor after / at position 9
      // Wait — position 9 is actually the { of {title}. Position 8 is after /
      // {author}/ = positions 0-8, so after / is position 8... no.
      // {author} = 8 chars (0-7), / = position 8, {title} starts at 9
      // Cursor after / means position 9... but char at pos 8 is /
      // For backspace: pos-1 = 8, char is '/', not '}'
      input.setSelectionRange(9, 9);
      // Actually pos-1 = 8 = '/' which is not '}', so this should fall through.
      // But pos = 9 = '{' which would trigger Delete logic. For Backspace at pos 9, char at pos-1=8 is '/'.
      // Let me use a value where / is clearly not next to a token boundary.
      // Actually {author}/{title}: at pos 9, Backspace checks pos-1=8 which is '/', not '}'. Correct.
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      input.setSelectionRange(9, 9);
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Delete for non-token character /', async () => {
      const input = await setupWithValue('{author}/{title}');
      // Cursor before / at position 8 — char at pos 8 is '/', not '{'
      input.setSelectionRange(8, 8);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });
  });

  describe('atomic token deletion — boundary values', () => {
    it('deletes entire value when field contains only {title}', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{title}');
        return el;
      });
      input.setSelectionRange(7, 7);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('');
      });
    });

    it('deletes only {author} from adjacent tokens {author}{title} — Backspace after first }', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}{title}');
        return el;
      });
      // After } of {author} at position 8
      input.setSelectionRange(8, 8);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });

    it('deletes only {title} from adjacent tokens {author}{title} — Delete before second {', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}{title}');
        return el;
      });
      // Before { of {title} at position 8
      input.setSelectionRange(8, 8);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}');
      });
    });
  });

  describe('atomic token deletion — start/end boundary guards', () => {
    it('Backspace at position 0 is a no-op', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}/{title}');
        return el;
      });
      input.setSelectionRange(0, 0);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
      expect(input.value).toBe('{author}/{title}');
    });

    it('Delete at input.value.length is a no-op', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}/{title}');
        return el;
      });
      input.setSelectionRange(16, 16);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
      expect(input.value).toBe('{author}/{title}');
    });
  });

  describe('atomic token deletion — stray/unmatched braces', () => {
    async function setupWithValue(folderFormat: string) {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat, fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue(folderFormat);
      });
      return screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
    }

    it('falls through to normal deletion when } has no matching {', async () => {
      const input = await setupWithValue('text}more');
      // After } at position 5
      input.setSelectionRange(5, 5);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion when { has no matching }', async () => {
      const input = await setupWithValue('text{more');
      // Before { at position 4
      input.setSelectionRange(4, 4);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion when candidate {..} is not a valid token', async () => {
      const input = await setupWithValue('{not a token}rest');
      // After } at position 13
      input.setSelectionRange(13, 13);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion on Delete when candidate {..} is not a valid token', async () => {
      const input = await setupWithValue('{not a token}rest');
      // Before { at position 0 — {not a token} has closing } at 12 but fails regex
      input.setSelectionRange(0, 0);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
      expect(input.value).toBe('{not a token}rest');
    });

    it('falls through to normal deletion for } with preceding { but non-token content between', async () => {
      const input = await setupWithValue('prefix}suffix{title}');
      // After } at position 7 — scanning backward finds no { before this }
      // Actually { at position 13? No. 'prefix}suffix{title}' = p(0)r(1)e(2)f(3)i(4)x(5)}(6)s(7)u(8)f(9)f(10)i(11)x(12){(13)...
      // } is at position 6. Scanning backward from 6 for { finds none before it. Fall through.
      input.setSelectionRange(7, 7);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });
  });

  describe('atomic token deletion — form state integration', () => {
    it('marks form dirty after atomic deletion (save button appears)', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}/{title}');
        return el;
      });
      // No save button yet
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      // Delete {title} via Backspace
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      // Save button should now appear
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
      });
    });

    it('shows validation error after deleting required {title} token', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}/{title}');
        return el;
      });
      // Delete {title} — leaves {author}/ which is missing {title}
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      // Validation error should appear — missing required {title} token
      await waitFor(() => {
        const errors = screen.getAllByText(/Template must include/);
        expect(errors.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('atomic token deletion — both fields', () => {
    it('atomic deletion works in Folder Format input', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
        expect(el).toHaveValue('{author}/{title}');
        return el;
      });
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
    });

    it('atomic deletion works in File Format input', async () => {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
        expect(el).toHaveValue('{author} - {title}');
        return el;
      });
      // Delete {title} from file format — '{author} - {title}'.length = 18, cursor after }
      input.setSelectionRange(18, 18);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author} - ');
      });
    });
  });

  describe('multi-file preview', () => {
    it('file format field renders three preview labels: With series, Without series, Multi-file', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getAllByText('With series').length).toBeGreaterThanOrEqual(1);
      });
      // Both folder and file have "With series"/"Without series", but only file has "Multi-file"
      expect(screen.getByText('Multi-file')).toBeInTheDocument();
    });

    it('folder format field renders exactly two preview labels (no Multi-file)', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getAllByText('With series').length).toBeGreaterThanOrEqual(1);
      });
      // Only 1 "Multi-file" label (file only — folder has no multi-file preview)
      const multiFileLabels = screen.getAllByText('Multi-file');
      expect(multiFileLabels).toHaveLength(1);
    });

    it('single-file previews omit track tokens; multi-file preview uses trackNumber=3, trackTotal=12', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Multi-file')).toBeInTheDocument();
      });

      // renderFilename is called 3 times for file format: with-series, without-series, multi-file
      const filenameCalls = mockRenderFilename.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0] === '{author} - {title}',
      );
      // With-series call: tokens should NOT have trackNumber
      const withSeriesTokens = filenameCalls[0]?.[1] as Record<string, unknown>;
      expect(withSeriesTokens).not.toHaveProperty('trackNumber');
      expect(withSeriesTokens).not.toHaveProperty('trackTotal');
      expect(withSeriesTokens).not.toHaveProperty('partName');

      // Without-series call: tokens should NOT have trackNumber
      const withoutSeriesTokens = filenameCalls[1]?.[1] as Record<string, unknown>;
      expect(withoutSeriesTokens).not.toHaveProperty('trackNumber');
      expect(withoutSeriesTokens).not.toHaveProperty('trackTotal');
      expect(withoutSeriesTokens).not.toHaveProperty('partName');

      // Multi-file call: tokens should have trackNumber=3, trackTotal=12, partName='Chapter 3'
      const multiFileTokens = filenameCalls[2]?.[1] as Record<string, unknown>;
      expect(multiFileTokens).toHaveProperty('trackNumber', 3);
      expect(multiFileTokens).toHaveProperty('trackTotal', 12);
      expect(multiFileTokens).toHaveProperty('partName', 'Chapter 3');
    });

    it('multi-file preview row receives updated separator/case options', async () => {
      const user = userEvent.setup();
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Multi-file')).toBeInTheDocument();
      });

      // Change separator to period
      mockRenderFilename.mockClear();
      await user.selectOptions(screen.getByLabelText('Separator'), 'period');

      await waitFor(() => {
        const calls = mockRenderFilename.mock.calls.filter(
          (call: unknown[]) => typeof call[0] === 'string' && call[0] === '{author} - {title}',
        );
        const multiFileOptions = calls[2]?.[2] as { separator?: string; case?: string } | undefined;
        expect(multiFileOptions).toEqual(expect.objectContaining({ separator: 'period' }));
      });

      // Change case to upper
      mockRenderFilename.mockClear();
      await user.selectOptions(screen.getByLabelText('Case'), 'upper');

      await waitFor(() => {
        const calls = mockRenderFilename.mock.calls.filter(
          (call: unknown[]) => typeof call[0] === 'string' && call[0] === '{author} - {title}',
        );
        const multiFileOptions = calls[2]?.[2] as { separator?: string; case?: string } | undefined;
        expect(multiFileOptions).toEqual(expect.objectContaining({ case: 'upper' }));
      });
    });
  });

  describe('atomic deletion — prefix conditional tokens', () => {
    it('Backspace at end of { - pt?trackNumber:00} deletes entire token', async () => {
      const plexSettings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{title}{ - pt?trackNumber:00}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(plexSettings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
        expect(el).toHaveValue('{title}{ - pt?trackNumber:00}');
        return el;
      });
      // Cursor after closing brace of { - pt?trackNumber:00}: '{title}{ - pt?trackNumber:00}'.length = 29
      input.setSelectionRange(29, 29);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });

    it('Delete at start of { - pt?trackNumber:00} deletes entire token', async () => {
      const plexSettings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{title}{ - pt?trackNumber:00}', namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(plexSettings);
      renderWithProviders(<NamingSettingsSection />);
      const input = await waitFor(() => {
        const el = screen.getByPlaceholderText('{author} - {title}') as HTMLInputElement;
        expect(el).toHaveValue('{title}{ - pt?trackNumber:00}');
        return el;
      });
      // Cursor at opening brace of { - pt?trackNumber:00}: position 7 (after '{title}')
      input.setSelectionRange(7, 7);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });
  });
});
