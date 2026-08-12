import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { renderWithProviders } from '@/__tests__/helpers';
import { ActivityPage } from './ActivityPage';
import { SSEProvider } from '@/components/SSEProvider';
import { queryKeys } from '@/lib/queryKeys';
import type { ActivityListParams, Download } from '@/lib/api';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/useSearchProgress', () => ({
  useSearchProgress: vi.fn().mockReturnValue([]),
  handleSearchEvent: vi.fn(),
  _resetForTesting: vi.fn(),
}));

vi.mock('@/hooks/useMergeProgress', () => ({
  useMergeActivityCards: vi.fn().mockReturnValue([]),
  useMergeProgress: vi.fn().mockReturnValue(null),
  setMergeProgress: vi.fn(),
  _resetForTesting: vi.fn(),
}));

// Cache spy wrappers so instrumentation preserves clampToTotal's dependency identity.
let clampToTotalCallCount = 0;
type ClampFn = (total: number) => void;
const clampWrapperCache = new WeakMap<ClampFn, ClampFn>();
vi.mock('@/hooks/usePagination', async () => {
  const mod: typeof import('@/hooks/usePagination') = await vi.importActual('@/hooks/usePagination');
  return {
    ...mod,
    usePagination: (...args: Parameters<typeof mod.usePagination>) => {
      const result = mod.usePagination(...args);
      const original = result.clampToTotal;
      if (!clampWrapperCache.has(original)) {
        clampWrapperCache.set(original, (total: number) => {
          clampToTotalCallCount++;
          return original(total);
        });
      }
      return { ...result, clampToTotal: clampWrapperCache.get(original)! };
    },
  };
});

vi.mock('@/hooks/useEventSource', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useEventSource')>('@/hooks/useEventSource');
  return {
    ...actual,
    useSSEConnected: vi.fn(() => false),
  };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      getActivity: vi.fn(),
      getAuthConfig: vi.fn(),
      mintStreamToken: vi.fn().mockResolvedValue({ token: 'test-stream-token', expiresInMs: 300_000 }),
      cancelDownload: vi.fn(),
      retryDownload: vi.fn(),
      approveDownload: vi.fn(),
      rejectDownload: vi.fn(),
      cancelMergeBook: vi.fn(),
      getImportJobs: vi.fn().mockResolvedValue([]),
      getEventHistory: vi.fn(),
      markEventFailed: vi.fn(),
      deleteEvent: vi.fn(),
      deleteEvents: vi.fn(),
      listImportSubmissions: vi.fn().mockResolvedValue({ data: [], total: 0 }),
      getImportSubmissionDetail: vi.fn(),
    },
  };
});

import { api } from '@/lib/api';
import { useSSEConnected } from '@/hooks/useEventSource';

const makeDownload = (overrides: Partial<Download> = {}): Download => ({
  id: 1,
  title: 'Test Audiobook',
  protocol: 'torrent',
  status: 'queued',
  clientStatus: 'queued',
  pipelineStage: 'idle',
  progress: 0,
  addedAt: '2024-06-01T00:00:00Z',
  completedAt: null,
  seeders: null,
  indexerName: null,
  ...overrides,
});

function mockActivityQueue(queue: Download[]) {
  vi.mocked(api.getActivity).mockResolvedValue({ data: queue, total: queue.length });
}

beforeEach(() => {
  vi.clearAllMocks();
  clampToTotalCallCount = 0;
});

