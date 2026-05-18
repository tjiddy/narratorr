import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { FilteringSettingsSection } from './FilteringSettingsSection';

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
  metadata: { audibleRegion: 'us', languages: ['english'] },
  quality: { rejectWords: 'German', requiredWords: 'M4B' },
});

describe('FilteringSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('does NOT render the Region select (moved to Metadata section)', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Region')).not.toBeInTheDocument();
  });

  it('does NOT render the Hardcover API Key input (moved to Metadata section)', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Hardcover API Key')).not.toBeInTheDocument();
  });

  it('renders languages checkbox grid with English checked', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });
    const checkboxes = screen.getAllByRole('checkbox');
    const englishCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('english'));
    expect(englishCheckbox).toBeChecked();
  });

  it('renders reject words input with server value', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });
  });

  it('renders minimum-duration input with server value (#987)', async () => {
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({
        metadata: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 30 },
        quality: { rejectWords: 'German', requiredWords: 'M4B' },
      }),
    );
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Minimum Duration (minutes)')).toHaveValue(30);
    });
  });

  it('saves minDurationMinutes through the metadata half of the split payload (#987)', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });

    const durationInput = screen.getByLabelText('Minimum Duration (minutes)');
    await user.tripleClick(durationInput);
    await user.keyboard('30');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { languages: ['english'], minDurationMinutes: 30 },
        quality: { rejectWords: 'German', requiredWords: 'M4B' },
      });
    });
  });

  it('renders required words input with server value', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Required Words')).toHaveValue('M4B');
    });
  });

  it('reject words placeholder includes Abridged in the new packaged default', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    const placeholder = await screen.findByPlaceholderText(
      'Virtual Voice, Free Excerpt, Sample, Behind the Scenes, Abridged',
    );
    expect(placeholder).toBeInTheDocument();
  });

  it('reject words help text mentions format type in the surface description', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/title, subtitle, author, narrator, or format type/i),
    ).toBeInTheDocument();
  });

  it('saves split payload: metadata.languages + quality filtering fields', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });

    const rejectInput = screen.getByLabelText('Reject Words');
    await user.tripleClick(rejectInput);
    await user.keyboard('Abridged');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { languages: ['english'], minDurationMinutes: 0 },
        quality: { rejectWords: 'Abridged', requiredWords: 'M4B' },
      });
    });
    const payload = mockApi.updateSettings.mock.calls[0]![0] as Record<string, Record<string, unknown>>;
    expect(payload.metadata).not.toHaveProperty('audibleRegion');
    expect(payload.metadata).not.toHaveProperty('hardcoverApiKey');
  });

  it('hides save button when form is not dirty', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('shows success toast after save', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });

    const rejectInput = screen.getByLabelText('Reject Words');
    await user.tripleClick(rejectInput);
    await user.keyboard('changed');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Filtering settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });

    const rejectInput = screen.getByLabelText('Reject Words');
    await user.tripleClick(rejectInput);
    await user.keyboard('changed');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Server error');
    });
  });

  describe('languages multi-select', () => {
    it('renders checkbox grid with all CANONICAL_LANGUAGES options', async () => {
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes).toHaveLength(36);
      expect(screen.getByText('english')).toBeInTheDocument();
      expect(screen.getByText('french')).toBeInTheDocument();
      expect(screen.getByText('german')).toBeInTheDocument();
      expect(screen.getByText('japanese')).toBeInTheDocument();
      expect(screen.getByText('vietnamese')).toBeInTheDocument();
    });

    it('checks English by default on fresh install', async () => {
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      const englishCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('english'));
      expect(englishCheckbox).toBeChecked();

      const frenchCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('french'));
      expect(frenchCheckbox).not.toBeChecked();
    });

    it('selecting a language marks form dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

      const checkboxes = screen.getAllByRole('checkbox');
      const frenchCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('french'));
      await user.click(frenchCheckbox!);

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('deselecting a language marks form dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

      const checkboxes = screen.getAllByRole('checkbox');
      const englishCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('english'));
      await user.click(englishCheckbox!);

      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('saves languages to metadata settings category', async () => {
      mockApi.updateSettings.mockResolvedValue(mockSettings);
      const user = userEvent.setup();
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      const frenchCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('french'));
      await user.click(frenchCheckbox!);

      await user.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({
              languages: expect.arrayContaining(['english', 'french']),
            }),
          }),
        );
      });
    });

    it('preferredLanguage text field is removed', async () => {
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      expect(screen.queryByLabelText('Preferred Language')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/preferredLanguage/i)).not.toBeInTheDocument();
    });
  });
});
