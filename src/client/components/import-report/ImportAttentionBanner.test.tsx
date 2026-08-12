import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { QueryClient } from '@tanstack/react-query';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { FAST_POLL_MS, BASELINE_POLL_MS } from '@/lib/import-report/polling';
import { ImportAttentionBanner } from './ImportAttentionBanner';
import { __resetDismissalMemory, loadDismissedKeys } from '@/lib/import-report/dismissalStore';
import type { AttentionResponse, AttentionSubmission } from '@/lib/api';

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
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a failed attention read is observable/retryable, not silently "no banner"', async () => {
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('attention-error', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);

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
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.getByText(/nothing was imported/)).toBeInTheDocument();
  });

  it('processing → completed-attention raises then downshifts to the baseline cadence (never stops)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValue(resp(completed(2, 1, 0), false));
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Import finished with 1 hold')).toBeInTheDocument();
    // watch:false suppresses fast refetches but retains baseline polling.
    const calls = getImportSubmissionAttention.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(getImportSubmissionAttention.mock.calls.length).toBe(calls);
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS);
    expect(getImportSubmissionAttention.mock.calls.length).toBe(calls + 1);
  });

  it('same-id abandoned→processing→completed-attention re-raises even if abandoned was dismissed (distinct key)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention
      .mockResolvedValueOnce(resp(abandoned(5), true))
      .mockResolvedValueOnce(resp(null, true))
      .mockResolvedValue(resp(completed(5, 1, 0), false));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10);
    expect(screen.getByText('Import finished with 1 hold')).toBeInTheDocument();
  });

  it('discovers attention from idle at the baseline cadence (watch:false throughout, F70)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValue(resp(completed(8, 0, 2), false));
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, false));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(BASELINE_POLL_MS + 10);
    expect(screen.getByText('Import finished with 2 failures')).toBeInTheDocument();
  });

  it('after a cached {data:null,watch} response, a POLL rejection surfaces the retryable error — not silent (F37/F42)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValueOnce(resp(null, true));
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('attention-error')).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 5000);
    expect(screen.getByTestId('attention-error')).toBeInTheDocument();

    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(7), true));
    const callsBefore = getImportSubmissionAttention.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.advanceTimersByTimeAsync(50);
    expect(getImportSubmissionAttention.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(getImportSubmissionAttention).toHaveBeenLastCalledWith({ source: 'library' });
    expect(screen.queryByTestId('attention-error')).not.toBeInTheDocument();
    expect(screen.getByText(/nothing was imported/)).toBeInTheDocument();
  });

  it('after a VISIBLE banner, a POLL rejection retains the banner + a refresh-error retry that recovers on success (F37/F42/F48)', async () => {
    vi.useFakeTimers();
    // watch:true models another non-terminal run in scope.
    getImportSubmissionAttention.mockResolvedValueOnce(resp(completed(5, 2, 0), true));
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText('Import finished with 2 holds')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 5000);
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.getByText('Import finished with 2 holds')).toBeInTheDocument();
    expect(screen.getByTestId('attention-refresh-error')).toBeInTheDocument();

    getImportSubmissionAttention.mockResolvedValue(resp(completed(5, 2, 0), false));
    const callsBefore = getImportSubmissionAttention.mock.calls.length;
    fireEvent.click(within(screen.getByTestId('attention-refresh-error')).getByRole('button', { name: 'Retry' }));
    await vi.advanceTimersByTimeAsync(50);
    expect(getImportSubmissionAttention.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(getImportSubmissionAttention).toHaveBeenLastCalledWith({ source: 'library' });
    expect(screen.queryByTestId('attention-refresh-error')).not.toBeInTheDocument();
    expect(screen.getByText('Import finished with 2 holds')).toBeInTheDocument();
  });

  it('discard success clears the banner (attention refetches to null)', async () => {
    getImportSubmissionAttention.mockResolvedValueOnce(resp(abandoned(3), true));
    getImportSubmissionAttention.mockResolvedValue(resp(null, true));
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument());
    expect(discardImportSubmission).toHaveBeenCalledWith(3);
  });

  it('a successful discard is AUTHORITATIVE — the deleted banner clears even if the following attention refetch fails (F45)', async () => {
    vi.useFakeTimers();
    getImportSubmissionAttention.mockResolvedValueOnce(resp(abandoned(3), true));
    getImportSubmissionAttention.mockRejectedValue(new Error('refetch boom'));
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.getByText(/nothing was imported/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByText(/nothing was imported/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();

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
    expect(loadDismissedKeys()).toContain('42:completed-attention');
  });
});

/**
 * The banner's discard callbacks are hook-level, so they fire after the host route drops it.
 * "No setState after unmount" has no observation point under React 19 (the update is a silent
 * no-op), so these cases pin the two properties that ARE observable: the cache half stays
 * unconditional and correctly ordered, and the mounted lifecycle is unchanged.
 */
