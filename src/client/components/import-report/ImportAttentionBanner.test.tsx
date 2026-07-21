import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { FAST_POLL_MS, BASELINE_POLL_MS } from '@/lib/import-report/polling';
import { ImportAttentionBanner } from './ImportAttentionBanner';
import { __resetDismissalMemory, loadDismissedKeys } from '@/lib/import-report/dismissalStore';
import type { AttentionResponse, AttentionSubmission } from '@/lib/api';

/** Shows the current router location so navigation can be asserted. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

const getImportSubmissionAttention = vi.fn();
const discardImportSubmission = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getImportSubmissionAttention: (...a: unknown[]) => getImportSubmissionAttention(...a),
      discardImportSubmission: (...a: unknown[]) => discardImportSubmission(...a),
    },
  };
});

function abandoned(id: number, received = 2, expected = 3): AttentionSubmission {
  return {
    id, clientSubmissionId: 'c', source: 'library', status: 'receiving',
    expectedCount: expected, receivedCount: received, processedCount: 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 }, detailsPruned: false,
    itemsIncluded: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attention: { kind: 'abandoned' },
  };
}
function completed(id: number, held: number, failed: number): AttentionSubmission {
  return {
    id, clientSubmissionId: 'c', source: 'library', status: 'complete',
    expectedCount: 3, receivedCount: 3, processedCount: held + failed,
    aggregates: { accepted: 0, held, skipped: 0, failed }, detailsPruned: false,
    itemsIncluded: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    attention: { kind: 'completed-attention', held, failed },
  };
}
const resp = (data: AttentionSubmission | null, watch = false): AttentionResponse => ({ data, watch });

beforeEach(() => {
  getImportSubmissionAttention.mockReset();
  discardImportSubmission.mockReset();
  __resetDismissalMemory();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImportAttentionBanner (#1894)', () => {
  it('renders abandoned copy with Discard + Import again', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(1, 2, 3), true));
    const onImportAgain = vi.fn();
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={onImportAgain} />);
    await screen.findByTestId('import-attention-banner');
    expect(screen.getByText('2 of 3 received — nothing was imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import again' }));
    expect(onImportAgain).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('renders the deterministic completed-attention templates (singular/plural)', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(completed(5, 2, 3)));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    expect(screen.getByText('Import finished with 2 holds and 3 failures')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
  });

  it('renders no banner when data is null', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(null, false));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await waitFor(() => expect(getImportSubmissionAttention).toHaveBeenCalled());
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
  });

  it('dismisses per (id + kind) — dismissing abandoned hides it', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(7), true));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
  });

  it('retains the banner + shows an error + retry when Discard fails (never optimistically cleared)', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    discardImportSubmission.mockRejectedValue(new Error('409 conflict'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByTestId('attention-discard-error');
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument(); // retained
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a failed attention read is observable/retryable, not silently "no banner"', async () => {
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('attention-error', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);

  // ── F16: source scoping + live transitions + never-stopping cadence ──────────
  it('import-page hosts pass source; the Library page host passes none (cross-source)', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(null, false));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await waitFor(() => expect(getImportSubmissionAttention).toHaveBeenCalledWith({ source: 'library' }));
    getImportSubmissionAttention.mockClear();
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await waitFor(() => expect(getImportSubmissionAttention).toHaveBeenCalledWith(undefined));
  });

  it('fresh receiving → abandoned raises on the next FAST poll and stays fast (watch:true)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(1), true));
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true)); // fresh receiving, no attention yet
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // watch:true → fast poll
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.getByText(/nothing was imported/)).toBeInTheDocument();
  });

  it('processing → completed-attention raises then downshifts to the baseline cadence (never stops)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValue(resp(completed(2, 1, 0), false)); // completed-attention, watch:false
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true)); // processing
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Import finished with 1 hold')).toBeInTheDocument();
    // watch:false → downshift. A fast interval must NOT refetch now…
    const calls = getImportSubmissionAttention.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(getImportSubmissionAttention.mock.calls.length).toBe(calls);
    // …but the baseline poll still fires (never fully stops).
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(getImportSubmissionAttention.mock.calls.length).toBe(calls + 1);
  });

  it('same-id abandoned→processing→completed-attention re-raises even if abandoned was dismissed (distinct key)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention
      .mockResolvedValueOnce(resp(abandoned(5), true)) // abandoned
      .mockResolvedValueOnce(resp(null, true))         // finalized elsewhere → processing
      .mockResolvedValue(resp(completed(5, 1, 0), false)); // completed-attention, SAME id
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); // dismiss the abandoned banner
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // processing → null
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // completed-attention same id → distinct key re-raises
    expect(screen.getByText('Import finished with 1 hold')).toBeInTheDocument();
  });

  it('discovers attention from idle at the baseline cadence (watch:false throughout, F70)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValue(resp(completed(8, 0, 2), false));
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, false)); // idle
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS + 10); // baseline discovery — polling never stopped
    expect(screen.getByText('Import finished with 2 failures')).toBeInTheDocument();
  });

  // ── F42: cached-envelope poll failure (both retained-envelope branches) ──────
  it('after a cached {data:null,watch} response, a POLL rejection surfaces the retryable error — not silent (F37/F42)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true)); // cached null + watch → fast poll
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument(); // no banner (data null)
    expect(screen.queryByTestId('attention-error')).not.toBeInTheDocument(); // and no error yet

    // The fast poll fails (retry:2 backoff) → the failure is OBSERVABLE, not silent null.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 5000);
    expect(screen.getByTestId('attention-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('after a VISIBLE banner, a POLL rejection retains the banner + a refresh-error retry (F37/F42)', async () => {
    vi.useFakeTimers();
    // completed-attention with watch:true (another non-terminal run in scope) → fast poll.
    getImportSubmissionAttention.mockResolvedValueOnce(resp(completed(5, 2, 0), true));
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText('Import finished with 2 holds')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 5000); // poll (+retries) fails
    // The last-good banner is RETAINED and a refresh-error retry appears.
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.getByText('Import finished with 2 holds')).toBeInTheDocument();
    expect(screen.getByTestId('attention-refresh-error')).toBeInTheDocument();
  });

  // ── F18: discard/view-details mutation & navigation lifecycle ────────────────
  it('discard success clears the banner (attention refetches to null)', async () => {
    getImportSubmissionAttention.mockResolvedValueOnce(resp(abandoned(3), true));
    getImportSubmissionAttention.mockResolvedValue(resp(null, true)); // after invalidation
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument());
    expect(discardImportSubmission).toHaveBeenCalledWith(3);
  });

  it('a successful discard is AUTHORITATIVE — the deleted banner clears even if the following attention refetch fails (F45)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValueOnce(resp(abandoned(3), true)); // banner for id 3
    getImportSubmissionAttention.mockRejectedValue(new Error('refetch boom')); // the post-discard refetch fails
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText(/nothing was imported/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await vi.advanceTimersByTimeAsync(10); // discard resolves → deleted id cleared from cache
    // The deleted submission's banner is GONE — no re-actionable Discard for id 3.
    expect(screen.queryByText(/nothing was imported/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();

    // Even after the refetch exhausts and fails, the deleted banner stays cleared;
    // the failure is surfaced as the observable/retryable attention error, not the old banner.
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 5000);
    expect(screen.queryByText(/nothing was imported/)).not.toBeInTheDocument();
    expect(screen.getByTestId('attention-error')).toBeInTheDocument();
  });

  it('Discard is disabled while the mutation is pending', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    let resolveDiscard!: () => void;
    discardImportSubmission.mockReturnValue(new Promise((r) => { resolveDiscard = () => r({ success: true }); }));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled());
    resolveDiscard();
  });

  it('Retry after a discard failure issues a SECOND discard call', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    discardImportSubmission.mockRejectedValue(new Error('409'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByTestId('attention-discard-error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(discardImportSubmission).toHaveBeenCalledTimes(2));
  });

  it('View details navigates to the run deep link AND dismisses the banner', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(completed(42, 1, 0), false));
    renderWithProviders(
      <><ImportAttentionBanner onImportAgain={vi.fn()} /><LocationProbe /></>,
    );
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'View details' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/activity?tab=history&run=42'));
    expect(loadDismissedKeys()).toContain('42:completed-attention'); // dismissed on view
  });
});
