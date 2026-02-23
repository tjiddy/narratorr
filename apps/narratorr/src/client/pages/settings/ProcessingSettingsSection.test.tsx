import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { GeneralSettings } from './GeneralSettings';
import type { Mock } from 'vitest';
import type { Settings } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@narratorr/core/utils', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  ALLOWED_TOKENS: ['author', 'title', 'series', 'seriesPosition', 'year', 'narrator'],
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockSettings: Settings = createMockSettings();

beforeEach(() => {
  vi.clearAllMocks();
  (api.getSettings as Mock).mockResolvedValue(mockSettings);
});

describe('ProcessingSettingsSection', () => {
  it('renders Processing settings section with all fields', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Processing')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Enable Processing')).toBeInTheDocument();
    expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
    expect(screen.getByLabelText('Output Format')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeInTheDocument();
    expect(screen.getByLabelText('Merge Behavior')).toBeInTheDocument();
  });

  it('disables format/bitrate/merge fields when processing is disabled', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
    });

    // Processing is disabled by default
    expect(screen.getByLabelText('ffmpeg Path')).toBeDisabled();
    expect(screen.getByLabelText('Output Format')).toBeDisabled();
    expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeDisabled();
    expect(screen.getByLabelText('Merge Behavior')).toBeDisabled();
  });

  it('enables fields when processing toggle is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Processing')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Enable Processing'));

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).not.toBeDisabled();
    });
    expect(screen.getByLabelText('Output Format')).not.toBeDisabled();
    expect(screen.getByLabelText('Target Bitrate (kbps)')).not.toBeDisabled();
    expect(screen.getByLabelText('Merge Behavior')).not.toBeDisabled();
  });

  it('shows ffmpeg version on successful probe', async () => {
    const user = userEvent.setup();
    (api.probeFfmpeg as Mock).mockResolvedValue({ version: '6.1.1' });

    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/usr/bin/ffmpeg');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText(/ffmpeg 6\.1\.1 detected/)).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('ffmpeg 6.1.1 detected');
  });

  it('shows error toast on ffmpeg probe failure', async () => {
    const user = userEvent.setup();
    (api.probeFfmpeg as Mock).mockRejectedValue(new Error('spawn ENOENT'));

    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/bad/path', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/bad/path');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('spawn ENOENT');
    });
  });

  it('shows mp3 chapter warning when mp3 format selected', async () => {
    const user = userEvent.setup();
    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', bitrate: 128, mergeBehavior: 'multi-file-only' },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Output Format')).not.toBeDisabled();
    });

    await user.selectOptions(screen.getByLabelText('Output Format'), 'mp3');

    await waitFor(() => {
      expect(screen.getByText(/MP3 does not support embedded chapter markers/)).toBeInTheDocument();
    });
  });
});
