import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ActivityPage } from '@/pages/ActivityPage';
import type { Download } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getActivity: vi.fn(),
    cancelDownload: vi.fn(),
    retryDownload: vi.fn(),
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
  it('shows loading spinner while fetching', () => {
    // Never resolve so we stay in loading state
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<ActivityPage />);

    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Monitor your downloads and import history')).toBeInTheDocument();
    // The loading spinner has the LoadingSpinner class
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows empty queue message when no active downloads', async () => {
    vi.mocked(api.getActivity).mockResolvedValue([]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('No active downloads')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Downloads will appear here when you grab audiobooks from search'),
    ).toBeInTheDocument();
  });

  it('shows empty history message when no completed downloads', async () => {
    vi.mocked(api.getActivity).mockResolvedValue([]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('No download history')).toBeInTheDocument();
    });
    expect(
      screen.getByText('Completed downloads will be listed here'),
    ).toBeInTheDocument();
  });

  it('renders a downloading item with progress bar', async () => {
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

    // Status badge
    expect(screen.getAllByText('Downloading').length).toBeGreaterThanOrEqual(1);

    // Progress percentage
    expect(screen.getByText('45%')).toBeInTheDocument();

    // Seeders
    expect(screen.getByText('12 seeders')).toBeInTheDocument();

    // Queue count
    expect(screen.getByText('1 active download')).toBeInTheDocument();
  });

  it('renders a completed item in history', async () => {
    const completed = makeDownload({
      id: 2,
      title: 'Completed Audiobook',
      status: 'completed',
      progress: 1,
      size: 1048576000,
      completedAt: '2024-06-02T12:00:00Z',
    });
    vi.mocked(api.getActivity).mockResolvedValue([completed]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Completed Audiobook')).toBeInTheDocument();
    });

    // Should appear in history section
    expect(screen.getByText('1 completed download')).toBeInTheDocument();

    // Queue should be empty
    expect(screen.getByText('No active downloads')).toBeInTheDocument();
  });

  it('renders a failed item with error message and retry button', async () => {
    const failed = makeDownload({
      id: 3,
      title: 'Failed Audiobook',
      status: 'failed',
      progress: 0.2,
      errorMessage: 'Connection timed out',
    });
    vi.mocked(api.getActivity).mockResolvedValue([failed]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed Audiobook')).toBeInTheDocument();
    });

    // Error message displayed
    expect(screen.getByText('Connection timed out')).toBeInTheDocument();

    // Retry button present
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
  });

  it('shows cancel button for active downloads', async () => {
    const queued = makeDownload({
      id: 4,
      title: 'Queued Audiobook',
      status: 'queued',
      progress: 0,
    });
    const downloading = makeDownload({
      id: 5,
      title: 'Active Audiobook',
      status: 'downloading',
      progress: 0.3,
    });
    vi.mocked(api.getActivity).mockResolvedValue([queued, downloading]);

    const { container } = renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Queued Audiobook')).toBeInTheDocument();
    });
    expect(screen.getByText('Active Audiobook')).toBeInTheDocument();

    // Both should have cancel buttons (text hidden on small screens via sm:inline)
    // Find buttons by their hidden "Cancel" text span
    const cancelSpans = screen.getAllByText('Cancel');
    expect(cancelSpans).toHaveLength(2);
  });

  it('calls cancelDownload when cancel button clicked', async () => {
    vi.mocked(api.cancelDownload).mockResolvedValue({ success: true });
    const downloading = makeDownload({
      id: 7,
      title: 'Cancel Me',
      status: 'downloading',
      progress: 0.5,
    });
    vi.mocked(api.getActivity).mockResolvedValue([downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Cancel Me')).toBeInTheDocument();
    });

    // Click the parent button of the "Cancel" text
    const cancelSpan = screen.getByText('Cancel');
    fireEvent.click(cancelSpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.cancelDownload).mock.calls[0][0]).toBe(7);
    });
  });
});
