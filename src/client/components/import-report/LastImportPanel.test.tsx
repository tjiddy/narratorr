import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { FAST_POLL_MS, BASELINE_POLL_MS } from '@/lib/import-report/polling';
import { LastImportPanel } from './LastImportPanel';
import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

const listImportSubmissions = vi.fn();
const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      listImportSubmissions: (...a: unknown[]) => listImportSubmissions(...a),
      getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a),
    },
  };
});

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 1, clientSubmissionId: 'c', source: 'library', status: 'receiving',
    expectedCount: 3, receivedCount: 2, processedCount: 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 },
    detailsPruned: false, itemsIncluded: false,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  listImportSubmissions.mockReset();
  getImportSubmissionDetail.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LastImportPanel (#1894)', () => {
  it('hides when the latest read returns no submission', async () => {
    listImportSubmissions.mockResolvedValue({ data: [], total: 0 });
    renderWithProviders(<LastImportPanel source="library" />);
    await waitFor(() => expect(screen.queryByTestId('last-import-skeleton')).not.toBeInTheDocument());
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument();
  });

  it('maps status → chip label and renders counts + the View in Activity link', async () => {
    listImportSubmissions.mockResolvedValue({
      data: [summary({ status: 'processing', aggregates: { accepted: 2, held: 1, skipped: 0, failed: 3 } })],
      total: 1,
    });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
    expect(screen.getByText('1 held')).toBeInTheDocument();
    expect(screen.getByText('3 failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View in Activity' })).toHaveAttribute('href', '/activity?tab=history&run=1');
  });

  it('uses completedAt for the relative time on a complete run (frozen clock, F24)', async () => {
    // Freeze Date only so relative time is deterministic without stalling findBy.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-07-21T12:00:00.000Z');
    vi.setSystemTime(now);
    listImportSubmissions.mockResolvedValue({
      data: [summary({
        status: 'complete',
        createdAt: new Date(now.getTime() - 60 * 1000).toISOString(),
        completedAt: new Date(now.getTime() - 3 * 3600 * 1000).toISOString(),
      })],
      total: 1,
    });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument();
  });

  it('malformed latest DTO → inline error + effect-keyed warn (F2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listImportSubmissions.mockResolvedValue({ data: [{ ...summary(), status: 'bogus' }], total: 1 });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-malformed');
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument();
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Malformed'), expect.anything()));
    warn.mockRestore();
  });

  it('expands to attention rows only (held → failed → skipped) with skipped link', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'complete', completedAt: new Date().toISOString() })], total: 1 });
    const detail: SubmissionResponse = {
      ...summary({ status: 'complete', completedAt: new Date().toISOString() }),
      itemsIncluded: true,
      items: [
        { disposition: 'accepted', ordinal: 0, path: '/a', title: 'Accepted One', bookId: 1 },
        { disposition: 'held', ordinal: 1, path: '/b', title: 'Held One', reason: 'recording-review-required' },
        { disposition: 'failed', ordinal: 2, path: '/c', title: 'Failed One', message: 'Disk full' },
        { disposition: 'skipped', ordinal: 3, path: '/d', title: 'Skipped One', reason: 'already-in-library', existingBookId: 9, existingTitle: 'Dune' },
      ],
    };
    getImportSubmissionDetail.mockResolvedValue(detail);
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByTestId('import-attention-rows');
    expect(screen.getByText('Held One')).toBeInTheDocument();
    expect(screen.getByText('Disk full')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dune' })).toHaveAttribute('href', '/books/9');
    expect(screen.queryByText('Accepted One')).not.toBeInTheDocument();
  });

  it('shows "Details expired" when the expansion returns a pruned record', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'complete', detailsPruned: true, completedAt: new Date().toISOString() })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(summary({ status: 'complete', detailsPruned: true, completedAt: new Date().toISOString() }));
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByTestId('import-details-expired');
  });

  it('shows an inline error + retry when the latest read fails with no cached data', async () => {
    listImportSubmissions.mockRejectedValue(new Error('boom'));
    renderWithProviders(<LastImportPanel source="library" />);
    // retry:2 requires the extended timeout.
    await screen.findByText('Couldn’t load the last import.', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);

  it('fresh-on-mount over a cached run: last-good stays visible with "refreshing…" (not a skeleton) while a network refetch runs (F15/F57)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.importSubmissions.latest('library'), summary({ status: 'complete', completedAt: new Date().toISOString() }));
    let resolveFetch!: () => void;
    listImportSubmissions.mockReturnValue(new Promise((r) => { resolveFetch = () => r({ data: [summary({ status: 'processing' })], total: 1 }); }));

    renderWithProviders(<LastImportPanel source="library" />, { queryClient: qc });

    await waitFor(() => expect(listImportSubmissions).toHaveBeenCalled());
    expect(screen.getByTestId('last-import-panel')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByTestId('last-import-refreshing')).toBeInTheDocument();
    expect(screen.queryByTestId('last-import-skeleton')).not.toBeInTheDocument();

    resolveFetch();
    await screen.findByText('Processing');
  });

  it('cold first load with no cache shows the skeleton', async () => {
    listImportSubmissions.mockReturnValue(new Promise(() => { /* never resolves */ }));
    renderWithProviders(<LastImportPanel source="library" />);
    expect(await screen.findByTestId('last-import-skeleton')).toBeInTheDocument();
  });

  it('polls at the FAST cadence through receiving→processing→complete, then downshifts to baseline (never stops) (F15/F69)', async () => {
    vi.useFakeTimers();
    const completedAt = new Date('2026-07-21T00:00:00.000Z').toISOString();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'complete', completedAt })], total: 1 });
    listImportSubmissions.mockResolvedValueOnce({ data: [summary({ status: 'receiving' })], total: 1 });
    listImportSubmissions.mockResolvedValueOnce({ data: [summary({ status: 'processing' })], total: 1 });

    renderWithProviders(<LastImportPanel source="library" />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Processing')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Completed')).toBeInTheDocument();

    const callsAtComplete = listImportSubmissions.mock.calls.length;
    // Completion suppresses fast polls but retains baseline discovery.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(listImportSubmissions.mock.calls.length).toBe(callsAtComplete);
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(listImportSubmissions.mock.calls.length).toBe(callsAtComplete + 1);
  });

  it('discovers a run that starts later while mounted with no submission (baseline cadence, F69)', async () => {
    vi.useFakeTimers();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'receiving' })], total: 1 });
    listImportSubmissions.mockResolvedValueOnce({ data: [], total: 0 });

    renderWithProviders(<LastImportPanel source="library" />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS + 10);
    expect(screen.getByText('Receiving')).toBeInTheDocument();
  });

  it('discovers a NEW run after an already-complete run via a baseline poll (old-complete discovery, F34)', async () => {
    vi.useFakeTimers();
    const completedAt = new Date('2026-07-21T00:00:00.000Z').toISOString();
    listImportSubmissions.mockResolvedValueOnce({ data: [summary({ id: 1, status: 'complete', completedAt })], total: 1 });
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 2, status: 'receiving' })], total: 1 });

    renderWithProviders(<LastImportPanel source="library" />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS + 10);
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('the expanded panel detail self-polls processing → terminal rows, then STOPS at complete (F35)', async () => {
    vi.useFakeTimers();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, status: 'processing' })], total: 1 });
    let phase: 'processing' | 'complete' = 'processing';
    getImportSubmissionDetail.mockImplementation(() => Promise.resolve(
      phase === 'processing'
        ? { ...summary({ id: 1, status: 'processing' }), itemsIncluded: true, items: [{ disposition: 'pending', ordinal: 0, path: '/a', title: 'Pending Book' }] }
        : { ...summary({ id: 1, status: 'complete', completedAt: new Date().toISOString() }), itemsIncluded: true, items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Failed Book', message: 'boom' }] },
    ));

    renderWithProviders(<LastImportPanel source="library" />);
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByText('Failed Book')).not.toBeInTheDocument();

    phase = 'complete';
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Failed Book')).toBeInTheDocument();

    phase = 'processing';
    const calls = getImportSubmissionDetail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(getImportSubmissionDetail.mock.calls.length).toBe(calls);
    expect(screen.getByText('Failed Book')).toBeInTheDocument();
  });
});