describe('ActivityPage pagination clamp (#93)', () => {
  const LIMIT = 50;

  const activityKey = (params: ActivityListParams & { section: 'queue' | 'history' }) =>
    queryKeys.activity(params);

  // Completed fixtures disable refetch polling.
  const makeCompletedDownloads = (n: number, startId = 1) =>
    Array.from({ length: n }, (_, i) => makeDownload({ id: startId + i, status: 'completed' }));

  // Keep cache writes authoritative; a clamped-key refetch would restore the mock's stale total.
  function makeClampTestClient() {
    return new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
  }

  function renderWithCustomClient(queryClient: QueryClient) {
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('queue page clamps to last valid page when total shrinks (page 3 → page 2 of 2)', async () => {
    const user = userEvent.setup();
    const queryClient = makeClampTestClient();

    vi.mocked(api.getActivity).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return {
        data: makeCompletedDownloads(LIMIT, offset),
        total: 150,
      };
    });

    renderWithCustomClient(queryClient);

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });

    const pageLabels = () => screen.getAllByText(/Page \d+ of \d+/);

    // placeholderData prevents transient empty totals from clamping during navigation.
    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(pageLabels()[0]).toHaveTextContent('Page 2 of 3'));

    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(pageLabels()[0]).toHaveTextContent('Page 3 of 3'));

    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 100 }),
        { data: makeCompletedDownloads(50, 9000), total: 100 },
      );
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 50 }),
        { data: makeCompletedDownloads(50, 8000), total: 100 },
      );
    });

    await waitFor(() => expect(pageLabels()[0]).toHaveTextContent('Page 2 of 2'));
  }, 15000);

  it('clamp effects do not re-fire on re-render when totals are unchanged (stable deps)', async () => {
    const user = userEvent.setup();
    const queryClient = makeClampTestClient();

    vi.mocked(api.getActivity).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return {
        data: makeCompletedDownloads(LIMIT, offset),
        total: 150,
      };
    });

    renderWithCustomClient(queryClient);

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });

    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Page \d+ of \d+/)[0]).toHaveTextContent('Page 2 of 3'));

    const countBeforeRerender = clampToTotalCallCount;

    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 50 }),
        { data: makeCompletedDownloads(LIMIT, 8000), total: 150 },
      );
    });

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels[0]).toHaveTextContent('Page 2 of 3');
    });

    expect(clampToTotalCallCount).toBe(countBeforeRerender);
  }, 15000);

  it('clamps to page 1 when total shrinks to exactly 1 page', async () => {
    const user = userEvent.setup();
    const queryClient = makeClampTestClient();

    vi.mocked(api.getActivity).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return {
        data: makeCompletedDownloads(LIMIT, offset),
        total: 150,
      };
    });

    renderWithCustomClient(queryClient);

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });

    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Page \d+ of \d+/)[0]).toHaveTextContent('Page 2 of 3'));
    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Page \d+ of \d+/)[0]).toHaveTextContent('Page 3 of 3'));

    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 100 }),
        { data: makeCompletedDownloads(30, 9000), total: 30 },
      );
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 0 }),
        { data: makeCompletedDownloads(30, 8000), total: 30 },
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
    });

    // Restore pagination visibility to expose the hidden clamped page state.
    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 0 }),
        { data: makeCompletedDownloads(LIMIT, 7000), total: 150 },
      );
    });

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });
  }, 15000);

  it('clamps to page 1 when total shrinks to 0', async () => {
    const user = userEvent.setup();
    const queryClient = makeClampTestClient();

    vi.mocked(api.getActivity).mockImplementation(async (params) => {
      const offset = params?.offset ?? 0;
      return {
        data: makeCompletedDownloads(LIMIT, offset),
        total: 150,
      };
    });

    renderWithCustomClient(queryClient);

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });

    await user.click(screen.getAllByRole('button', { name: /next page/i })[0]!);
    await waitFor(() => expect(screen.getAllByText(/Page \d+ of \d+/)[0]).toHaveTextContent('Page 2 of 3'));

    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 50 }),
        { data: [], total: 0 },
      );
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 0 }),
        { data: [], total: 0 },
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
    });

    // Restore pagination visibility to expose the hidden clamped page state.
    act(() => {
      queryClient.setQueryData(
        activityKey({ section: 'queue', limit: LIMIT, offset: 0 }),
        { data: makeCompletedDownloads(LIMIT, 7000), total: 150 },
      );
    });

    await waitFor(() => {
      const labels = screen.getAllByText(/Page \d+ of \d+/);
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent('Page 1 of 3');
    });
  }, 15000);
});

