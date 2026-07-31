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

// keepOriginalBitrate:false so Target bitrate starts enabled; automation + tagging fields are set
// so the save-subset test can prove they are NOT sent from this page.
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

  it('renders the Merge & Convert engine fields', async () => {
    renderWithProviders(<AudioToolsSettings />);
    await waitFor(() => expect(screen.getByText('Merge & Convert')).toBeInTheDocument());
    expect(screen.getByLabelText('Output format')).toBeInTheDocument();
    expect(screen.getByLabelText('Keep original bitrate')).toBeInTheDocument();
    expect(screen.getByLabelText('Target bitrate')).toBeInTheDocument();
    expect(screen.getByLabelText('Max concurrent jobs')).toBeInTheDocument();
  });

  // #2056 — the knob is gone, but the copy describing the format conversion the MERGE path performs
  // is not: the card is still named for it, and the ffmpeg-missing notice still has to warn that
  // conversion stops without the binary. Guards both directions of the removal (the row's absence
  // and the surviving copy) so a blanket rename can't pass as a cleanup.
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
    expect(screen.getByText(/Merge, Convert and Tag Embedding stay off until it resolves/)).toBeInTheDocument();
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
    // A failed status query is a connection/auth problem, not a missing binary — don't send the
    // operator chasing an install.
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
    await user.click(screen.getByLabelText('Keep original bitrate')); // make the form dirty
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown> };
    expect(payload).not.toHaveProperty('tagging');
    // EXACT shape, not objectContaining: this is the page's whole outgoing contract, so it has to
    // fail on any key the form should not be sending. That covers both directions at once — the
    // automation fields belonging to Post Processing (partial patch), and a retired engine field
    // sneaking back through audioToolsSchema/toFormData without its visible row (#2056). Per-key
    // `not.toHaveProperty` negatives would be subsumed by this and could never fail on their own.
    expect(payload.processing).toEqual({
      outputFormat: 'm4b',
      keepOriginalBitrate: true,
      bitrate: 128,
      maxConcurrentProcessing: 1,
    });
  });
});
