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

  it('renders region dropdown with label "Region"', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });
    expect(screen.queryByText('Audible Region')).not.toBeInTheDocument();
  });

  it('renders all 10 region options with country names', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
    });

    const options = screen.getByLabelText('Region').querySelectorAll('option');
    expect(options).toHaveLength(10);

    const labels = Array.from(options).map((o) => o.textContent);
    expect(labels).toContain('United States');
    expect(labels).toContain('United Kingdom');
    expect(labels).toContain('Canada');
    expect(labels).toContain('Australia');
    expect(labels).toContain('France');
    expect(labels).toContain('Germany');
    expect(labels).toContain('Japan');
    expect(labels).toContain('Italy');
    expect(labels).toContain('India');
    expect(labels).toContain('Spain');
    // Verify old Audible.com labels are NOT used
    expect(labels).not.toContain('Audible.com (US)');
  });

  it('renders languages checkbox grid with English checked', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByText('Languages')).toBeInTheDocument();
    });
    // English should be checked based on metadata.languages: ['english']
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

    // Wait for the loaded mockSettings to populate the form (rather than just the defaults)
    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
    });

    const durationInput = screen.getByLabelText('Minimum Duration (minutes)');
    await user.tripleClick(durationInput);
    await user.keyboard('30');

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 30 },
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

  it('saves split payload: metadata.audibleRegion + quality filtering fields', async () => {
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
        metadata: { audibleRegion: 'us', languages: ['english'], minDurationMinutes: 0 },
        quality: { rejectWords: 'Abridged', requiredWords: 'M4B' },
      });
    });
  });

  it('submits changed region through the metadata half of split payload', async () => {
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    const user = userEvent.setup();
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toHaveValue('us');
    });

    // Change region to Germany
    await user.selectOptions(screen.getByLabelText('Region'), 'de');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { audibleRegion: 'de', languages: ['english'], minDurationMinutes: 0 },
        quality: { rejectWords: 'German', requiredWords: 'M4B' },
      });
    });
  });

  it('hides save button when form is not dirty', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Region')).toBeInTheDocument();
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
      // 36 canonical languages (CANONICAL_LANGUAGES has 36 entries)
      expect(checkboxes).toHaveLength(36);
      // Spot-check a few labels
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

      // Other languages should not be checked
      const frenchCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('french'));
      expect(frenchCheckbox).not.toBeChecked();
    });

    it('selecting a language marks form dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      // Save button should not be visible initially
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

      // Click the french checkbox
      const checkboxes = screen.getAllByRole('checkbox');
      const frenchCheckbox = checkboxes.find((cb) => cb.closest('label')?.textContent?.includes('french'));
      await user.click(frenchCheckbox!);

      // Form should now be dirty — save button visible
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    });

    it('deselecting a language marks form dirty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<FilteringSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Languages')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();

      // Deselect english (which is currently checked)
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

      // Select french in addition to english
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
