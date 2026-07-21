import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
    // Freeze ONLY Date so `formatRelativeDate`'s `new Date()` is deterministic while
    // real timers still drive findBy — no ambient-clock flake on exact "3h ago".
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-07-21T12:00:00.000Z');
    vi.setSystemTime(now);
    listImportSubmissions.mockResolvedValue({
      data: [summary({
        status: 'complete',
        createdAt: new Date(now.getTime() - 60 * 1000).toISOString(), // 1m ago
        completedAt: new Date(now.getTime() - 3 * 3600 * 1000).toISOString(), // 3h ago
      })],
      total: 1,
    });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument(); // completedAt, not createdAt's "1m ago"
  });

  it('malformed latest DTO → inline error + effect-keyed warn (F2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `status` is not a valid submission status → summary schema safeParse fails.
    listImportSubmissions.mockResolvedValue({ data: [{ ...summary(), status: 'bogus' }], total: 1 });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-malformed');
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument(); // never reaches StatusChip
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
    expect(screen.queryByText('Accepted One')).not.toBeInTheDocument(); // accepted is count-only
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
    // The hook uses retry:2 (exponential backoff ~1s+2s) before surfacing the error.
    await screen.findByText('Couldn’t load the last import.', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);

  it('fresh-on-mount over a cached run: last-good stays visible with "refreshing…" (not a skeleton) while a network refetch runs (F15/F57)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Cache already holds a prior (complete) run for this source.
    qc.setQueryData(queryKeys.importSubmissions.latest('library'), summary({ status: 'complete', completedAt: new Date().toISOString() }));
    let resolveFetch!: () => void;
    listImportSubmissions.mockReturnValue(new Promise((r) => { resolveFetch = () => r({ data: [summary({ status: 'processing' })], total: 1 }); }));

    renderWithProviders(<LastImportPanel source="library" />, { queryClient: qc });

    // Mount refetch fires (fresh request) while the last-good content stays visible.
    await waitFor(() => expect(listImportSubmissions).toHaveBeenCalled());
    expect(screen.getByTestId('last-import-panel')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument(); // last-good, not blanked
    expect(screen.getByTestId('last-import-refreshing')).toBeInTheDocument();
    expect(screen.queryByTestId('last-import-skeleton')).not.toBeInTheDocument();

    resolveFetch();
    await screen.findByText('Processing'); // updates when the fresh fetch resolves
  });

  it('cold first load with no cache shows the skeleton', async () => {
    listImportSubmissions.mockReturnValue(new Promise(() => { /* pending forever */ }));
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
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // fast poll while non-complete
    expect(screen.getByText('Processing')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Completed')).toBeInTheDocument();

    const callsAtComplete = listImportSubmissions.mock.calls.length;
    // At complete the fast interval must NOT fire — it downshifted to baseline…
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(listImportSubmissions.mock.calls.length).toBe(callsAtComplete);
    // …but it never fully stops: the baseline poll still fires.
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(listImportSubmissions.mock.calls.length).toBe(callsAtComplete + 1);
  });

  it('discovers a run that starts later while mounted with no submission (baseline cadence, F69)', async () => {
    vi.useFakeTimers();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'receiving' })], total: 1 });
    listImportSubmissions.mockResolvedValueOnce({ data: [], total: 0 }); // initially absent

    renderWithProviders(<LastImportPanel source="library" />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument(); // hidden
    // A later baseline poll discovers the newly-started run without a remount.
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS + 10);
    expect(screen.getByText('Receiving')).toBeInTheDocument();
  });
});
