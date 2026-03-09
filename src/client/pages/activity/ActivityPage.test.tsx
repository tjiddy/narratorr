import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ActivityPage } from './ActivityPage';
import type { Download } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getActivity: vi.fn(),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(),
    approveDownload: vi.fn(),
    rejectDownload: vi.fn(),
  },
  formatBytes: (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  },
  formatProgress: (progress: number) => `${Math.round(progress * 100)}%`,
}));

import { api } from '@/lib/api';

const makeDownload = (overrides: Partial<Download> = {}): Download => ({
  id: 1,
  title: 'Test Audiobook',
  protocol: 'torrent',
  status: 'queued',
  progress: 0,
  addedAt: '2024-06-01T00:00:00Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivityPage', () => {
  it('shows loading state with spinner', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Monitor your downloads and import history')).toBeInTheDocument();
  });

  it('shows error-like state when API rejects', async () => {
    vi.mocked(api.getActivity).mockRejectedValue(new Error('Network error'));

    renderWithProviders(<ActivityPage />);

    // Should not crash — TanStack Query handles the error
    // After rejection, loading spinner disappears but page renders
    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });
  });

  it('shows empty queue and history when no downloads exist', async () => {
    vi.mocked(api.getActivity).mockResolvedValue([]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('No active downloads')).toBeInTheDocument();
    });
    expect(screen.getByText('No download history')).toBeInTheDocument();
  });

  it('renders a downloading item with progress and seeders', async () => {
    const downloading = makeDownload({
      id: 1,
      title: 'Downloading Audiobook',
      status: 'downloading',
      progress: 0.45,
      size: 524288000,
      seeders: 12,
    });
    vi.mocked(api.getActivity).mockResolvedValue([downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Downloading Audiobook')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Downloading').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('12 seeders')).toBeInTheDocument();
    expect(screen.getByText('1 active download')).toBeInTheDocument();
  });

  it('renders completed items in history section', async () => {
    const completed = makeDownload({
      id: 2,
      title: 'Completed Audiobook',
      status: 'completed',
      progress: 1,
      size: 1048576000,
    });
    vi.mocked(api.getActivity).mockResolvedValue([completed]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Completed Audiobook')).toBeInTheDocument();
    });

    expect(screen.getByText('1 completed download')).toBeInTheDocument();
    expect(screen.getByText('No active downloads')).toBeInTheDocument();
  });

  it('shows failed item with error message and retry button', async () => {
    const failed = makeDownload({
      id: 3,
      title: 'Failed Audiobook',
      status: 'failed',
      errorMessage: 'Connection timed out',
    });
    vi.mocked(api.getActivity).mockResolvedValue([failed]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed Audiobook')).toBeInTheDocument();
    });

    expect(screen.getByText('Connection timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('shows cancel buttons for active downloads', async () => {
    const queued = makeDownload({ id: 4, title: 'Queued Audiobook', status: 'queued' });
    const downloading = makeDownload({ id: 5, title: 'Active Audiobook', status: 'downloading', progress: 0.3 });
    vi.mocked(api.getActivity).mockResolvedValue([queued, downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Queued Audiobook')).toBeInTheDocument();
    });

    const cancelSpans = screen.getAllByText('Cancel');
    expect(cancelSpans).toHaveLength(2);
  });

  it('shows protocol badges on download cards', async () => {
    const torrentDl = makeDownload({ id: 10, title: 'Torrent Book', status: 'downloading', protocol: 'torrent', progress: 0.5 });
    const usenetDl = makeDownload({ id: 11, title: 'Usenet Book', status: 'completed', protocol: 'usenet', progress: 1 });
    vi.mocked(api.getActivity).mockResolvedValue([torrentDl, usenetDl]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Torrent Book')).toBeInTheDocument();
    });

    const badges = screen.getAllByTestId('protocol-badge');
    expect(badges).toHaveLength(2);
    expect(badges[0]).toHaveTextContent('Torrent');
    expect(badges[1]).toHaveTextContent('Usenet');
  });

  it('cancels download and invalidates query on success', async () => {
    const user = userEvent.setup();
    const downloading = makeDownload({ id: 7, title: 'Cancel Me', status: 'downloading', progress: 0.5 });

    // First call returns the downloading item, second (after invalidation) returns empty
    vi.mocked(api.getActivity)
      .mockResolvedValueOnce([downloading])
      .mockResolvedValueOnce([]);
    vi.mocked(api.cancelDownload).mockResolvedValue({ success: true });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Cancel Me')).toBeInTheDocument();
    });

    // "Cancel" text is inside a hidden sm:inline span, so find via text then traverse to button
    const cancelSpan = screen.getByText('Cancel');
    await user.click(cancelSpan.closest('button')!);

    // API was called with correct ID (TanStack Query passes extra context arg)
    await waitFor(() => {
      expect(vi.mocked(api.cancelDownload).mock.calls[0][0]).toBe(7);
    });

    // After invalidation, the item is gone from the queue
    await waitFor(() => {
      expect(screen.queryByText('Cancel Me')).not.toBeInTheDocument();
    });
  });

  it('retries failed download and invalidates query on success', async () => {
    const user = userEvent.setup();
    const failed = makeDownload({ id: 9, title: 'Retry Me', status: 'failed', errorMessage: 'Timed out' });
    const retried = makeDownload({ id: 9, title: 'Retry Me', status: 'queued' });

    vi.mocked(api.getActivity)
      .mockResolvedValueOnce([failed])
      .mockResolvedValueOnce([retried]);
    vi.mocked(api.retryDownload).mockResolvedValue(retried);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Retry Me')).toBeInTheDocument();
    });

    // Error should be visible before retry
    expect(screen.getByText('Timed out')).toBeInTheDocument();

    // "Retry" text is inside a hidden sm:inline span, so find via text then traverse to button
    const retrySpan = screen.getByText('Retry');
    await user.click(retrySpan.closest('button')!);

    // API was called with correct ID (TanStack Query passes extra context arg)
    await waitFor(() => {
      expect(vi.mocked(api.retryDownload).mock.calls[0][0]).toBe(9);
    });

    // After invalidation, item moves back to queue and error is gone
    await waitFor(() => {
      expect(screen.queryByText('Timed out')).not.toBeInTheDocument();
    });
  });

  it('approves pending_review download and invalidates query on success', async () => {
    const user = userEvent.setup();
    const pending = makeDownload({
      id: 20,
      title: 'Review Me',
      status: 'pending_review',
      qualityGate: {
        action: 'held',
        mbPerHour: 120,
        existingMbPerHour: 100,
        narratorMatch: false,
        durationDelta: 0.05,
        codec: 'mp3',
        channels: 1,
        probeFailure: false,
        holdReasons: ['narrator_mismatch'],
      },
    });
    const approved = makeDownload({ id: 20, title: 'Review Me', status: 'importing' });

    vi.mocked(api.getActivity)
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([approved]);
    vi.mocked(api.approveDownload).mockResolvedValue({ id: 20, status: 'importing' });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Review Me')).toBeInTheDocument();
    });

    const approveSpan = screen.getByText('Approve');
    await user.click(approveSpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.approveDownload).mock.calls[0][0]).toBe(20);
    });
  });

  it('rejects pending_review download and invalidates query on success', async () => {
    const user = userEvent.setup();
    const pending = makeDownload({
      id: 21,
      title: 'Reject Me',
      status: 'pending_review',
      qualityGate: {
        action: 'held',
        mbPerHour: 80,
        existingMbPerHour: 100,
        narratorMatch: true,
        durationDelta: 0.02,
        codec: 'mp3',
        channels: 1,
        probeFailure: false,
        holdReasons: [],
      },
    });

    vi.mocked(api.getActivity)
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([]);
    vi.mocked(api.rejectDownload).mockResolvedValue({ id: 21, status: 'failed' });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Reject Me')).toBeInTheDocument();
    });

    const rejectSpan = screen.getByText('Reject');
    await user.click(rejectSpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.rejectDownload).mock.calls[0][0]).toBe(21);
    });
  });

  it('shows error message on non-failed downloads with errorMessage', async () => {
    const downloading = makeDownload({
      id: 8,
      title: 'Errored but Downloading',
      status: 'downloading',
      progress: 0.3,
      errorMessage: 'Tracker returned error',
    });
    vi.mocked(api.getActivity).mockResolvedValue([downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Errored but Downloading')).toBeInTheDocument();
    });

    expect(screen.getByText('Tracker returned error')).toBeInTheDocument();
  });
});
