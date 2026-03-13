import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { MetadataSettingsForm } from './MetadataSettingsForm';

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

const mockSettings = createMockSettings({ metadata: { audibleRegion: 'uk' } });

describe('MetadataSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettings);
  });

  it('renders audible region select populated from API settings', async () => {
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });
  });

  it('hides save button when form is clean', async () => {
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('shows save button enabled when region is changed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });

    await user.selectOptions(screen.getByLabelText('Audible Region'), 'us');
    expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
  });

  it('sends metadata category payload with audibleRegion on save', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });

    await user.selectOptions(screen.getByLabelText('Audible Region'), 'de');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        metadata: { audibleRegion: 'de' },
      });
    });
  });

  it('shows success toast on save', async () => {
    const user = userEvent.setup();
    mockApi.updateSettings.mockResolvedValue(mockSettings);
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });

    await user.selectOptions(screen.getByLabelText('Audible Region'), 'us');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Metadata settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.updateSettings.mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderWithProviders(<MetadataSettingsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText('Audible Region')).toHaveValue('uk');
    });

    await user.selectOptions(screen.getByLabelText('Audible Region'), 'de');
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Network error');
    });
  });
});