describe('ActivityPage', () => {
  it('shows loading state with spinner and page header', () => {
    vi.mocked(api.getActivity).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<ActivityPage />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Monitor your downloads and import history')).toBeInTheDocument();
  });

  it('shows error-like state when API rejects', async () => {
    vi.mocked(api.getActivity).mockRejectedValue(new Error('Network error'));

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Activity')).toBeInTheDocument();
    });
  });

  it('shows empty active section when no downloads exist', async () => {
    mockActivityQueue([]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });
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
    mockActivityQueue([downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Downloading Audiobook')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Downloading').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('45%')).toBeInTheDocument();
    expect(screen.getByText('12 seeders')).toBeInTheDocument();
    expect(screen.getByText('1 download queued')).toBeInTheDocument();
  });

  it('shows failed item with error message and retry button', async () => {
    const failed = makeDownload({
      id: 3,
      bookId: 1,
      title: 'Failed Audiobook',
      status: 'failed',
      errorMessage: 'Connection timed out',
    });
    mockActivityQueue([failed]);

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
    mockActivityQueue([queued, downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Queued Audiobook')).toBeInTheDocument();
    });

    const cancelSpans = screen.getAllByText('Cancel & Blacklist');
    expect(cancelSpans).toHaveLength(2);
  });

  it('shows protocol badges on download cards', async () => {
    const torrentDl = makeDownload({ id: 10, title: 'Torrent Book', status: 'downloading', protocol: 'torrent', progress: 0.5 });
    const usenetDl = makeDownload({ id: 11, title: 'Usenet Book', status: 'queued', protocol: 'usenet' });
    mockActivityQueue([torrentDl, usenetDl]);

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

    mockActivityQueue([downloading]);
    vi.mocked(api.cancelDownload).mockResolvedValue({ success: true });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Cancel Me')).toBeInTheDocument();
    });

    const cancelSpan = screen.getByText('Cancel & Blacklist');
    await user.click(cancelSpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.cancelDownload).mock.calls[0]![0]).toBe(7);
    });
  });

  it('retries failed download and invalidates query on success', async () => {
    const user = userEvent.setup();
    const failed = makeDownload({ id: 9, bookId: 1, title: 'Retry Me', status: 'failed', errorMessage: 'Timed out' });
    const retried = makeDownload({ id: 9, title: 'Retry Me', status: 'queued' });

    mockActivityQueue([failed]);
    vi.mocked(api.retryDownload).mockResolvedValue(retried);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Retry Me')).toBeInTheDocument();
    });

    expect(screen.getByText('Timed out')).toBeInTheDocument();

    const retrySpan = screen.getByText('Retry');
    await user.click(retrySpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.retryDownload).mock.calls[0]![0]).toBe(9);
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
        existingNarrator: null,
        downloadNarrator: null,
        durationDelta: 0.05,
        existingDuration: null,
        downloadedDuration: null,
        codec: 'mp3',
        channels: 1,
        existingCodec: null,
        existingChannels: null,
        probeFailure: false,
        probeError: null,
        holdReasons: ['narrator_mismatch'],
      },
    });
    mockActivityQueue([pending]);
    vi.mocked(api.approveDownload).mockResolvedValue({ id: 20, status: 'importing' });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Review Me')).toBeInTheDocument();
    });

    const expandToggle = screen.getByRole('button', { expanded: false });
    await user.click(expandToggle);

    const approveSpan = screen.getByText('Approve');
    await user.click(approveSpan.closest('button')!);

    await waitFor(() => {
      expect(vi.mocked(api.approveDownload).mock.calls[0]![0]).toBe(20);
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
        existingNarrator: null,
        downloadNarrator: null,
        durationDelta: 0.02,
        existingDuration: null,
        downloadedDuration: null,
        codec: 'mp3',
        channels: 1,
        existingCodec: null,
        existingChannels: null,
        probeFailure: false,
        probeError: null,
        holdReasons: [],
      },
    });

    mockActivityQueue([pending]);
    vi.mocked(api.rejectDownload).mockResolvedValue({ id: 21, status: 'failed' });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Reject Me')).toBeInTheDocument();
    });

    const expandToggle = screen.getByRole('button', { expanded: false });
    await user.click(expandToggle);

    const rejectBtn = screen.getByText('Reject');
    await user.click(rejectBtn.closest('button')!);

    await waitFor(() => {
      expect(api.rejectDownload).toHaveBeenCalledWith(21, { retry: false });
    });
  });

  it('reject & search from pending_review download sends retry=true', async () => {
    const user = userEvent.setup();
    const pending = makeDownload({
      id: 22,
      title: 'Search Again',
      status: 'pending_review',
      qualityGate: {
        action: 'held',
        mbPerHour: 80,
        existingMbPerHour: 100,
        narratorMatch: true,
        existingNarrator: null,
        downloadNarrator: null,
        durationDelta: 0.02,
        existingDuration: null,
        downloadedDuration: null,
        codec: 'mp3',
        channels: 1,
        existingCodec: null,
        existingChannels: null,
        probeFailure: false,
        probeError: null,
        holdReasons: [],
      },
    });

    mockActivityQueue([pending]);
    vi.mocked(api.rejectDownload).mockResolvedValue({ id: 22, status: 'failed' });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Search Again')).toBeInTheDocument();
    });

    const expandToggle = screen.getByRole('button', { expanded: false });
    await user.click(expandToggle);

    const rejectSearchBtn = screen.getByText('Reject & Search');
    await user.click(rejectSearchBtn.closest('button')!);

    await waitFor(() => {
      expect(api.rejectDownload).toHaveBeenCalledWith(22, { retry: true });
    });
  });

  it('reject spinner shows only on the clicked row, not sibling pending-review rows', async () => {
    const user = userEvent.setup();
    const gate = {
      action: 'held' as const,
      mbPerHour: 80,
      existingMbPerHour: 100,
      narratorMatch: true,
      existingNarrator: null,
      downloadNarrator: null,
      durationDelta: 0.02,
      existingDuration: null,
      downloadedDuration: null,
      codec: 'mp3',
      channels: 1,
      existingCodec: null,
      existingChannels: null,
      probeFailure: false,
      probeError: null,
      holdReasons: [],
    };
    const row1 = makeDownload({ id: 30, title: 'Row One', status: 'pending_review', qualityGate: gate });
    const row2 = makeDownload({ id: 31, title: 'Row Two', status: 'pending_review', qualityGate: gate });

    mockActivityQueue([row1, row2]);
    vi.mocked(api.rejectDownload).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Row One')).toBeInTheDocument();
      expect(screen.getByText('Row Two')).toBeInTheDocument();
    });

    const expandToggles = screen.getAllByRole('button', { expanded: false });
    for (const toggle of expandToggles) {
      await user.click(toggle);
    }

    const rejectButtons = screen.getAllByText('Reject');
    await user.click(rejectButtons[0]!.closest('button')!);

    await waitFor(() => {
      expect(screen.getByText('Rejecting...')).toBeInTheDocument();
    });

    const remainingRejectButtons = screen.getAllByText('Reject');
    expect(remainingRejectButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Rejecting...')).toHaveLength(1);
  });

  it('shows retry button only on linked failed download, not orphaned', async () => {
    const orphaned = makeDownload({
      id: 10,
      bookId: null,
      title: 'Orphaned Audiobook',
      status: 'failed',
      errorMessage: 'Book was deleted',
    });
    const linked = makeDownload({
      id: 11,
      bookId: 2,
      title: 'Linked Audiobook',
      status: 'failed',
      errorMessage: 'Timed out',
    });
    mockActivityQueue([orphaned, linked]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Orphaned Audiobook')).toBeInTheDocument();
    });
    expect(screen.getByText('Linked Audiobook')).toBeInTheDocument();

    expect(screen.getAllByText('Retry')).toHaveLength(1);
    expect(screen.getByText('Book was deleted')).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });

  it('shows error message on non-failed downloads with errorMessage', async () => {
    const downloading = makeDownload({
      id: 8,
      title: 'Errored but Downloading',
      status: 'downloading',
      progress: 0.3,
      errorMessage: 'Tracker returned error',
    });
    mockActivityQueue([downloading]);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Errored but Downloading')).toBeInTheDocument();
    });

    expect(screen.getByText('Tracker returned error')).toBeInTheDocument();
  });
});

  describe('retry loading state', () => {
    it('retry button is disabled and shows Retrying... while retryMutation is pending', async () => {
      const user = userEvent.setup();
      let resolveRetry!: (v: ReturnType<typeof makeDownload>) => void;
      vi.mocked(api.retryDownload).mockReturnValue(
        new Promise<ReturnType<typeof makeDownload>>((r) => { resolveRetry = r; }),
      );

      const item = makeDownload({ id: 20, bookId: 1, title: 'Retry Me', status: 'failed' });
      mockActivityQueue([item]);

      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Retry Me')).toBeInTheDocument());

      const retryBtn = screen.getByText('Retry').closest('button')!;
      await user.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByText('Retrying...')).toBeInTheDocument();
      });
      expect(screen.getByText('Retrying...').closest('button')).toBeDisabled();

      resolveRetry(makeDownload({ id: 20, status: 'queued' }));
    });

    it('only the clicked retry button shows Retrying... while in-flight', async () => {
      const user = userEvent.setup();
      let resolveRetry!: (v: ReturnType<typeof makeDownload>) => void;
      vi.mocked(api.retryDownload).mockReturnValue(
        new Promise<ReturnType<typeof makeDownload>>((r) => { resolveRetry = r; }),
      );

      const item1 = makeDownload({ id: 30, bookId: 1, title: 'Failed A', status: 'failed' });
      const item2 = makeDownload({ id: 31, bookId: 2, title: 'Failed B', status: 'failed' });
      mockActivityQueue([item1, item2]);

      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Failed A')).toBeInTheDocument());

      const retryBtns = screen.getAllByText('Retry');
      await user.click(retryBtns[0]!.closest('button')!);

      await waitFor(() => {
        expect(screen.getAllByText('Retrying...')).toHaveLength(1);
        expect(screen.getAllByText('Retry')).toHaveLength(1);
      });

      resolveRetry(makeDownload({ id: 30, status: 'queued' }));
    });

    it('retry button returns to enabled Retry label after mutation succeeds', async () => {
      const user = userEvent.setup();
      let resolveRetry!: (v: ReturnType<typeof makeDownload>) => void;
      vi.mocked(api.retryDownload).mockReturnValue(
        new Promise<ReturnType<typeof makeDownload>>((r) => { resolveRetry = r; }),
      );

      const item = makeDownload({ id: 40, bookId: 1, title: 'Retry Success', status: 'failed' });
      mockActivityQueue([item]);

      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Retry Success')).toBeInTheDocument());

      await user.click(screen.getByText('Retry').closest('button')!);
      await waitFor(() => expect(screen.getByText('Retrying...')).toBeInTheDocument());

      act(() => { resolveRetry(makeDownload({ id: 40, status: 'queued' })); });

      await waitFor(() => {
        expect(screen.queryByText('Retrying...')).not.toBeInTheDocument();
      });
    });

    it('retry button returns to enabled Retry label after mutation fails', async () => {
      const user = userEvent.setup();
      let rejectRetry!: (e: Error) => void;
      vi.mocked(api.retryDownload).mockReturnValue(
        new Promise<ReturnType<typeof makeDownload>>((_, rej) => { rejectRetry = rej; }),
      );

      const item = makeDownload({ id: 41, bookId: 1, title: 'Retry Fail', status: 'failed' });
      mockActivityQueue([item]);

      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Retry Fail')).toBeInTheDocument());

      await user.click(screen.getByText('Retry').closest('button')!);
      await waitFor(() => expect(screen.getByText('Retrying...')).toBeInTheDocument());

      act(() => { rejectRetry(new Error('server error')); });

      await waitFor(() => {
        expect(screen.queryByText('Retrying...')).not.toBeInTheDocument();
      });
    });
  });

  describe('tab switching', () => {
    beforeEach(() => {
      mockActivityQueue([]);
      vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    });

    it('default render shows Active tab content and hides History', async () => {
      renderWithProviders(<ActivityPage />);

      await waitFor(() => {
        expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
      });

      expect(screen.queryByText('All')).not.toBeInTheDocument();
    });

    it('clicking History tab shows event history content and hides active downloads', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ActivityPage />);

      await waitFor(() => {
        expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /history/i }));

      await waitFor(() => {
        expect(screen.queryByText('Nothing running right now')).not.toBeInTheDocument();
      });

      expect(screen.getByText('All')).toBeInTheDocument();
    });

    it('renders Import history ABOVE event history, and event history stays usable when import history is empty (F22)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Nothing running right now')).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: /history/i }));

      const section = await screen.findByTestId('import-history-section');
      expect(await screen.findByTestId('import-history-empty')).toBeInTheDocument();
      const allFilter = screen.getByText('All');
      expect(allFilter).toBeInTheDocument();
      expect(section.compareDocumentPosition(allFilter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('an import-history render crash is isolated to its section fallback; Event history stays usable (F5/F31)', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // Silence React's expected boundary log.
      const user = userEvent.setup();
      // Missing aggregates forces a real render-shape failure inside the section.
      vi.mocked(api.listImportSubmissions).mockResolvedValue({
        data: [{ id: 1, clientSubmissionId: 'c', source: 'library', status: 'complete', expectedCount: 1, receivedCount: 1, processedCount: 1, detailsPruned: false, itemsIncluded: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never],
        total: 1,
      });
      renderWithProviders(<ActivityPage />);
      await waitFor(() => expect(screen.getByText('Nothing running right now')).toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: /history/i }));

      expect(await screen.findByTestId('import-history-boundary-fallback')).toBeInTheDocument();
      expect(screen.getByText('All')).toBeInTheDocument();
      errSpy.mockRestore();
    });

    it('clicking Active tab from History restores active downloads content', async () => {
      const user = userEvent.setup();
      renderWithProviders(<ActivityPage />);

      await waitFor(() => {
        expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /history/i }));
      await waitFor(() => {
        expect(screen.queryByText('Nothing running right now')).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /active/i }));

      await waitFor(() => {
        expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
      });
    });
  });


