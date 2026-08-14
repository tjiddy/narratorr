import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
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

// Spread the real barrel so unmocked naming helpers stay production-faithful; render fakes expose options through tags.
vi.mock('@core/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/utils/index.js')>()),
  renderTemplate: (template: string, tokens: Record<string, unknown>, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{authorLastFirst}', 'Sanderson, Brandon').replace('{title}', 'The Way of Kings').replace('{titleSort}', 'Way of Kings').replace('{narratorLastFirst}', 'Kramer, Michael & Reading, Kate').replace('{edition}', (tokens?.edition as string) ?? '');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  },
  renderFilename: vi.fn((template: string, tokens: Record<string, unknown>, options?: { separator?: string; case?: string }) => {
    let result = template.replace('{author}', 'Brandon Sanderson').replace('{title}', 'The Way of Kings').replace('{edition}', (tokens?.edition as string) ?? '').replace('{trackNumber}', '1').replace('{trackTotal}', '12').replace('{partName}', 'The Way of Kings');
    if (options?.separator && options.separator !== 'space') result = `[sep:${options.separator}] ${result}`;
    if (options?.case && options.case !== 'default') result = `[case:${options.case}] ${result}`;
    return result;
  }),
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

    it('renders Folder format and File format fields', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Folder format')).toBeInTheDocument();
      });
      expect(screen.getByText('File format')).toBeInTheDocument();
    });

    it('format inputs keep an accessible name (row header is a span, so the input labels itself)', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Folder format')).toHaveAttribute('id', 'folderFormat');
      });
      expect(screen.getByLabelText('File format')).toHaveAttribute('id', 'fileFormat');
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
      await user.selectOptions(screen.getByLabelText('Case'), 'upper');
      const saveBtn = screen.getByRole('button', { name: /save/i });
      expect(saveBtn).toBeInTheDocument();
      fireEvent.submit(saveBtn.closest('form')!);
      await waitFor(() => {
        expect(mockToast.error).toHaveBeenCalledWith('Network error');
      });
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
      const withSeries = screen.getAllByTestId('preview-with-series');
      // The second preview-with-series belongs to the file format field
      expect(withSeries.length).toBe(2);
      expect(withSeries[1]!.textContent).toContain('.m4b');
      expect(withSeries[1]!.textContent).not.toContain('.mp3');
      const withoutSeries = screen.getAllByTestId('preview-without-series');
      expect(withoutSeries[1]!.textContent).toContain('.m4b');
      expect(withoutSeries[1]!.textContent).not.toContain('.mp3');
    });

    it('file format multi-file preview shows .mp3 suffix, not .m4b', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue('{author} - {title}');
      });
      const multiFile = screen.getByTestId('preview-multi-file');
      expect(multiFile.textContent).toContain('.mp3');
      expect(multiFile.textContent).not.toContain('.m4b');
    });

    it('folder format preview does not show .m4b suffix', async () => {
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      // The first preview-with-series belongs to the folder format field
      const previews = screen.getAllByTestId('preview-with-series');
      expect(previews[0]!.textContent).not.toContain('.m4b');
      expect(previews[0]!.textContent).not.toContain('.mp3');
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
      expect(screen.getByText('Author')).toBeInTheDocument();
      expect(screen.getByText('Title')).toBeInTheDocument();
      expect(screen.getByText('Series')).toBeInTheDocument();
      expect(screen.getByText('Narrator')).toBeInTheDocument();
      expect(screen.getByText('Metadata')).toBeInTheDocument();
      expect(screen.getByText('{edition}')).toBeInTheDocument();
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
      const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
      await user.click(input);
      input.setSelectionRange(input.value.length, input.value.length);
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByText('{series}'));
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}{series}');
      });
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('clicking token button replaces selected text in the input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author}/{title}')).toHaveValue('{author}/{title}');
      });
      const input = screen.getByPlaceholderText('{author}/{title}') as HTMLInputElement;
      await user.click(input);
      input.setSelectionRange(9, 16);
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByText('{series}'));
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
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('Author')).toBeInTheDocument();
    });

    it('inline panel and ? modal can be open simultaneously', async () => {
      const user = userEvent.setup();
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByLabelText('Toggle folder tokens')).toBeInTheDocument();
      });
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByLabelText('Folder token reference'));
      expect(screen.getByText('Folder Token Reference')).toBeInTheDocument();
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
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      await user.click(screen.getByLabelText('Toggle file tokens'));
      await user.click(screen.getByLabelText('Toggle folder tokens'));
      expect(screen.getByLabelText('Toggle folder tokens')).toHaveAttribute('aria-expanded', 'false');
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
      const warnings = screen.getAllByText(/Template must include/);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const user = userEvent.setup();
      await user.selectOptions(screen.getByLabelText('Separator'), 'dash');
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      await waitFor(() => {
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
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      await waitFor(() => {
        expect(input.selectionStart).toBe(9);
      });
    });

    it('deletes entire {seriesPosition:00} token (format specifier) on Backspace', async () => {
      const input = await setupWithValue('{author}/{seriesPosition:00}');
      input.setSelectionRange(28, 28);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
    });

    it('deletes entire {series? - } token (conditional text) on Backspace', async () => {
      const input = await setupWithValue('{author}/{series? - }{title}');
      input.setSelectionRange(21, 21);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {series?} token (empty conditional) on Backspace', async () => {
      const input = await setupWithValue('{author}/{series?}{title}');
      input.setSelectionRange(18, 18);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {trackNumber:00? - pt} token (combined format+conditional) on Backspace', async () => {
      const input = await setupWithValue('{title}{trackNumber:00? - pt}');
      input.setSelectionRange(29, 29);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });

    it('deletes entire {seriesPosition:00? - } token (combined format+conditional with trailing space) on Backspace', async () => {
      const input = await setupWithValue('{seriesPosition:00? - }{title}');
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
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
      await waitFor(() => {
        expect(input.selectionStart).toBe(9);
      });
    });

    it('deletes entire {seriesPosition:00} token (format specifier) on Delete', async () => {
      const input = await setupWithValue('{author}/{seriesPosition:00}');
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
    });

    it('deletes entire {series? - } token (conditional text) on Delete', async () => {
      const input = await setupWithValue('{author}/{series? - }{title}');
      input.setSelectionRange(9, 9);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/{title}');
      });
    });

    it('deletes entire {trackNumber:00? - pt} token (combined format+conditional) on Delete', async () => {
      const input = await setupWithValue('{title}{trackNumber:00? - pt}');
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
      input.setSelectionRange(11, 11);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Delete when cursor is inside a token (not at boundary)', async () => {
      const input = await setupWithValue('{author}/{title}');
      input.setSelectionRange(12, 12);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Backspace when text selection exists', async () => {
      const input = await setupWithValue('{author}/{title}');
      input.setSelectionRange(9, 13);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Backspace for non-token character /', async () => {
      const input = await setupWithValue('{author}/{title}');
      input.setSelectionRange(9, 9);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      input.setSelectionRange(9, 9);
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('does not intercept Delete for non-token character /', async () => {
      const input = await setupWithValue('{author}/{title}');
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
      input.setSelectionRange(5, 5);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion when { has no matching }', async () => {
      const input = await setupWithValue('text{more');
      input.setSelectionRange(4, 4);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion when candidate {..} is not a valid token', async () => {
      const input = await setupWithValue('{not a token}rest');
      input.setSelectionRange(13, 13);
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
    });

    it('falls through to normal deletion on Delete when candidate {..} is not a valid token', async () => {
      const input = await setupWithValue('{not a token}rest');
      input.setSelectionRange(0, 0);
      const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
      const prevented = !input.dispatchEvent(event);
      expect(prevented).toBe(false);
      expect(input.value).toBe('{not a token}rest');
    });

    it('falls through to normal deletion for } with preceding { but non-token content between', async () => {
      const input = await setupWithValue('prefix}suffix{title}');
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
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
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
      input.setSelectionRange(16, 16);
      fireEvent.keyDown(input, { key: 'Backspace' });
      await waitFor(() => {
        expect(input.value).toBe('{author}/');
      });
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
      expect(screen.getByText('Multi-file')).toBeInTheDocument();
    });

    it('folder format field renders exactly two preview labels (no Multi-file)', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getAllByText('With series').length).toBeGreaterThanOrEqual(1);
      });
      const multiFileLabels = screen.getAllByText('Multi-file');
      expect(multiFileLabels).toHaveLength(1);
    });

    it('single-file previews omit track tokens; multi-file preview uses trackNumber=3, trackTotal=12', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Multi-file')).toBeInTheDocument();
      });

      // Call order: with series, without series, multi-file.
      const filenameCalls = mockRenderFilename.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && call[0] === '{author} - {title}',
      );
      const withSeriesTokens = filenameCalls[0]?.[1] as Record<string, unknown>;
      expect(withSeriesTokens).not.toHaveProperty('trackNumber');
      expect(withSeriesTokens).not.toHaveProperty('trackTotal');
      expect(withSeriesTokens).not.toHaveProperty('partName');

      const withoutSeriesTokens = filenameCalls[1]?.[1] as Record<string, unknown>;
      expect(withoutSeriesTokens).not.toHaveProperty('trackNumber');
      expect(withoutSeriesTokens).not.toHaveProperty('trackTotal');
      expect(withoutSeriesTokens).not.toHaveProperty('partName');

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

      mockRenderFilename.mockClear();
      await user.selectOptions(screen.getByLabelText('Separator'), 'period');

      await waitFor(() => {
        const calls = mockRenderFilename.mock.calls.filter(
          (call: unknown[]) => typeof call[0] === 'string' && call[0] === '{author} - {title}',
        );
        const multiFileOptions = calls[2]?.[2] as { separator?: string; case?: string } | undefined;
        expect(multiFileOptions).toEqual(expect.objectContaining({ separator: 'period' }));
      });

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

  describe('multiple-editions folder preview (#1774)', () => {
    it('folder format field renders a "Multiple editions" row; file format does not', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText('Multiple editions')).toBeInTheDocument();
      });
      expect(screen.getAllByText('Multiple editions')).toHaveLength(1);
      expect(screen.getAllByTestId('preview-multi-edition')).toHaveLength(1);
    });

    it('folder box has no Multi-file row and file box has no Multiple-editions row (row-shape guard)', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByTestId('preview-multi-edition')).toBeInTheDocument();
      });
      expect(screen.getAllByTestId('preview-multi-file')).toHaveLength(1);
      expect(screen.getAllByTestId('preview-multi-edition')).toHaveLength(1);
    });

    it('auto-suffix branch: the row equals the With-series leaf + " (Full Cast)" via real core helpers', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByTestId('preview-multi-edition')).toBeInTheDocument();
      });
      expect(screen.getByTestId('preview-multi-edition').textContent).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
    });

    it('renders the folder-only auto-edition note exactly once', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByText(/kept side-by-side automatically/)).toBeInTheDocument();
      });
      expect(screen.getAllByText(/kept side-by-side automatically/)).toHaveLength(1);
    });
  });

  describe('with-edition file preview (#1819)', () => {
    async function setupFileFormat(fileFormat: string) {
      const settings = createMockSettings({
        library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat, namingSeparator: 'space', namingCase: 'default' },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => {
        expect(screen.getByPlaceholderText('{author} - {title}')).toHaveValue(fileFormat);
      });
    }

    it('file field renders a "With edition" row; folder field does not', async () => {
      await setupFileFormat('{author} - {title}');
      await waitFor(() => {
        expect(screen.getByTestId('preview-file-edition')).toBeInTheDocument();
      });
      expect(screen.getAllByText('With edition')).toHaveLength(1);
      expect(screen.getAllByTestId('preview-file-edition')).toHaveLength(1);
    });

    it('row-shape guard: exactly one file edition row and one folder multiple-editions row', async () => {
      await setupFileFormat('{author} - {title}');
      await waitFor(() => {
        expect(screen.getByTestId('preview-file-edition')).toBeInTheDocument();
      });
      expect(screen.getAllByTestId('preview-file-edition')).toHaveLength(1);
      expect(screen.getAllByTestId('preview-multi-edition')).toHaveLength(1);
    });

    it('no {edition} token: shows the capability hint, not a With-series duplicate (AC2)', async () => {
      await setupFileFormat('{author} - {title}');
      await waitFor(() => {
        expect(screen.getByTestId('preview-file-edition')).toBeInTheDocument();
      });
      const row = screen.getByTestId('preview-file-edition');
      expect(row.textContent).toMatch(/Add \{edition\} to include the edition label in filenames/);
      const withSeriesFile = screen.getAllByTestId('preview-with-series')[1]!;
      expect(row.textContent).not.toBe(withSeriesFile.textContent);
    });

    it('bare {edition} token: renders the sample edition label with the .m4b suffix', async () => {
      await setupFileFormat('{author} - {title} ({edition})');
      await waitFor(() => {
        expect(screen.getByTestId('preview-file-edition')).toBeInTheDocument();
      });
      const row = screen.getByTestId('preview-file-edition');
      expect(row.textContent).toContain('Full Cast');
      expect(row.textContent).toContain('.m4b');
      expect(row.textContent).not.toMatch(/Add \{edition\}/);
    });

    it('reuses SAMPLE_EDITION (same "Full Cast" label as the folder multiple-editions row, AC5)', async () => {
      await setupFileFormat('{author} - {title} ({edition})');
      await waitFor(() => {
        expect(screen.getByTestId('preview-file-edition')).toBeInTheDocument();
      });
      expect(screen.getByTestId('preview-file-edition').textContent).toContain('Full Cast');
      expect(screen.getByTestId('preview-multi-edition').textContent).toContain('Full Cast');
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
      input.setSelectionRange(7, 7);
      fireEvent.keyDown(input, { key: 'Delete' });
      await waitFor(() => {
        expect(input.value).toBe('{title}');
      });
    });
  });

  describe('when the shared settings read fails', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks: these tests queue `*Once()` responses and
      // clearAllMocks does not drain those queues.
      vi.resetAllMocks();
    });

    it('reports the read failure instead of showing the default templates as saved formats', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<NamingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load file naming settings.')).toBeInTheDocument();
      });
      // "{author}/{title}" in Folder format reads as the operator's template; it is the
      // schema default, and a failed read never observed the saved one.
      expect(screen.queryByLabelText('Folder format')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('File format')).not.toBeInTheDocument();
    });

    it('refetches and restores the saved templates when the operator clicks Retry', async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ library: { folderFormat: '{authorLastFirst}/{titleSort}' } }));
      const user = userEvent.setup();

      renderWithProviders(<NamingSettingsSection />);
      await waitFor(() => expect(screen.getByText('Failed to load file naming settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading file naming settings' }));

      // The Last, First template, not the default "{author}/{title}": only a refetch yields it.
      await waitFor(() => expect(screen.getByLabelText('Folder format')).toHaveValue('{authorLastFirst}/{titleSort}'));
      expect(screen.queryByText('Failed to load file naming settings.')).not.toBeInTheDocument();
      expect(mockApi.getSettings).toHaveBeenCalledTimes(2);
    });

    it('hides an already-open token modal on a background failure, then restores it working on Retry', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      mockApi.getSettings.mockResolvedValueOnce(mockSettings);
      const user = userEvent.setup();

      renderWithProviders(<NamingSettingsSection />, { queryClient: client });
      await waitFor(() => expect(screen.getByLabelText('Folder format')).toHaveValue('{author}/{title}'));

      await user.click(screen.getByLabelText('Folder token reference'));
      expect(screen.getByText('Folder Token Reference')).toBeInTheDocument();

      // A background refetch failure reaches a card whose modal state is already non-null.
      mockApi.getSettings.mockRejectedValueOnce(new Error('settings unreadable'));
      await act(async () => { await client.refetchQueries({ queryKey: queryKeys.settings() }); });

      await waitFor(() => expect(screen.getByText('Failed to load file naming settings.')).toBeInTheDocument());
      expect(screen.queryByLabelText('Folder format')).not.toBeInTheDocument();
      // A form-only gate leaves this modal floating over the error card, with both input
      // refs nulled — every token button then silently no-ops at the null-ref guard.
      expect(screen.queryByText('Folder Token Reference')).toBeNull();

      mockApi.getSettings.mockResolvedValue(mockSettings);
      await user.click(screen.getByRole('button', { name: 'Retry loading file naming settings' }));

      // Scope was retained, not cleared, so the operator gets their place back.
      await waitFor(() => expect(screen.getByText('Folder Token Reference')).toBeInTheDocument());
      const input = screen.getByLabelText('Folder format') as HTMLInputElement;
      input.setSelectionRange(input.value.length, input.value.length);
      await user.click(screen.getByText('{series}'));

      // Insertion, not mere visibility: a dead modal over a remounted form still renders.
      await waitFor(() => expect(input.value).toBe('{author}/{title}{series}'));
    });

    it('leaves the modal closed on a failed read the operator never opened it for', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));

      renderWithProviders(<NamingSettingsSection />);

      await waitFor(() => expect(screen.getByText('Failed to load file naming settings.')).toBeInTheDocument());
      expect(screen.queryByText('Folder Token Reference')).toBeNull();
      expect(screen.queryByText('File Token Reference')).toBeNull();
    });
  });

});
