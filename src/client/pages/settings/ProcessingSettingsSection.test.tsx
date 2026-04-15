import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { ProcessingSettingsSection } from './ProcessingSettingsSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    probeFfmpeg: vi.fn(),
  },
}));

const { api } = await import('@/lib/api');
const { toast } = await import('sonner');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  probeFfmpeg: ReturnType<typeof vi.fn>;
};
const mockToast = toast as unknown as {
  success: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const defaultMockSettings = createMockSettings();
const enabledProcessingSettings = createMockSettings({
  processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
});

describe('ProcessingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(defaultMockSettings);
  });

  it('renders all processing fields when processing is enabled', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

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

  it('does not render processing child fields when processing is disabled', async () => {
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('ffmpeg Path')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Output Format')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Target Bitrate (kbps)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep original')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Merge Behavior')).not.toBeInTheDocument();
  });

  it('keeps Tag Embedding section visible when processing is disabled', async () => {
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Tag Embedding')).toBeInTheDocument();
  });

  it('keeps Custom Script section visible when processing is disabled', async () => {
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
  });

  it('renders processing child fields when processing toggle is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Enable Post Processing'));

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
      expect(screen.getByLabelText('Output Format')).toBeInTheDocument();
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeInTheDocument();
      expect(screen.getByLabelText('Keep original')).toBeInTheDocument();
      expect(screen.getByLabelText('Merge Behavior')).toBeInTheDocument();
    });
  });

  it('output format, merge behavior, and tag mode selects use shared SelectWithChevron contract', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText('Enable Post Processing'));

    await waitFor(() => {
      expect(screen.getByLabelText('Output Format')).toBeInTheDocument();
    });

    for (const label of ['Output Format', 'Merge Behavior']) {
      const select = screen.getByLabelText(label);
      expect(select).toHaveClass('appearance-none');
      expect(select.parentElement!.querySelector('svg')).toBeInTheDocument();
    }

    // Tag Mode requires tagging toggle
    await user.click(screen.getByLabelText('Tag Embedding'));
    await waitFor(() => {
      expect(screen.getByLabelText('Tag Mode')).toBeInTheDocument();
    });
    const tagSelect = screen.getByLabelText('Tag Mode');
    expect(tagSelect).toHaveClass('appearance-none');
    expect(tagSelect.parentElement!.querySelector('svg')).toBeInTheDocument();
  });

  it('disables bitrate input when "Keep original" is checked', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

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
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    mockApi.probeFfmpeg.mockResolvedValue({ version: '6.1.1' });
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/usr/bin/ffmpeg');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText(/ffmpeg 6\.1\.1 detected/)).toBeInTheDocument();
    });
    expect(mockToast.success).toHaveBeenCalledWith('ffmpeg 6.1.1 detected');
  });

  it('shows error toast on ffmpeg probe failure', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      processing: { enabled: true, ffmpegPath: '/bad/path', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    }));
    mockApi.probeFfmpeg.mockRejectedValue(new Error('spawn ENOENT'));
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/bad/path');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('spawn ENOENT');
    });
  });

  it('shows stringified feedback and toast when ffmpeg probe rejects a non-Error value', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      processing: { enabled: true, ffmpegPath: '/bad/path', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
    }));
    mockApi.probeFfmpeg.mockRejectedValue('string-rejection');
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/bad/path');
    });

    await user.click(screen.getByText('Test'));

    await waitFor(() => {
      expect(screen.getByText('string-rejection')).toBeInTheDocument();
    });
    expect(mockToast.error).toHaveBeenCalledWith('string-rejection');
  });

  it('renders tag embedding toggle but not tag controls when tagging is disabled', async () => {
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Embedding')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('Tag Mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Embed Cover Art')).not.toBeInTheDocument();
  });

  it('renders tag controls when tagging toggle is turned on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Embedding')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Tag Embedding'));

    await waitFor(() => {
      expect(screen.getByLabelText('Tag Mode')).toBeInTheDocument();
      expect(screen.getByLabelText('Embed Cover Art')).toBeInTheDocument();
    });
  });

  it('renders max concurrent jobs field', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Max Concurrent Jobs')).not.toBeDisabled();
      expect(screen.getByLabelText('Max Concurrent Jobs')).toHaveValue(2);
    });
  });

  it('does not render max concurrent jobs when processing is disabled', async () => {
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    expect(screen.queryByLabelText('Max Concurrent Jobs')).not.toBeInTheDocument();
  });

  it('shows mp3 chapter warning when mp3 format selected', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Output Format')).not.toBeDisabled();
    });

    await user.selectOptions(screen.getByLabelText('Output Format'), 'mp3');

    await waitFor(() => {
      expect(screen.getByText(/MP3 does not support embedded chapter markers/)).toBeInTheDocument();
    });
  });

  it('sends processing and tagging categories on save', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    mockApi.updateSettings.mockResolvedValue(enabledProcessingSettings);
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toHaveValue('/usr/bin/ffmpeg');
    });

    // Make form dirty by toggling tagging
    await user.click(screen.getByLabelText('Tag Embedding'));

    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        processing: {
          enabled: true,
          ffmpegPath: '/usr/bin/ffmpeg',
          outputFormat: 'm4b',
          keepOriginalBitrate: false,
          bitrate: 128,
          mergeBehavior: 'multi-file-only',
          maxConcurrentProcessing: 2,
          postProcessingScript: '',
          postProcessingScriptTimeout: 300,
        },
        tagging: {
          enabled: true,
          mode: 'populate_missing',
          embedCover: false,
        },
      });
    });
  });

  it('blocks submit when processing enabled with empty ffmpegPath', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(defaultMockSettings);
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    // Enable processing (ffmpegPath is still empty)
    await user.click(screen.getByLabelText('Enable Post Processing'));

    await waitFor(() => {
      expect(screen.getByLabelText('ffmpeg Path')).toBeInTheDocument();
    });

    // Submit without filling ffmpegPath
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
    });

    expect(screen.getByText(/ffmpeg path is required when processing is enabled/i)).toBeInTheDocument();
    expect(mockApi.updateSettings).not.toHaveBeenCalled();
  });

  describe('post-processing script', () => {
    it('renders script path and timeout fields', async () => {
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
      });

      expect(screen.getByLabelText('Script Timeout (seconds)')).toBeInTheDocument();
    });

    it('round-trips script path and timeout through save', async () => {
      const user = userEvent.setup();
      mockApi.updateSettings.mockResolvedValue(defaultMockSettings);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Post-Processing Script')).toBeInTheDocument();
      });

      const scriptInput = screen.getByLabelText('Post-Processing Script');
      await user.type(scriptInput, '/scripts/post.sh');

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '60');

      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalled();
      });
      expect(mockApi.updateSettings.mock.calls[0][0]).toMatchObject({
        processing: expect.objectContaining({
          postProcessingScript: '/scripts/post.sh',
          postProcessingScriptTimeout: 60,
        }),
      });
    });

    it('shows validation error when timeout is cleared with script path present', async () => {
      const user = userEvent.setup();
      const settingsWithScript = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithScript);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      expect(screen.getByText('Timeout is required when a post-processing script is configured')).toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  it('shows success toast on save', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    mockApi.updateSettings.mockResolvedValue(enabledProcessingSettings);
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    // Make dirty
    await user.click(screen.getByLabelText('Tag Embedding'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.success).toHaveBeenCalledWith('Processing settings saved');
    });
  });

  it('shows error toast on save failure', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    mockApi.updateSettings.mockRejectedValue(new Error('Server error'));
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText('Tag Embedding'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith('Server error');
    });
  });

  it('shows reduced opacity on bitrate input when "Keep original" is checked', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).not.toBeDisabled();
    });

    await user.click(screen.getByLabelText('Keep original'));

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeDisabled();
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toHaveClass('disabled:opacity-50');
    });
  });

  it('re-enables bitrate input when "Keep original" is unchecked', async () => {
    const user = userEvent.setup();
    mockApi.getSettings.mockResolvedValue(
      createMockSettings({ processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: true, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 } })
    );
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).toBeDisabled();
    });

    await user.click(screen.getByLabelText('Keep original'));

    await waitFor(() => {
      expect(screen.getByLabelText('Target Bitrate (kbps)')).not.toBeDisabled();
    });
  });

  describe('schema preprocess and boundary values', () => {
    it('accepts postProcessingScriptTimeout of exactly 1 (min boundary)', async () => {
      const user = userEvent.setup();
      const settingsWithScript = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithScript);
      mockApi.updateSettings.mockResolvedValue(settingsWithScript);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '1');

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            processing: expect.objectContaining({
              postProcessingScript: '/scripts/post.sh',
              postProcessingScriptTimeout: 1,
            }),
          }),
        );
      });
    });

    it('rejects postProcessingScriptTimeout of 0 (below min)', async () => {
      const user = userEvent.setup();
      const settingsWithScript = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithScript);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '0');

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });

    it('rejects decimal postProcessingScriptTimeout (non-integer)', async () => {
      const user = userEvent.setup();
      const settingsWithScript = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithScript);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);
      await user.type(timeoutInput, '1.5');

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).not.toHaveBeenCalled();
      });
    });

    it('handles NaN postProcessingScriptTimeout when script is empty — no validation error', async () => {
      const user = userEvent.setup();
      const settingsWithTimeout = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithTimeout);
      mockApi.updateSettings.mockResolvedValue(settingsWithTimeout);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      // Clear the timeout — valueAsNumber produces NaN, preprocess converts to undefined
      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            processing: expect.objectContaining({
              postProcessingScript: '',
              postProcessingScriptTimeout: undefined,
            }),
          }),
        );
      });
    });

    it('handles NaN postProcessingScriptTimeout when script is set — validation error fires', async () => {
      const user = userEvent.setup();
      const settingsWithScript = createMockSettings({
        processing: { enabled: false, ffmpegPath: '', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '/scripts/post.sh', postProcessingScriptTimeout: 60 },
      });
      mockApi.getSettings.mockResolvedValue(settingsWithScript);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Script Timeout (seconds)')).toHaveValue(60);
      });

      const timeoutInput = screen.getByLabelText('Script Timeout (seconds)');
      await user.clear(timeoutInput);

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      expect(screen.getByText('Timeout is required when a post-processing script is configured')).toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe('cross-category form model preservation', () => {
    it('save payload includes both processing and tagging categories', async () => {
      const user = userEvent.setup();
      const settings = createMockSettings({
        processing: { enabled: true, ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', keepOriginalBitrate: false, bitrate: 128, mergeBehavior: 'multi-file-only', maxConcurrentProcessing: 2, postProcessingScript: '', postProcessingScriptTimeout: 300 },
        tagging: { enabled: false, mode: 'populate_missing', embedCover: true },
      });
      mockApi.getSettings.mockResolvedValue(settings);
      mockApi.updateSettings.mockResolvedValue(settings);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
      });

      // Toggle tagging to make dirty
      await user.click(screen.getByLabelText('Tag Embedding'));
      fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

      await waitFor(() => {
        const call = mockApi.updateSettings.mock.calls[0][0];
        expect(call).toHaveProperty('processing');
        expect(call).toHaveProperty('tagging');
        expect(call.processing).toMatchObject({ enabled: true, ffmpegPath: '/usr/bin/ffmpeg' });
        // Tag Embedding was toggled: enabled false → true, embedCover stays true
        expect(call.tagging).toMatchObject({ enabled: true, mode: 'populate_missing', embedCover: true });
      });
    });

    it('tagging toggle state survives processing validation failure and correction', async () => {
      const user = userEvent.setup();
      mockApi.getSettings.mockResolvedValue(defaultMockSettings);
      mockApi.updateSettings.mockResolvedValue(defaultMockSettings);
      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByLabelText('Enable Post Processing')).toBeInTheDocument();
      });

      // Toggle tagging on
      await user.click(screen.getByLabelText('Tag Embedding'));

      // Enable processing without ffmpegPath → validation error
      await user.click(screen.getByLabelText('Enable Post Processing'));

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      expect(screen.getByText('ffmpeg path is required when processing is enabled')).toBeInTheDocument();
      expect(mockApi.updateSettings).not.toHaveBeenCalled();

      // Fix the validation error
      const ffmpegInput = screen.getByLabelText('ffmpeg Path');
      await user.type(ffmpegInput, '/usr/bin/ffmpeg');

      await act(async () => {
        fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);
      });

      await waitFor(() => {
        expect(mockApi.updateSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            tagging: expect.objectContaining({
              // Tag Embedding was toggled on before the validation failure
              enabled: true,
            }),
          }),
        );
      });
    });
  });

  it('renders Keep Original toggle as a compact hidden-checkbox slider (sr-only peer pattern)', async () => {
    mockApi.getSettings.mockResolvedValue(enabledProcessingSettings);
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => {
      expect(screen.getByLabelText('Keep original')).toBeInTheDocument();
    });

    const checkbox = screen.getByLabelText('Keep original');
    // Checkbox must be visually hidden (sr-only) — not a raw visible checkbox
    expect(checkbox).toHaveClass('sr-only');
    // Compact slider track div (w-9 h-5) must be rendered immediately after the hidden checkbox
    const sliderTrack = checkbox.nextElementSibling as HTMLElement | null;
    expect(sliderTrack).toBeInTheDocument();
    expect(sliderTrack!.tagName).toBe('DIV');
    expect(sliderTrack).toHaveClass('rounded-full');
    expect(sliderTrack).toHaveClass('w-9');
    expect(sliderTrack).toHaveClass('h-5');
  });
});
