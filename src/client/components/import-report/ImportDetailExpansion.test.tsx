import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { FAST_POLL_MS } from '@/lib/import-report/polling';
import { ImportDetailExpansion } from './ImportDetailExpansion';
import type { SubmissionResponse } from '@/lib/api';

const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: { getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a) } };
});

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

  it('drives the REAL hook: a timed poll failure retains last-good rows + refresh retry, and Retry re-hits the API with the same id (F30/F41)', async () => {
    const { ApiError } = await import('@/lib/api');
    // Real hook, real API mock, REAL timers. First fetch: processing detail with rows,
    // so the shared hook keeps polling. (Fake timers fight TanStack's rejection timing.)
    getImportSubmissionDetail.mockResolvedValueOnce(detail(1, 'Held Later', 'processing', 'failed'));
    renderWithProviders(<ImportDetailExpansion id={1} />);
    await screen.findByText('Held Later');

    // The next timed poll fails FAST (404 → the hook does not retry).
    getImportSubmissionDetail.mockRejectedValue(new ApiError(404, { error: 'gone' }));
    await screen.findByTestId('import-detail-refresh-error', {}, { timeout: 8000 }); // the real 3s poll fires + fails
    expect(screen.getByText('Held Later')).toBeInTheDocument(); // last-good rows RETAINED
    expect(screen.queryByTestId('import-detail-error')).not.toBeInTheDocument(); // NOT the cold replacement

    // Retry reaches the API again with the SAME id, and the rows update on success.
    getImportSubmissionDetail.mockReset();
    getImportSubmissionDetail.mockResolvedValue(detail(1, 'Held Now', 'complete', 'failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getImportSubmissionDetail).toHaveBeenCalledWith(1));
    await screen.findByText('Held Now');
    // The cold-failure replacement error (no retained data → `import-detail-error`) is
    // covered by the section's per-card cold-failure test (F23).
  }, 15000);
});
