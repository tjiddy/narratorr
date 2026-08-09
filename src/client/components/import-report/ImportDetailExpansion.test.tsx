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
        : twoGate.then(() => detail(2, 'Book Two')));

    renderWithProviders(<Harness />);
    await screen.findByText('Book One');

    fireEvent.click(screen.getByRole('button', { name: 'next' }));
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

  it('drives the REAL hook: a timed poll failure retains last-good rows + refresh retry, and Retry re-hits the API with the same id (F30/F41)', async () => {
    const { ApiError } = await import('@/lib/api');
    // Real timers avoid TanStack rejection races; 404 disables hook retries.
    getImportSubmissionDetail.mockResolvedValueOnce(detail(1, 'Held Later', 'processing', 'failed'));
    renderWithProviders(<ImportDetailExpansion id={1} />);
    await screen.findByText('Held Later');

    getImportSubmissionDetail.mockRejectedValue(new ApiError(404, { error: 'gone' }));
    await screen.findByTestId('import-detail-refresh-error', {}, { timeout: 8000 });
    expect(screen.getByText('Held Later')).toBeInTheDocument();
    expect(screen.queryByTestId('import-detail-error')).not.toBeInTheDocument();

    getImportSubmissionDetail.mockReset();
    getImportSubmissionDetail.mockResolvedValue(detail(1, 'Held Now', 'complete', 'failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getImportSubmissionDetail).toHaveBeenCalledWith(1));
    await screen.findByText('Held Now');
  }, 15000);
});
