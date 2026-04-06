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
  metadata: { audibleRegion: 'us' },
  quality: { rejectWords: 'German', requiredWords: 'M4B', preferredLanguage: 'english' },
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

  it('renders preferred language input with server value', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Preferred Language')).toHaveValue('english');
    });
  });

  it('renders reject words input with server value', async () => {
    renderWithProviders(<FilteringSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Reject Words')).toHaveValue('German');
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
        metadata: { audibleRegion: 'us' },
        quality: { rejectWords: 'Abridged', requiredWords: 'M4B', preferredLanguage: 'english' },
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
});
