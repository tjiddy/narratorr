import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { FAST_POLL_MS } from '@/lib/import-report/polling';
import * as importReportHooks from '@/hooks/useImportReport';
import { ImportDetailExpansion } from './ImportDetailExpansion';
import type { SubmissionResponse } from '@/lib/api';

const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a) } };
});

type DetailQuery = ReturnType<typeof importReportHooks.useImportSubmissionDetail>;

function detail(id: number, title: string, status: SubmissionResponse['status'] = 'complete', disposition: 'failed' | 'pending' = 'failed'): SubmissionResponse {
  return {
    id, clientSubmissionId: 'c', source: 'library', status,
    expectedCount: 1, receivedCount: 1, processedCount: status === 'complete' ? 1 : 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: status === 'complete' ? 1 : 0 },
    detailsPruned: false, itemsIncluded: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(status === 'complete' ? { completedAt: new Date().toISOString() } : {}),
    items: disposition === 'failed'
      ? [{ disposition: 'failed', ordinal: 0, path: '/a', title, message: 'boom' }]
      : [{ disposition: 'pending', ordinal: 0, path: '/a', title }],
  };
}

/** Stateful harness that lets a test flip the consumed id in place. */
function Harness() {
  const [id, setId] = useState(1);
  return (
    <div>
      <button onClick={() => setId(2)}>next</button>
      <ImportDetailExpansion id={id} />
    </div>
  );
}

beforeEach(() => getImportSubmissionDetail.mockReset());
afterEach(() => vi.useRealTimers());

describe('ImportDetailExpansion (#1894)', () => {
  it('does NOT render a prior id\'s rows while a new id\'s detail is pending (F3/F40)', async () => {
    let resolveTwo!: () => void;
    const twoGate = new Promise<void>((res) => { resolveTwo = res; });
    getImportSubmissionDetail.mockImplementation((id: number) =>
      id === 1
        ? Promise.resolve(detail(1, 'Book One'))
        : twoGate.then(() => detail(2, 'Book Two'))); // pending until the test opens the gate

    renderWithProviders(<Harness />);
    await screen.findByText('Book One'); // id 1 detail rendered

    fireEvent.click(screen.getByRole('button', { name: 'next' })); // switch consumer to id 2 (pending)
    // The id-1 rows must NOT linger under id 2 (the placeholderData id guard, F3):
    // the expansion shows loading, not the stale id-1 rows.
    await waitFor(() => expect(screen.getByTestId('import-detail-loading')).toBeInTheDocument());
    expect(screen.queryByText('Book One')).not.toBeInTheDocument();
    expect(screen.queryByText('Book Two')).not.toBeInTheDocument();

    resolveTwo();
    await screen.findByText('Book Two');
  });

  it('self-polls a fixed id from processing to terminal rows, then STOPS at complete (F35)', async () => {
    vi.useFakeTimers();
    let phase: 'processing' | 'complete' = 'processing';
    getImportSubmissionDetail.mockImplementation(() =>
      Promise.resolve(phase === 'processing' ? detail(1, 'Pending Book', 'processing', 'pending') : detail(1, 'Failed Book', 'complete', 'failed')));

    renderWithProviders(<ImportDetailExpansion id={1} />);
    await vi.advanceTimersByTimeAsync(10);
    expect(screen.queryByText('Failed Book')).not.toBeInTheDocument(); // pending → no attention rows yet

    phase = 'complete';
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS + 10); // detail's own poll advances to terminal
    expect(screen.getByText('Failed Book')).toBeInTheDocument();

    // Poll STOPS at complete — flipping the mock back to processing has no effect.
    phase = 'processing';
    const calls = getImportSubmissionDetail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
    expect(getImportSubmissionDetail.mock.calls.length).toBe(calls);
    expect(screen.getByText('Failed Book')).toBeInTheDocument();
  });

  it('retains last-good rows on a background poll failure and surfaces a retry — cold failure replaces (F30)', () => {
    // Component-level render decision (the F30 fix reordered `isError` vs `detail`):
    // isError WITH retained data → keep the rows + a retry affordance; isError with
    // NO data → the cold replacement error. Driving the shared hook to an
    // {isError, data} state through real polling fights TanStack's rejection timing,
    // so the render branch is asserted directly here.
    const refetch = vi.fn();
    const spy = vi.spyOn(importReportHooks, 'useImportSubmissionDetail');

    // Background failure WITH retained data → rows retained + refresh retry, not cold error.
    spy.mockReturnValue({ data: detail(1, 'Held Later'), isError: true, refetch } as unknown as DetailQuery);
    const { unmount } = renderWithProviders(<ImportDetailExpansion id={1} />);
    expect(screen.getByText('Held Later')).toBeInTheDocument();
    expect(screen.getByTestId('import-detail-refresh-error')).toBeInTheDocument();
    expect(screen.queryByTestId('import-detail-error')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
    unmount();

    // COLD failure (no retained data) → the replacement error block.
    spy.mockReturnValue({ data: undefined, isError: true, refetch } as unknown as DetailQuery);
    renderWithProviders(<ImportDetailExpansion id={1} />);
    expect(screen.getByTestId('import-detail-error')).toBeInTheDocument();
    expect(screen.queryByTestId('import-detail-refresh-error')).not.toBeInTheDocument();
    spy.mockRestore();
  });
});