class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener() { /* noop */ }
  close() { this.readyState = 2; }

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  simulateEvent(type: string, data: unknown) {
    const handlers = this.listeners.get(type) || [];
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const handler of handlers) handler(event);
  }
}

describe('#312 page-level SSE integration', () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;
  });
  afterEach(() => {
    (globalThis as unknown as Record<string, unknown>).EventSource = originalEventSource;
  });

  function renderWithSSE() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // SSEProvider connects only after a short-lived stream token is cached.
    queryClient.setQueryData(['auth', 'stream-token'], { token: 'test-stream-token', expiresInMs: 300_000 });

    const result = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/activity']}>
          <SSEProvider />
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    return { ...result, queryClient };
  }

  it('transitions from empty state to showing download after cache-miss SSE event triggers refetch', async () => {
    let callCount = 0;
    vi.mocked(api.getActivity).mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return Promise.resolve({ data: [], total: 0 });
      return Promise.resolve({
        data: [makeDownload({ id: 5, title: 'New Audiobook', status: 'downloading', progress: 0.3 })],
        total: 1,
      });
    });

    renderWithSSE();

    await waitFor(() => {
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    const es = MockEventSource.instances[0];

    await act(async () => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 5, book_id: 10, percentage: 0.3, speed: null, eta: null });
    });

    await waitFor(() => {
      expect(screen.getByText('New Audiobook')).toBeInTheDocument();
    });
    expect(screen.queryByText('Nothing running right now')).not.toBeInTheDocument();
  });

  it('updates download progress in-place via SSE patch without full page reload', async () => {
    vi.mocked(api.getActivity).mockImplementation(() => {
      return Promise.resolve({
        data: [makeDownload({ id: 1, title: 'My Audiobook', status: 'downloading', progress: 0.5 })],
        total: 1,
      });
    });

    renderWithSSE();

    await waitFor(() => {
      expect(screen.getByText('My Audiobook')).toBeInTheDocument();
    });
    expect(screen.getByText('50%')).toBeInTheDocument();

    const es = MockEventSource.instances[0];
    const getActivityCallCount = vi.mocked(api.getActivity).mock.calls.length;

    await act(async () => {
      es!.simulateOpen();
      es!.simulateEvent('download_progress', { download_id: 1, book_id: 2, percentage: 0.75, speed: null, eta: null });
    });

    await waitFor(() => {
      expect(screen.getByText('75%')).toBeInTheDocument();
    });

    expect(vi.mocked(api.getActivity).mock.calls.length).toBe(getActivityCallCount);
  });
});


