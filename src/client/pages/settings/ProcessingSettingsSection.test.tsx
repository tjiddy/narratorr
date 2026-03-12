import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
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

vi.mock('../../../core/utils/index.js', () => ({
  renderTemplate: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  renderFilename: (template: string) => template.replace('{author}', 'Author').replace('{title}', 'Title'),
  toLastFirst: (name: string) => name,
  toSortTitle: (title: string) => title,
  ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst'],
  FILE_ALLOWED_TOKENS: ['author', 'authorLastFirst', 'title', 'titleSort', 'series', 'seriesPosition', 'year', 'narrator', 'narratorLastFirst', 'trackNumber', 'trackTotal', 'partName'],
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const mockSettings: Settings = createMockSettings();

beforeEach(() => {
  vi.clearAllMocks();
  (api.getSettings as Mock).mockResolvedValue(mockSettings);
});

describe('ProcessingSettingsSection', () => {
  it('renders Post Processing section with all fields', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByText('Post Processing')).toBeInTheDocument();
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
      expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
      expect(screen.getByLabelText('Output Format')).toBeInTheDocument();
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeInTheDocument();
      expect(screen.getByLabelText('Keep original')).toBeInTheDocument();
      expect(screen.getByLabelText('Merge Behavior')).toBeInTheDocument();
    });
  });

  it('disables format/bitrate/merge fields when processing is disabled', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
    });

    // Processing is disabled by default
    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toBeDisabled();
      expect(screen.getByLabelText('Output Format')).toBeDisabled();
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeDisabled();
      expect(screen.getByLabelText('Keep original')).toBeDisabled();
      expect(screen.getByLabelText('Merge Behavior')).toBeDisabled();
    });
  });

  it('enables fields when processing toggle is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Enable Post Processing'));

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).not.toBeDisabled();
      expect(screen.getByLabelText('Output Format')).not.toBeDisabled();
      expect(screen.getByLabelText('Target Bitrate (kbps)')).not.toBeDisabled();
      expect(screen.getByLabelText('Keep original')).not.toBeDisabled();
      expect(screen.getByLabelText('Merge Behavior')).not.toBeDisabled();
    });
  });

  it('disables bitrate input when "Keep original" is checked', async () => {
    const user = userEvent.setup();
    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).not.toBeDisabled();
    });

    await user.click(screen.getByLabelText('Keep original'));

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeDisabled();
      expect(screen.getByText('Files will be re-encoded using the original source bitrate.')).toBeInTheDocument();
    });
  });

  it('shows ffmpeg version on successful probe', async () => {
    const user = userEvent.setup();
    (api.probeFfmpeg as Mock).mockResolvedValue({ version: '6.1.1' });

    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/usr/bin/ffmpeg');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText(/ffmpeg 6\.1\.1 detected/)).toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('ffmpeg 6.1.1 detected');
    });
  });

  it('shows error toast on ffmpeg probe failure', async () => {
    const user = userEvent.setup();
    (api.probeFfmpeg as Mock).mockRejectedValue(new Error('spawn ENOENT'));

    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/bad/path', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
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

  it('renders tag embedding controls', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Embedding')).toBeInTheDocument();
      expect(screen.getByLabelText('Tag Mode')).toBeInTheDocument();
      expect(screen.getByLabelText('Embed Cover Art')).toBeInTheDocument();
    });
  });

  it('disables tag mode and cover when tagging is disabled', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Mode')).toBeInTheDocument();
    });

    // Tagging is disabled by default
    await waitFor(() => {
      expect(screen.getByLabelText('Tag Mode')).toBeDisabled();
    });
  });

  it('enables tag controls when tagging toggle is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Embedding')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Tag Embedding'));

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Mode')).not.toBeDisabled();
    });
  });

  it('renders max concurrent jobs field when processing is enabled', async () => {
    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Concurrent Jobs')).not.toBeDisabled();
      expect(screen.getByLabelText('Max Concurrent Jobs')).toHaveValue(2);
    });
  });

  it('disables max concurrent jobs field when processing is disabled', async () => {
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Concurrent Jobs')).toBeInTheDocument();
      expect(screen.getByLabelText('Max Concurrent Jobs')).toBeDisabled();
    });
  });

  it('allows changing max concurrent jobs value', async () => {
    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    });
    (api.getSettings as Mock).mockResolvedValue(settingsWithProcessing);
    renderWithProviders(<GeneralSettings />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Concurrent Jobs')).not.toBeDisabled();
    });

    const input = screen.getByLabelText('Max Concurrent Jobs');
    fireEvent.change(input, { target: { value: '4' } });
    await waitFor(() => {
      expect(input).toHaveValue(4);
    });
  });

  describe('post-processing script fields', () => {
    it('renders script path text input in Post Processing section', async () => {
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
      });
    });

    it('renders script timeout number input with placeholder 300', async () => {
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        const input = screen.getByLabelText('Script Timeout (seconds)');
        expect(input).toBeInTheDocument();
        expect(input).toHaveAttribute('placeholder', '300');
      });
    });

    it('timeout field has min=1 attribute', async () => {
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveAttribute('min', '1');
      });
    });

    it('timeout field prefilled with stored value from settings', async () => {
      const settingsWithScript: Settings = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      (api.getSettings as Mock).mockResolvedValue(settingsWithScript);
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });
    });

    it('allows entering a script path', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
      });

      const input = screen.getByLabelText('Post-Processing Script');
      await user.type(input, '/scripts/post-import.sh');
      expect(input).toHaveValue('/scripts/post-import.sh');
    });

    it('round-trips script path and timeout through save', async () => {
      const user = userEvent.setup();
      (api.updateSettings as Mock).mockResolvedValue(mockSettings);
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
      });

      const scriptInput = screen.getByLabelText('Post-Processing Script');
      await user.type(scriptInput, '/scripts/post.sh');

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '60');

      await user.click(screen.getByText('Save Changes').closest('button')!);

      await waitFor(() => {
        expect(api.updateSettings).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect((api.updateSettings as Mock).mock.calls[0][0]).toMatchObject({
          processing: expect.objectContaining({
            postProcessingScript: '/scripts/post.sh',
            postProcessingScriptTimeout: 60,
          }),
        });
      });
    });

    it('shows validation error when timeout is cleared with script path present', async () => {
      const user = userEvent.setup();
      const settingsWithScript: Settings = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      (api.getSettings as Mock).mockResolvedValue(settingsWithScript);
      renderWithProviders(<GeneralSettings />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);

      await user.click(screen.getByText('Save Changes').closest('button')!);

      await waitFor(() => {
        expect(screen.getByText('Timeout is required when a post-processing script is configured')).toBeInTheDocument();
      });
      expect(api.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('shows mp3 chapter warning when mp3 format selected', async () => {
    const user = userEvent.setup();
    const settingsWithProcessing: Settings = createMockSettings({
      processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
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
