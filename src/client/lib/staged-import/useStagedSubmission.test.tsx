import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useStagedSubmission } from './useStagedSubmission.js';
import { summaryResponse } from './__tests__/staged-fixtures.js';
import { __resetOutboxCache, readOutbox } from './outbox.js';

/**
 * Focused unit tests for the run-supersession / abort / epoch guards (#1902 F19). The
 * digest step is mocked so a run can be held mid-`computeSubmissionDigest` while a newer
 * submit supersedes it, or the component unmounts — proving that a superseded/unmounted
 * run's late continuation starts no network chain and mutates no newer-run state.
 */

// Hold each digest call open until the test resolves it (vi.hoisted so the mock factory can see it).
const { digestResolvers } = vi.hoisted(() => ({ digestResolvers: [] as Array<(v: string) => void> }));
vi.mock('./digest.js', () => ({
  computeSubmissionDigest: vi.fn(() => new Promise<string>((resolve) => { digestResolvers.push(resolve); })),
}));

const mockCreate = vi.fn();
const mockPut = vi.fn();
const mockFinalize = vi.fn();
const mockGet = vi.fn();
const mockByClient = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    createImportSubmission: (...a: unknown[]) => mockCreate(...a),
    putImportSubmissionItems: (...a: unknown[]) => mockPut(...a),
    finalizeImportSubmission: (...a: unknown[]) => mockFinalize(...a),
    getImportSubmission: (...a: unknown[]) => mockGet(...a),
    getImportSubmissionByClientId: (...a: unknown[]) => mockByClient(...a),
  },
}));

const DIGEST = 'a'.repeat(64);
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

function renderStaged() {
  const params = {
    source: 'library' as const,
    acceptedVerb: 'registered',
    onCleanNavigate: vi.fn(),
    onDeselectAccepted: vi.fn(),
    captureHeld: vi.fn(),
    clearHeld: vi.fn(),
  };
  const view = renderHook(() => useStagedSubmission(params), { wrapper });
  return { ...view, params };
}

beforeEach(() => {
  // The active-transport supersession test queues `mockCreate.mockImplementationOnce(...)`, so
  // these API mocks MUST be reset (not merely cleared) between tests — `vi.clearAllMocks()` clears
  // call history but leaves an unconsumed `*Once()` implementation queued into the next test, per
  // the `vitest-clearallmocks-once-queue` learning. `mockReset()` drains the queue AND restores a
  // bare implementation; each test then re-establishes its own defaults. The digest mock is left
  // intact (it has no `*Once` queue and relies on its persistent pending-promise implementation).
  for (const m of [mockCreate, mockPut, mockFinalize, mockGet, mockByClient]) m.mockReset();
  digestResolvers.length = 0;
  localStorage.clear();
  __resetOutboxCache();
});

/** Wire run B's transport to land through finalize and then hold the poll at `processing`
 *  (so B's `finalized` hint persists in the outbox rather than being evicted on completion). */
function wireBProcessing(id: number): void {
  mockCreate.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: 1 }));
  mockPut.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: 1 }));
  mockFinalize.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1 }));
  mockGet.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1, processedCount: 0 }));
}

describe('useStagedSubmission — run supersession (F19)', () => {
  it('a run superseded during its digest starts no chain AND leaves the outbox owned by the newer run (F19/F23)', async () => {
    wireBProcessing(200);
    const { result } = renderStaged();

    // Run A (3 items) starts and blocks on its digest; run B (1 item) supersedes it.
    act(() => { result.current.submit([{ path: '/a1', title: 'A1' }, { path: '/a2', title: 'A2' }, { path: '/a3', title: 'A3' }], undefined); });
    act(() => { result.current.submit([{ path: '/b', title: 'B' }], undefined); });
    expect(digestResolvers).toHaveLength(2);

    // Resolve B first → B runs its pipeline to `finalized`. Then resolve A's (superseded) digest.
    await act(async () => { digestResolvers[1]!(DIGEST); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    // Exactly one create — run B (expectedCount 1); run A (expectedCount 3) never touched the network.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ expectedCount: 1 });
    // The single-slot outbox is OWNED by B — A's stale continuation did not overwrite the hint
    // (this deletion-tests the digest-continuation guard, which the create count alone cannot).
    const bClientId = (mockCreate.mock.calls[0]![0] as { clientSubmissionId: string }).clientSubmissionId;
    const hint = readOutbox('library');
    expect(hint).not.toBeNull();
    expect(hint).toMatchObject({ clientSubmissionId: bClientId, status: 'finalized', submissionId: 200 });
  });

  it('an unmount during the digest starts no create AND leaves NO outbox record (F19/F23)', async () => {
    const { result, unmount } = renderStaged();

    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    expect(digestResolvers).toHaveLength(1);

    // Unmount BEFORE the digest resolves; cleanup aborts the (already-created) controller.
    unmount();
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    // The digest continuation saw the aborted signal and bailed — no network chain, no hint
    // resurrected after cleanup (the create count alone would miss a post-unmount putOutbox).
    expect(mockCreate).not.toHaveBeenCalled();
    expect(readOutbox('library')).toBeNull();
  });

  it('a run superseded AFTER it has entered the transport pipeline cannot advance, publish, or own the hint/poll (F19/F24)', async () => {
    // Run A's create is held pending so A is genuinely IN create/PUT/finalize when B supersedes;
    // B then runs to `finalized`. Resolving A's create afterwards must not let A advance a stage,
    // rewrite the hint, or take poll ownership — the epoch/abort guards past `runPipeline` start.
    let resolveCreateA: (v: { id: number }) => void = () => {};
    mockCreate.mockImplementationOnce(() => new Promise<{ id: number }>((r) => { resolveCreateA = r; })); // run A
    mockCreate.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 })); // run B
    mockPut.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 }));
    mockFinalize.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'processing', expectedCount: 1 }));
    mockGet.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'processing', expectedCount: 1, processedCount: 0 }));

    const { result, params } = renderStaged();

    // Run A: submit → resolve its digest → A enters createStep and blocks on the pending create.
    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });
    expect(mockCreate).toHaveBeenCalledTimes(1); // A is mid-create

    // Run B supersedes (aborts A's controller, bumps the epoch), then runs to `finalized`.
    act(() => { result.current.submit([{ path: '/b', title: 'B' }], undefined); });
    await act(async () => { digestResolvers[1]!(DIGEST); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // Now let A's already-superseded create resolve; A must not proceed to PUT/finalize.
    await act(async () => { resolveCreateA({ id: 100 }); await Promise.resolve(); await Promise.resolve(); });

    // Both createStep calls ran (A entered create before supersession; B created).
    expect(mockCreate).toHaveBeenCalledTimes(2);
    // A never advanced: every PUT/finalize belongs to B's submission (id 200), never A's (id 100).
    expect(mockPut).toHaveBeenCalled();
    expect(mockPut.mock.calls.every((c) => c[0] === 200)).toBe(true);
    expect(mockFinalize.mock.calls.every((c) => c[0] === 200)).toBe(true);
    // The hint is owned by B; A did not rewrite it or start/complete a projection.
    const bClientId = (mockCreate.mock.calls[1]![0] as { clientSubmissionId: string }).clientSubmissionId;
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: bClientId, status: 'finalized', submissionId: 200 });
    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).not.toHaveBeenCalled();
  });
});