describe('#392 search progress cards', () => {
  it('renders search cards when useSearchProgress returns active entries', async () => {
    const { useSearchProgress } = await import('@/hooks/useSearchProgress');
    vi.mocked(useSearchProgress).mockReturnValue([
      {
        bookId: 99,
        bookTitle: 'Searching Book',
        indexers: new Map([[10, { name: 'MAM', status: 'pending' as const }]]),
      },
    ]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [makeDownload()],
      total: 1,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Test Audiobook').length).toBeGreaterThan(0);
    });

    expect(screen.getByText('Searching Book')).toBeInTheDocument();
    expect(screen.getByText('MAM')).toBeInTheDocument();

    vi.mocked(useSearchProgress).mockReturnValue([]);
  });

  it('does not render search section when no active searches', async () => {
    const { useSearchProgress } = await import('@/hooks/useSearchProgress');
    vi.mocked(useSearchProgress).mockReturnValue([]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [],
      total: 0,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });
  });
});


describe('#422 merge activity cards', () => {
  it('renders merge cards when useMergeActivityCards returns active entries', async () => {
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');
    vi.mocked(useMergeActivityCards).mockReturnValue([
      { bookId: 42, bookTitle: 'Merging Book', phase: 'processing', percentage: 0.5 },
    ]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [makeDownload()],
      total: 1,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getAllByText('Test Audiobook').length).toBeGreaterThan(0);
    });

    expect(screen.getByText('Merging Book')).toBeInTheDocument();
    expect(screen.getByText(/Encoding to M4B — 50%/)).toBeInTheDocument();

    vi.mocked(useMergeActivityCards).mockReturnValue([]);
  });

  it('renders multiple merge cards (1 active + N queued)', async () => {
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');
    vi.mocked(useMergeActivityCards).mockReturnValue([
      { bookId: 1, bookTitle: 'Active Book', phase: 'processing', percentage: 0.3 },
      { bookId: 2, bookTitle: 'Queued Book', phase: 'queued', position: 1 },
    ]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [],
      total: 0,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText('Active Book')).toBeInTheDocument();
    });

    expect(screen.getByText('Queued Book')).toBeInTheDocument();
    expect(screen.getByText('Queued (position 1)')).toBeInTheDocument();

    vi.mocked(useMergeActivityCards).mockReturnValue([]);
  });

  it('does not render merge section when no active merges', async () => {
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');
    vi.mocked(useMergeActivityCards).mockReturnValue([]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [],
      total: 0,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Encoding to M4B/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Merge started/)).not.toBeInTheDocument();
  });

  it('merge cards and search cards coexist', async () => {
    const { useSearchProgress } = await import('@/hooks/useSearchProgress');
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');

    vi.mocked(useSearchProgress).mockReturnValue([
      {
        bookId: 99,
        bookTitle: 'Searching Book',
        indexers: new Map([[10, { name: 'MAM', status: 'pending' as const }]]),
      },
    ]);
    vi.mocked(useMergeActivityCards).mockReturnValue([
      { bookId: 42, bookTitle: 'Merging Book', phase: 'staging' },
    ]);

    vi.mocked(api.getActivity).mockResolvedValue({
      data: [],
      total: 0,
    });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => {
      expect(screen.getByText('Searching Book')).toBeInTheDocument();
    });

    expect(screen.getByText('Merging Book')).toBeInTheDocument();
    expect(screen.getByText('Staging files...')).toBeInTheDocument();

    vi.mocked(useSearchProgress).mockReturnValue([]);
    vi.mocked(useMergeActivityCards).mockReturnValue([]);
  });
});

