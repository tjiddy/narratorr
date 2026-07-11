import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { ProcessingSettingsSection } from './ProcessingSettingsSection';

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

// Engine fields set so the save-subset test can prove they are NOT sent from this page.
const settings = createMockSettings({
  processing: { autoMergeDownloads: false, postProcessingScript: '', postProcessingScriptTimeout: 300, outputFormat: 'm4b', mergeBehavior: 'multi-file-only', bitrate: 128 },
  tagging: { enabled: false, mode: 'populate_missing', embedCover: false, writeOpf: false },
});

describe('ProcessingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
  });

  it('renders the automation rows', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByText('Post Processing')).toBeInTheDocument());
    expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tag Embedding/)).toBeInTheDocument();
    expect(screen.getByLabelText('OPF metadata sidecar')).toBeInTheDocument();
    expect(screen.getByLabelText('Post-processing script')).toBeInTheDocument();
  });

  it('enables the ffmpeg-dependent automations and shows the Audio Tools breadcrumb when ffmpeg is detected', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
    expect(screen.getByText(/uses your Merge & Convert settings/)).toBeInTheDocument();
    expect(screen.queryByText(/needs ffmpeg/i)).not.toBeInTheDocument();
  });

  it('gates auto-merge and Tag Embedding when ffmpeg is missing, but leaves OPF + custom script usable', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeDisabled();
    // Both gated rows point the user at Audio Tools.
    expect(screen.getAllByText(/see ffmpeg requirements in Audio Tools/).length).toBeGreaterThanOrEqual(2);
    // ffmpeg-free automations stay available.
    expect(screen.getByLabelText('OPF metadata sidecar')).toBeEnabled();
    expect(screen.getByLabelText('Post-processing script')).toBeEnabled();
  });

  it('fails safe — gates auto-merge + Tag Embedding when the status query errors', async () => {
    mockApi.getFfmpegStatus.mockRejectedValue(new Error('network down'));
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeDisabled();
  });

  it('lets an ALREADY-ENABLED automation be switched off when ffmpeg is missing (finding 4)', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      processing: { autoMergeDownloads: true },
      tagging: { enabled: true },
    }));
    renderWithProviders(<ProcessingSettingsSection />);
    // ffmpeg gone but the automation was ON — the toggle stays interactive so it can be turned OFF
    // (only false→true is blocked, never true→false; otherwise the setting is stuck-on forever).
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
  });

  it('keeps a DISABLED automation locked off when ffmpeg is missing (finding 4)', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      processing: { autoMergeDownloads: false },
      tagging: { enabled: false },
    }));
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeDisabled();
  });

  it('reveals tag mode + embed cover only while Tag Embedding is on', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Tag Embedding/)).toBeInTheDocument());
    expect(screen.queryByLabelText('Tag mode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Embed cover art')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/Tag Embedding/));
    expect(screen.getByLabelText('Tag mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Embed cover art')).toBeInTheDocument();
  });

  it('saves ONLY the automation + tagging subset — never the engine fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText('OPF metadata sidecar')).toBeInTheDocument());
    await user.click(screen.getByLabelText('OPF metadata sidecar')); // make the form dirty
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown>; tagging: Record<string, unknown> };
    expect(payload.tagging).toEqual(expect.objectContaining({ enabled: false, writeOpf: true }));
    expect(payload.processing).toEqual(expect.objectContaining({ autoMergeDownloads: false }));
    // Engine fields belong to Audio Tools — this page must not touch them (partial patch).
    expect(payload.processing).not.toHaveProperty('outputFormat');
    expect(payload.processing).not.toHaveProperty('mergeBehavior');
    expect(payload.processing).not.toHaveProperty('bitrate');
    expect(payload.processing).not.toHaveProperty('maxConcurrentProcessing');
    // Script fields belong to the Custom Script card's OWN form (per-card Save split).
    expect(payload.processing).not.toHaveProperty('postProcessingScript');
    expect(payload.processing).not.toHaveProperty('postProcessingScriptTimeout');
  });

  it('Custom Script card saves independently with ONLY its script subset', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText('Post-processing script')).toBeInTheDocument());

    await user.type(screen.getByLabelText('Post-processing script'), '/scripts/notify.sh');
    const timeout = screen.getByLabelText('Script timeout');
    await user.tripleClick(timeout);
    await user.keyboard('120');
    // Two forms live on this page — only the script card is dirty, so exactly one Save renders.
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown>; tagging?: Record<string, unknown> };
    expect(payload.processing).toEqual({ postProcessingScript: '/scripts/notify.sh', postProcessingScriptTimeout: 120 });
    // The automations/tagging subset is the OTHER form's payload — must be absent entirely.
    expect(payload).not.toHaveProperty('tagging');
  });
});