describe('ImportAttentionBanner discard callbacks after unmount (#2227)', () => {
  const attentionKey = queryKeys.importSubmissions.attention('library');
  const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  it('a discard settling after unmount still nulls every cached attention copy BEFORE invalidating the feed', async () => {
    const qc = newClient();
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    let release!: () => void;
    discardImportSubmission.mockReturnValue(new Promise<{ success: true }>((res) => { release = () => res({ success: true }); }));
    const { unmount } = renderWithProviders(
      <ImportAttentionBanner source="library" onImportAgain={vi.fn()} />, { queryClient: qc },
    );
    await screen.findByTestId('import-attention-banner');

    // Order probe: the rewrite has to have landed by the time invalidation fires, or a failed
    // refetch resurrects the delete action. Only reading the end state can't tell the two apart.
    const attentionAtInvalidate: Array<AttentionSubmission | null | undefined> = [];
    const invalidate = qc.invalidateQueries.bind(qc);
    vi.spyOn(qc, 'invalidateQueries').mockImplementation((...args: Parameters<typeof invalidate>) => {
      attentionAtInvalidate.push(qc.getQueryData<AttentionResponse>(attentionKey)?.data);
      return invalidate(...args);
    });

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    unmount();
    release();

    await waitFor(() => expect(qc.getQueryData<AttentionResponse>(attentionKey)?.data).toBeNull());
    expect(qc.getQueryState(attentionKey)?.isInvalidated).toBe(true);
    expect(attentionAtInvalidate).toEqual([null]);
  });

  it('a discard REJECTING after unmount settles as an error and leaves the cached envelope intact', async () => {
    const qc = newClient();
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    let reject!: () => void;
    discardImportSubmission.mockReturnValue(new Promise((_res, rej) => { reject = () => rej(new Error('409 conflict')); }));
    const { unmount } = renderWithProviders(
      <ImportAttentionBanner source="library" onImportAgain={vi.fn()} />, { queryClient: qc },
    );
    await screen.findByTestId('import-attention-banner');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    unmount();
    reject();

    // The component is gone, so the mutation cache is the only place the callback's execution is visible.
    await waitFor(() => expect(qc.getMutationCache().getAll().map((m) => m.state.status)).toContain('error'));
    expect(qc.getQueryData<AttentionResponse>(attentionKey)?.data).toEqual(expect.objectContaining({ id: 3 }));
    expect(qc.getQueryState(attentionKey)?.isInvalidated).toBe(false);
  });

  it('a discard failing after a poll re-renders the mounted banner still surfaces the error', async () => {
    const qc = newClient();
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    let reject!: () => void;
    discardImportSubmission.mockReturnValue(new Promise((_res, rej) => { reject = () => rej(new Error('409 conflict')); }));
    renderWithProviders(
      <ImportAttentionBanner source="library" onImportAgain={vi.fn()} />, { queryClient: qc },
    );
    await screen.findByTestId('import-attention-banner');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // An attention poll landing mid-flight commits a new render. Only a real teardown may retire a
    // generation — a generation advanced per commit would swallow this live failure.
    act(() => { qc.setQueryData(attentionKey, resp(abandoned(3), true)); });
    reject();

    expect(await screen.findByTestId('attention-discard-error')).toHaveTextContent('409 conflict');
  });

  it('a discard error still surfaces after StrictMode’s dev-mode mount → unmount → remount', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    discardImportSubmission.mockRejectedValue(new Error('409 conflict'));
    renderWithProviders(
      <StrictMode><ImportAttentionBanner source="library" onImportAgain={vi.fn()} /></StrictMode>,
    );
    await screen.findByTestId('import-attention-banner');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByTestId('attention-discard-error')).toHaveTextContent('409 conflict');
  });

  it('a successful Retry clears the discard error on a banner that is still mounted', async () => {
    const qc = newClient();
    getImportSubmissionAttention.mockResolvedValueOnce(resp(abandoned(3), true));
    // The post-discard refetch reports a DIFFERENT run so the banner stays on screen; otherwise the
    // error would vanish with the banner and prove nothing about the success path clearing it.
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(9), true));
    discardImportSubmission.mockRejectedValueOnce(new Error('409 conflict'));
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(
      <ImportAttentionBanner source="library" onImportAgain={vi.fn()} />, { queryClient: qc },
    );
    await screen.findByTestId('import-attention-banner');

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByTestId('attention-discard-error');
    await userEvent.click(within(screen.getByTestId('attention-discard-error')).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(qc.getQueryData<AttentionResponse>(attentionKey)?.data?.id).toBe(9));
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('attention-discard-error')).not.toBeInTheDocument();
    expect(discardImportSubmission).toHaveBeenNthCalledWith(2, 3);
  });
});