describe('#478 cancel merge error recovery', () => {
  it('shows error toast when cancel merge mutation fails', async () => {
    const user = userEvent.setup();
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');
    const { toast } = await import('sonner');

    vi.mocked(useMergeActivityCards).mockReturnValue([
      { bookId: 42, bookTitle: 'Merge Book', phase: 'processing', percentage: 0.5 },
    ]);
    vi.mocked(api.cancelMergeBook).mockRejectedValue(new Error('Server error'));
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => expect(screen.getByText('Merge Book')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /cancel merge/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Cancel failed: Server error');
    });
    expect(api.cancelMergeBook).toHaveBeenCalledWith(42);

    vi.mocked(useMergeActivityCards).mockReturnValue([]);
  });

  it('re-enables cancel button after cancel merge error (cancellingMergeBookId resets)', async () => {
    const user = userEvent.setup();
    const { useMergeActivityCards } = await import('@/hooks/useMergeProgress');

    vi.mocked(useMergeActivityCards).mockReturnValue([
      { bookId: 42, bookTitle: 'Merge Book', phase: 'processing', percentage: 0.5 },
    ]);

    let rejectFn!: (err: Error) => void;
    vi.mocked(api.cancelMergeBook).mockReturnValue(
      new Promise((_resolve, reject) => { rejectFn = reject; }) as Promise<{ success: boolean }>,
    );
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<ActivityPage />);
    await waitFor(() => expect(screen.getByText('Merge Book')).toBeInTheDocument());

    const cancelButton = screen.getByRole('button', { name: /cancel merge/i });
    expect(cancelButton).not.toBeDisabled();

    await user.click(cancelButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel merge/i })).toBeDisabled();
    });

    await act(async () => { rejectFn(new Error('Server error')); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /cancel merge/i })).not.toBeDisabled();
    });

    vi.mocked(useMergeActivityCards).mockReturnValue([]);
  });
});

