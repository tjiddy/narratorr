import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { ProcessingSettingsSection } from './ProcessingSettingsSection';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({
  api: { getSettings: vi.fn(), updateSettings: vi.fn(), getFfmpegStatus: vi.fn(), getMutagenStatus: vi.fn() },
}));

const { api } = await import('@/lib/api');
const mockApi = api as unknown as {
  getSettings: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
  getFfmpegStatus: ReturnType<typeof vi.fn>;
  getMutagenStatus: ReturnType<typeof vi.fn>;
};

// Seed engine fields so subset assertions can prove this page does not send them.
const settings = createMockSettings({
  processing: { autoMergeDownloads: false, postProcessingScript: '', postProcessingScriptTimeout: 300, outputFormat: 'm4b', bitrate: 128 },
  tagging: { enabled: false, mode: 'populate_missing', embedCover: false, writeOpf: false },
});

describe('ProcessingSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(settings);
    mockApi.updateSettings.mockResolvedValue(settings);
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
    mockApi.getMutagenStatus.mockResolvedValue({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });
  });

  it('renders the automation rows', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByText('Post Processing')).toBeInTheDocument());
    expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Tag Embedding/)).toBeInTheDocument();
    expect(screen.getByLabelText('OPF metadata sidecar')).toBeInTheDocument();
    expect(screen.getByLabelText('Post-processing script')).toBeInTheDocument();
  });

  // An operator who reads only the UI must not believe the Activity record is a permanent archive.
  it('tells the operator where a replaced sidecar goes and which half retention reaches (#2297 AC17)', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText('OPF metadata sidecar')).toBeInTheDocument());

    expect(screen.getByText('metadata.opf.bak')).toBeInTheDocument();
    expect(screen.getByText(/Activity . Needs Review/)).toBeInTheDocument();
    expect(screen.getByText(/housekeeping retention setting; the backup file on disk is not/)).toBeInTheDocument();
  });

  it('enables both automations and shows the Audio Tools breadcrumb when both binaries are detected', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
    expect(screen.getByText(/uses your Merge & Convert settings/)).toBeInTheDocument();
    expect(screen.queryByText(/needs ffmpeg/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/needs mutagen/i)).not.toBeInTheDocument();
  });

  it('gates only auto-merge when ffmpeg is missing, leaving OPF + custom script usable', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByText(/see ffmpeg requirements in Audio Tools/)).toBeInTheDocument();
    expect(screen.getByLabelText('OPF metadata sidecar')).toBeEnabled();
    expect(screen.getByLabelText('Post-processing script')).toBeEnabled();
  });

  // AC14's headline client state: the configuration today's code makes impossible.
  it('with mutagen present and ffmpeg ABSENT, Tag Embedding is usable while auto-merge is the gated row', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
    expect(screen.getByText(/needs ffmpeg/i)).toBeInTheDocument();
    expect(screen.queryByText(/needs mutagen/i)).not.toBeInTheDocument();
  });

  it('gates Tag Embedding when mutagen is missing, naming mutagen and MUTAGEN_PYTHON', async () => {
    mockApi.getMutagenStatus.mockResolvedValue({ detected: false });
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => expect(screen.getByLabelText(/Tag Embedding/)).toBeDisabled());
    expect(screen.getByText(/needs mutagen/i)).toBeInTheDocument();
    expect(screen.getByText(/MUTAGEN_PYTHON/)).toBeInTheDocument();
    // Auto-merge keeps its own binary: the two rows gate independently by design.
    expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled();
  });

  it('no longer claims series/subtitle/ASIN/publisher are dropped on M4B', async () => {
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Tag Embedding/)).toBeInTheDocument());

    expect(screen.queryByText(/dropped on M4B/i)).not.toBeInTheDocument();
    expect(screen.getByText(/written into the file on both MP3 and M4B/i)).toBeInTheDocument();
  });

  it('fails safe — gates each row when its own status query errors', async () => {
    mockApi.getFfmpegStatus.mockRejectedValue(new Error('network down'));
    mockApi.getMutagenStatus.mockRejectedValue(new Error('network down'));
    renderWithProviders(<ProcessingSettingsSection />);
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeDisabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeDisabled();
  });

  it('stays optimistic while the status queries are still loading', async () => {
    mockApi.getFfmpegStatus.mockReturnValue(new Promise(() => {}));
    mockApi.getMutagenStatus.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ProcessingSettingsSection />);

    await waitFor(() => expect(screen.getByLabelText(/Tag Embedding/)).toBeInTheDocument());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
    expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled();
  });

  it('lets an ALREADY-ENABLED automation be switched off when its binary is missing (finding 4)', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    mockApi.getMutagenStatus.mockResolvedValue({ detected: false });
    mockApi.getSettings.mockResolvedValue(createMockSettings({
      processing: { autoMergeDownloads: true },
      tagging: { enabled: true },
    }));
    renderWithProviders(<ProcessingSettingsSection />);
    // Gate only false→true; true→false must remain available to avoid a stuck-on setting.
    await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeEnabled());
    expect(screen.getByLabelText(/Tag Embedding/)).toBeEnabled();
  });

  it('keeps a DISABLED automation locked off when its binary is missing (finding 4)', async () => {
    mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
    mockApi.getMutagenStatus.mockResolvedValue({ detected: false });
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
    await user.click(screen.getByLabelText('OPF metadata sidecar'));
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown>; tagging: Record<string, unknown> };
    expect(payload.tagging).toEqual(expect.objectContaining({ enabled: false, writeOpf: true }));
    expect(payload.processing).toEqual(expect.objectContaining({ autoMergeDownloads: false }));
    expect(payload.processing).not.toHaveProperty('outputFormat');
    expect(payload.processing).not.toHaveProperty('bitrate');
    expect(payload.processing).not.toHaveProperty('maxConcurrentProcessing');
    // Custom Script owns these fields in a separate form.
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
    // Only the dirty script form renders Save, so getByRole targets it unambiguously.
    fireEvent.submit(screen.getByRole('button', { name: /save/i }).closest('form')!);

    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());
    const payload = mockApi.updateSettings.mock.calls[0]![0] as { processing: Record<string, unknown>; tagging?: Record<string, unknown> };
    expect(payload.processing).toEqual({ postProcessingScript: '/scripts/notify.sh', postProcessingScriptTimeout: 120 });
    expect(payload).not.toHaveProperty('tagging');
  });

  describe('when the shared settings read fails', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks: the Retry test queues a `*Once()` rejection and
      // clearAllMocks does not drain those queues.
      vi.resetAllMocks();
    });

    it('reports the failure on both cards, in copy that tells them apart', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));
      mockApi.getFfmpegStatus.mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
      mockApi.getMutagenStatus.mockResolvedValue({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });

      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load post processing settings.')).toBeInTheDocument();
      });
      // Both cards read the same query, so one failure lands on both — and the operator has
      // to be able to tell which card is which.
      expect(screen.getByText('Failed to load custom script settings.')).toBeInTheDocument();
      // An off auto-merge toggle and an empty script path are schema defaults, not saved config.
      expect(screen.queryByLabelText(/Auto-merge multi-file downloads/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Post-processing script')).not.toBeInTheDocument();
    });

    it('leaves the ffmpeg capability derivation alone when only the settings read fails', async () => {
      mockApi.getSettings.mockRejectedValue(new Error('settings unreadable'));
      mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
      mockApi.getMutagenStatus.mockResolvedValue({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });

      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load post processing settings.')).toBeInTheDocument();
      });
      // The gate replaces the form; it must not turn a missing-ffmpeg state into a rendered row.
      expect(screen.queryByLabelText(/Auto-merge multi-file downloads/)).not.toBeInTheDocument();
      expect(screen.queryByText('needs ffmpeg')).not.toBeInTheDocument();
    });

    it('keeps the needs-ffmpeg pill on the success path when ffmpeg is missing', async () => {
      mockApi.getSettings.mockResolvedValue(settings);
      mockApi.getFfmpegStatus.mockResolvedValue({ detected: false });
      mockApi.getMutagenStatus.mockResolvedValue({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });

      renderWithProviders(<ProcessingSettingsSection />);

      await waitFor(() => expect(screen.getByText('needs ffmpeg')).toBeInTheDocument());
      expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeInTheDocument();
      expect(screen.queryByText('Failed to load post processing settings.')).not.toBeInTheDocument();
    });

    it("recovers both cards from one card's Retry — they share the settings query", async () => {
      mockApi.getSettings
        .mockRejectedValueOnce(new Error('settings unreadable'))
        .mockResolvedValue(createMockSettings({ processing: { autoMergeDownloads: true, postProcessingScript: '/srv/hook.sh', postProcessingScriptTimeout: 300 } }));
      mockApi.getFfmpegStatus.mockResolvedValue({ detected: true, version: '8.0.1', path: '/usr/bin/ffmpeg' });
      mockApi.getMutagenStatus.mockResolvedValue({ detected: true, version: '1.47.0', path: '/usr/bin/python3' });
      const user = userEvent.setup();

      renderWithProviders(<ProcessingSettingsSection />);
      await waitFor(() => expect(screen.getByText('Failed to load custom script settings.')).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Retry loading post processing settings' }));

      // Checked / a real path, not the schema defaults off / empty: only a refetch yields these.
      await waitFor(() => expect(screen.getByLabelText(/Auto-merge multi-file downloads/)).toBeChecked());
      expect(screen.getByLabelText('Post-processing script')).toHaveValue('/srv/hook.sh');
      expect(screen.queryByText('Failed to load post processing settings.')).not.toBeInTheDocument();
      expect(screen.queryByText('Failed to load custom script settings.')).not.toBeInTheDocument();
    });
  });

});
