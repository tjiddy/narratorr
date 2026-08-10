import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { AudioToolsSettings } from './AudioToolsSettings';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({
  api: { getSettings: vi.fn(), updateSettings: vi.fn(), getFfmpegStatus: vi.fn() },
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  getFfmpegStatus: ReturnType<typeof vi.fn>;
};

// Keep original off enables Target bitrate; seeded automation/tagging fields prove the subset omits them.
const settings = createMockSettings({
  processing: {
    outputFormat: 'm4b',
    keepOriginalBitrate: false,
    bitrate: 128,
    maxConcurrentProcessing: 1,
    autoMergeDownloads: true,
    postProcessingScript: '/x.sh',
    postProcessingScriptTimeout: 300,
  },
});

describe('AudioToolsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
  });

  // Exact matches pin reviewed runtime guarantees that have previously drifted.
  const KEEP_ORIGINAL_DESCRIPTION =
    'Copies the audio when the parts are compatible. Otherwise re-encodes using the source '
    + 'bitrate where it is known, or a conservative default where it is not, adjusted to a '
    + 'value the output format accepts.';
  const TARGET_BITRATE_DESCRIPTION =
    'The bitrate to encode to \u2014 active only when Keep original is off. MP3 output rounds '
    + 'down to the next supported rate \u2014 or up to the minimum, if lower \u2014 and its '
    + 'maximum depends on the source sample rate.';

  it('describes the bitrate controls in the exact pinned wording', async () => {
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText('Merge & Convert')).toBeInTheDocument());

    expect(screen.getByText(KEEP_ORIGINAL_DESCRIPTION)).toBeInTheDocument();
    expect(screen.getByText(TARGET_BITRATE_DESCRIPTION)).toBeInTheDocument();

    // AC8 snaps down (251→224 at 44.1 kHz), so proximity wording would be false.
    for (const copy of [KEEP_ORIGINAL_DESCRIPTION, TARGET_BITRATE_DESCRIPTION]) {
      expect(copy).not.toMatch(/close|closest|nearest/i);
    }
  });

  it('renders the Merge & Convert engine fields', async () => {
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText('Merge & Convert')).toBeInTheDocument());
    expect(screen.getByLabelText('Output format')).toBeInTheDocument();
    expect(screen.getByLabelText('Keep original bitrate')).toBeInTheDocument();
    expect(screen.getByLabelText('Target bitrate')).toBeInTheDocument();
    expect(screen.getByLabelText('Max concurrent jobs')).toBeInTheDocument();
  });

  it('drops the Merge behavior row while keeping the format-conversion copy', async () => {
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText('Merge & Convert')).toBeInTheDocument());
    expect(screen.queryByLabelText('Merge behavior')).not.toBeInTheDocument();
    expect(screen.queryByText('Only when multiple files')).not.toBeInTheDocument();
    expect(screen.getByText(/Applies wherever audio is merged or converted/)).toBeInTheDocument();
  });

  it('keeps the Convert wording in the ffmpeg-missing notice — it describes the merge path’s encode', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText(/ffmpeg not found/)).toBeInTheDocument());
    expect(screen.getByText(/Merge and Convert stay off until it resolves/)).toBeInTheDocument();
  });

  it('no longer lists Tag Embedding in the ffmpeg-missing notice — it gates on mutagen now', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText(/ffmpeg not found/)).toBeInTheDocument());
    expect(screen.queryByText(/Tag Embedding/)).not.toBeInTheDocument();
  });

  it('shows the detected ffmpeg status (version + path) with no setup copy on the happy path', async () => {
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText(/Detected · v8\.0\.1/)).toBeInTheDocument());
    expect(screen.getByText('/usr/bin/ffmpeg')).toBeInTheDocument();
    expect(screen.queryByText(/FFMPEG_PATH/)).not.toBeInTheDocument();
  });

  it('shows the not-found status with setup copy only when ffmpeg is absent', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText(/ffmpeg not found/)).toBeInTheDocument());
    expect(screen.getByText(/FFMPEG_PATH/)).toBeInTheDocument();
  });

  it('shows a distinct "unable to check" state when the status query errors — not "not found" (finding 6)', async () => {
    mockApi.getFfmpegStatus.mockRejectedValue(new Error('network down'));
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText(/Unable to check ffmpeg status/)).toBeInTheDocument());
    expect(screen.queryByText(/ffmpeg not found/)).not.toBeInTheDocument();
  });

  it('disables Target bitrate while Keep original is on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByLabelText('Target bitrate')).toBeEnabled());
    await user.click(screen.getByLabelText('Keep original bitrate'));
    expect(screen.getByLabelText('Target bitrate')).toBeDisabled();
  });

  it('saves ONLY the processing engine subset — never automation or tagging fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByLabelText('Keep original bitrate')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Keep original bitrate'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown> };
    expect(payload).not.toHaveProperty('tagging');
    // Exact shape catches any automation or retired engine field added to this page's payload.
    expect(payload.processing).toEqual({
      outputFormat: 'm4b',
      keepOriginalBitrate: true,
      bitrate: 128,
      maxConcurrentProcessing: 1,
    });
  });
});