describe('ActivityPage tab buttons (#488)', () => {
  it('tab buttons render with type="button" and ARIA tab role', async () => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(screen.getByText('Nothing running right now')).toBeInTheDocument();
    });

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    for (const tab of tabs) {
      expect(tab).toHaveAttribute('type', 'button');
    }
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });
});


describe('#637 Activity page URL state', () => {
  beforeEach(() => {
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
  });

  it('reads tab from URL search params ?tab=history — History tab active', async () => {
    renderWithProviders(<ActivityPage />, { route: '/activity?tab=history' });

    await waitFor(() => {
      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('defaults to Active tab when no tab param present', async () => {
    renderWithProviders(<ActivityPage />, { route: '/activity' });

    await waitFor(() => {
      const activeTab = screen.getByRole('tab', { name: /active/i });
      expect(activeTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('tab change updates URL — clicking History tab shows history panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ActivityPage />, { route: '/activity' });

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /active/i })).toHaveAttribute('aria-selected', 'true');
    });

    const historyTab = screen.getByRole('tab', { name: /history/i });
    await user.click(historyTab);

    await waitFor(() => {
      expect(historyTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('navigation to /activity?tab=history&filter=import_failed opens History with filter applied', async () => {
    renderWithProviders(<ActivityPage />, { route: '/activity?tab=history&filter=import_failed' });

    await waitFor(() => {
      const historyTab = screen.getByRole('tab', { name: /history/i });
      expect(historyTab).toHaveAttribute('aria-selected', 'true');
    });

    await waitFor(() => {
      expect(api.getEventHistory).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'import_failed' }),
      );
    });
  });
});


describe('#748 importJobs SSE refetch gating', () => {
  // Fake intervals only; faking TanStack Query's timeouts deadlocks the suite.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.mocked(api.getActivity).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.getEventHistory).mockResolvedValue({ data: [], total: 0 });
    vi.mocked(api.getImportJobs).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not refetch importJobs on the 5s interval when SSE is connected', async () => {
    vi.mocked(useSSEConnected).mockReturnValue(true);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(api.getImportJobs).toHaveBeenCalledTimes(1);
    });

    await act(async () => { vi.advanceTimersByTime(6000); });

    expect(api.getImportJobs).toHaveBeenCalledTimes(1);
  });

  it('refetches importJobs every 5s when SSE is disconnected', async () => {
    vi.mocked(useSSEConnected).mockReturnValue(false);

    renderWithProviders(<ActivityPage />);

    await waitFor(() => {
      expect(api.getImportJobs).toHaveBeenCalledTimes(1);
    });

    await act(async () => { vi.advanceTimersByTime(6000); });

    await waitFor(() => {
      expect(api.getImportJobs).toHaveBeenCalledTimes(2);
    });
  });

  it('resumes polling when SSE flips from connected to disconnected', async () => {
    vi.mocked(useSSEConnected).mockReturnValue(true);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(api.getImportJobs).toHaveBeenCalledTimes(1);
    });

    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(api.getImportJobs).toHaveBeenCalledTimes(1);

    vi.mocked(useSSEConnected).mockReturnValue(false);
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActivityPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await act(async () => { vi.advanceTimersByTime(6000); });
    await waitFor(() => {
      expect(vi.mocked(api.getImportJobs).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
