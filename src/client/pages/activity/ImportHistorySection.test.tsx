import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { FAST_POLL_MS } from '@/lib/import-report/polling';
import { ImportHistorySection } from './ImportHistorySection';
import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

const listImportSubmissions = vi.fn();
const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual, // keep the real ApiError class for instanceof checks
    api: {
      listImportSubmissions: (...a: unknown[]) => listImportSubmissions(...a),
      getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a),
    },
  };
});

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 1, clientSubmissionId: 'c', source: 'library', status: 'complete',
    expectedCount: 3, receivedCount: 3, processedCount: 3,
    aggregates: { accepted: 1, held: 1, skipped: 0, failed: 1 },
    detailsPruned: false, itemsIncluded: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
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

describe('ImportHistorySection (#1894)', () => {
  it('renders cards with source label + mode + counts, newest-first from the server', async () => {
    listImportSubmissions.mockResolvedValue({
      data: [summary({ id: 2, source: 'manual', mode: 'copy' }), summary({ id: 1 })],
      total: 2,
    });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-2');
    expect(screen.getByText('Import history')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('· copy')).toBeInTheDocument();
    expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument();
  });

  it('shows the empty state when total is 0', async () => {
    listImportSubmissions.mockResolvedValue({ data: [], total: 0 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-empty');
    expect(screen.getByText('No import history yet.')).toBeInTheDocument();
  });

  it('auto-expands a present deep-link run and shows its attention rows', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 5 })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 5 }), itemsIncluded: true,
      items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Boom Book', message: 'kaboom' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=5' });
    await screen.findByText('kaboom');
    expect(screen.getByText('Boom Book')).toBeInTheDocument();
  });

  it('hydrates an off-page deep-link run into exactly one focused card (F64)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 }); // page lacks id 9
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 9 }), itemsIncluded: true,
      items: [{ disposition: 'held', ordinal: 0, path: '/h', title: 'Held Book', reason: 'recording-review-required' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    await waitFor(() => expect(screen.getAllByTestId('import-history-card-9')).toHaveLength(1));
    expect(screen.getByText('Held Book')).toBeInTheDocument();
  });

  it('degrades a 404 deep link to a "no longer available" placeholder (no retry, F59)', async () => {
    const { ApiError } = await import('@/lib/api');
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    getImportSubmissionDetail.mockRejectedValue(new ApiError(404, { error: 'submission-not-found' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    await screen.findByTestId('import-run-unavailable');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    // The rest of the section still renders.
    expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument();
  });

  it('an ON-PAGE deep-link 404 (discarded/GC\'d between snapshot and read) renders the same 404 placeholder, not the generic detail error (F43)', async () => {
    const { ApiError } = await import('@/lib/api');
    // The run id IS on the current page, but the direct read now 404s.
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    getImportSubmissionDetail.mockRejectedValue(new ApiError(404, { error: 'submission-not-found' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=1' });
    // One 404-aware hydration authority regardless of on/off page.
    expect(await screen.findByTestId('import-run-unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument(); // 404 → no retry
    expect(screen.queryByText('Couldn’t load import details.')).not.toBeInTheDocument(); // NOT the generic arm
    expect(screen.queryByTestId('import-history-card-1')).not.toBeInTheDocument(); // target not also rendered as a list row
  });

  it('a detail that completes BEFORE the list resolves keeps its terminal header — a late processing list row cannot revert it (F44)', async () => {
    let resolveList!: (v: { data: SubmissionSummary[]; total: number }) => void;
    listImportSubmissions.mockReturnValue(new Promise((res) => { resolveList = res; })); // list stays pending
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 1, status: 'complete', completedAt: new Date().toISOString(), processedCount: 3, aggregates: { accepted: 1, held: 1, skipped: 0, failed: 1 } }),
      itemsIncluded: true, items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Failed Book', message: 'boom' }],
    });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=1' });
    // The detail reaches complete while the list is still loading.
    await screen.findByText('Completed');
    await screen.findByText('Failed Book');
    const listCallsBefore = listImportSubmissions.mock.calls.length;

    // The list now resolves with the SAME id from an EARLIER processing snapshot.
    resolveList({ data: [summary({ id: 1, status: 'processing', processedCount: 1, aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 } })], total: 1 });

    // The header must NOT revert to Processing (single source = the hydrated detail),
    // and the target is never rendered twice.
    await waitFor(() => expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument());
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('import-history-card-1')).toHaveLength(1);
    expect(listImportSubmissions.mock.calls.length).toBe(listCallsBefore); // no extra list fetch triggered
  });

  it('ignores a non-positive-integer run (all collapsed)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=abc' });
    await screen.findByTestId('import-history-card-1');
    expect(getImportSubmissionDetail).not.toHaveBeenCalled();
  });

  it('shows a section-level error + retry when the list read fails', async () => {
    listImportSubmissions.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByText('Couldn’t load import history.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('promotes a self-polled detail header into the card and keeps it terminal across collapse/re-expand (F86)', async () => {
    const user = userEvent.setup();
    // The list snapshot shows the run still Processing…
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, status: 'processing', processedCount: 1, aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 } })], total: 1 });
    // …but the detail read for that id is already terminal.
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 1, status: 'complete', processedCount: 3 }), itemsIncluded: true,
      items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Failed Book', message: 'nope' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    const card = await screen.findByTestId('import-history-card-1');
    expect(screen.getByText('Processing')).toBeInTheDocument();

    await user.click(card.querySelector('button')!); // expand → detail promotes the header
    await screen.findByText('Failed Book');
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();

    await user.click(card.querySelector('button')!); // collapse — header must stay Completed
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await user.click(card.querySelector('button')!); // re-expand
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await screen.findByText('Failed Book');
  });

  it('a pruned card still issues the mandatory direct GET and renders "details expired" (F4)', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, detailsPruned: true })], total: 1 });
    // The direct GET returns the pruned summary arm (itemsIncluded:false, detailsPruned:true).
    getImportSubmissionDetail.mockResolvedValue(summary({ id: 1, detailsPruned: true }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-1');
    await user.click(screen.getByTestId('import-history-card-1').querySelector('button')!);
    expect(await screen.findByTestId('import-details-expired')).toBeInTheDocument();
    expect(getImportSubmissionDetail).toHaveBeenCalledWith(1); // F4 — never skips the GET
  });

  it('auto-expands a pruned deep-link run via the direct GET (F4)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3, detailsPruned: true })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(summary({ id: 3, detailsPruned: true }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=3' });
    expect(await screen.findByTestId('import-details-expired')).toBeInTheDocument();
    expect(getImportSubmissionDetail).toHaveBeenCalledWith(3);
  });

  // ── F20: status labels, relative-time source, pagination ────────────────────
  it('renders all three status labels and uses completedAt/createdAt correctly under a frozen clock (F20)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-07-21T12:00:00.000Z');
    vi.setSystemTime(now);
    listImportSubmissions.mockResolvedValue({
      data: [
        summary({ id: 1, status: 'complete', createdAt: new Date(now.getTime() - 60_000).toISOString(), completedAt: new Date(now.getTime() - 2 * 3600_000).toISOString() }),
        summary({ id: 2, status: 'processing', createdAt: new Date(now.getTime() - 3 * 3600_000).toISOString() }),
        summary({ id: 3, status: 'receiving', createdAt: new Date(now.getTime() - 5 * 60_000).toISOString() }),
      ],
      total: 3,
    });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-1');
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Receiving')).toBeInTheDocument();
    // complete → completedAt (2h ago), NOT createdAt (1m ago); processing → createdAt (3h ago).
    expect(screen.getByText('2h ago')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument();
  });

  it('paginates — a page change re-queries with the next offset (F20)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 120 }); // > page size
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-1');
    expect(listImportSubmissions).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(listImportSubmissions).toHaveBeenCalledWith({ limit: 50, offset: 50 }));
  });

  // ── F17: shared detail hook self-polls processing → complete ────────────────
  it('an expanded card self-polls its detail from processing to terminal rows, patches the header, then stops (F17)', async () => {
    vi.useFakeTimers();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, status: 'processing', processedCount: 1 })], total: 1 });
    getImportSubmissionDetail
      .mockResolvedValueOnce({ ...summary({ id: 1, status: 'processing' }), itemsIncluded: true, items: [{ disposition: 'pending', ordinal: 0, path: '/a', title: 'Pending Book' }] })
      .mockResolvedValue({ ...summary({ id: 1, status: 'complete', processedCount: 2 }), itemsIncluded: true, items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Failed Book', message: 'boom' }] });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByTestId('import-history-card-1').querySelector('button')!);
    await vi.advanceTimersByTimeAsync(10);
    // Pre-terminal snapshot: only a pending row → no attention rows yet.
    expect(screen.queryByText('Failed Book')).not.toBeInTheDocument();
    // Advance the detail's own poll → terminal state.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Failed Book')).toBeInTheDocument(); // terminal rows replace pending
    expect(screen.getByText('Completed')).toBeInTheDocument(); // header patched (F86)
    // The detail poll STOPS at complete — no further detail fetches.
    const calls = getImportSubmissionDetail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(getImportSubmissionDetail.mock.calls.length).toBe(calls);
  });

  it('an OFF-PAGE deep-linked card self-polls to terminal ROWS and HEADER, stays terminal across collapse/re-expand, and never refetches the list (F35/F46)', async () => {
    vi.useFakeTimers();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 }); // page lacks id 9
    let phase: 'processing' | 'complete' = 'processing';
    getImportSubmissionDetail.mockImplementation(() => Promise.resolve(
      phase === 'processing'
        ? { ...summary({ id: 9, status: 'processing', processedCount: 0, aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 } }), itemsIncluded: true, items: [{ disposition: 'pending', ordinal: 0, path: '/a', title: 'Pending Book' }] }
        : { ...summary({ id: 9, status: 'complete', processedCount: 1, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 }, completedAt: new Date('2026-07-21T00:00:00.000Z').toISOString() }), itemsIncluded: true, items: [{ disposition: 'held', ordinal: 0, path: '/a', title: 'Held Book', reason: 'recording-review-required' }] },
    ));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    await vi.advanceTimersByTimeAsync(10);
    const card9 = () => screen.getByTestId('import-history-card-9'); // re-query (DOM re-renders)
    expect(within(card9()).getByText('Processing')).toBeInTheDocument(); // header from the detail (processing)
    expect(screen.queryByText('Held Book')).not.toBeInTheDocument();
    const listCalls = listImportSubmissions.mock.calls.length;

    phase = 'complete';
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // the detail's own poll advances
    // Terminal ROWS and terminal HEADER (status + counts) both update from the detail.
    expect(screen.getByText('Held Book')).toBeInTheDocument();
    expect(within(card9()).getByText('Completed')).toBeInTheDocument();
    expect(within(card9()).getByText('1 held')).toBeInTheDocument();
    expect(within(card9()).queryByText('Processing')).not.toBeInTheDocument();

    // Collapse and re-expand — the header stays terminal (never reverts to Processing).
    fireEvent.click(within(card9()).getAllByRole('button')[0]!);
    await vi.advanceTimersByTimeAsync(10);
    expect(within(card9()).getByText('Completed')).toBeInTheDocument();
    expect(screen.queryByText('Held Book')).not.toBeInTheDocument(); // rows collapsed
    fireEvent.click(within(card9()).getAllByRole('button')[0]!);
    await vi.advanceTimersByTimeAsync(10);
    expect(within(card9()).getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Held Book')).toBeInTheDocument();

    // The detail poll STOPPED at complete, and the off-page path never refetched the list.
    phase = 'processing';
    const detailCalls = getImportSubmissionDetail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(getImportSubmissionDetail.mock.calls.length).toBe(detailCalls);
    expect(listImportSubmissions.mock.calls.length).toBe(listCalls);
    expect(screen.getAllByTestId('import-history-card-9')).toHaveLength(1);
  });

  it('a deep-link target with a malformed detail is caught by the hydration authority before rendering a header (F29/F43)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue({ ...summary({ id: 1 }), itemsIncluded: true, items: [{ disposition: 'bogus', ordinal: 0 }] });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=1' });
    // The deep-link target (on- or off-page) renders through the single hydration
    // authority, which validates the detail and shows its error before any header.
    expect(await screen.findByTestId('import-run-malformed')).toBeInTheDocument();
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('Malformed'), expect.anything()));
    warn.mockRestore();
  });

  // ── F23: transient deep-link + per-card detail failure isolation ────────────
  it('a transient (non-404) deep-link failure renders a focused retry card while other cards remain (F23)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 }); // id 1 on page
    getImportSubmissionDetail.mockRejectedValue(new Error('network')); // off-page hydrate for run=9 fails transiently
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    // A transient (non-404) error retries twice (backoff ~3s) before surfacing.
    await screen.findByText('Couldn’t load this import run.', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument(); // other cards remain
    expect(screen.queryByTestId('import-run-unavailable')).not.toBeInTheDocument(); // not the 404 arm
  }, 12000);

  it('a per-card detail failure shows a local retry inside that card only (F23)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 }), summary({ id: 2 })], total: 2 });
    getImportSubmissionDetail.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-1');
    fireEvent.click(screen.getByTestId('import-history-card-1').querySelector('button')!);
    await screen.findByText('Couldn’t load import details.', {}, { timeout: 8000 });
    expect(screen.getByTestId('import-history-card-2')).toBeInTheDocument(); // sibling card unaffected
  }, 12000);
});
