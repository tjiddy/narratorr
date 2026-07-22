import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useStagedSubmission } from './useStagedSubmission.js';
import { summaryResponse, detailResponse, acceptedRow } from './__tests__/staged-fixtures.js';
import { __resetOutboxCache, readOutbox } from './outbox.js';
import type { SubmissionAggregates } from '@/lib/api';

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

/**
 * Two INDEPENDENT hook instances racing before create (AC1 client, #1921). Each
 * `useStagedSubmission` instance owns its own epoch/abort refs, so neither supersedes the
 * other — both keep a live create/PUT/finalize chain under a DISTINCT `clientSubmissionId`.
 * The single-slot source-scoped outbox is the only shared surface: the newer instance's
 * create replaces the hint, and the older still-active instance's LATE finalize callback must
 * NOT rewrite it — the `expectedClientId` guard in `markOutboxFinalized` protects the newer
 * hint (outbox.ts:123-133). The client mocks the submissions API and cannot observe server
 * durability; durable-header discovery is proven by the linked real-DB test in
 * import-submission-report.service.integration.test.ts.
 */
describe('useStagedSubmission — two independent instances (AC1 client, #1921)', () => {
  it('two instances hold distinct id/PUT/finalize chains; a late older-instance callback cannot rewrite the newer instance\'s outbox hint', async () => {
    // Per-id PUT/finalize/poll wiring — each instance drives its OWN durable id and its poll
    // parks at `processing` (so a `finalized` hint is not evicted on completion).
    mockPut.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: 1 })));
    mockFinalize.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1 })));
    mockGet.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1, processedCount: 0 })));
    // Instance 1's create is HELD so its finalize (and its outbox mark) lands LATE, after
    // instance 2 has already run its whole chain and taken the hint. Instance 2's create is inline.
    let resolveCreate1!: (v: ReturnType<typeof summaryResponse>) => void;
    mockCreate
      .mockImplementationOnce(() => new Promise<ReturnType<typeof summaryResponse>>((r) => { resolveCreate1 = r; }))
      .mockImplementationOnce(() => Promise.resolve(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 })));

    const inst1 = renderStaged(); // older instance
    const inst2 = renderStaged(); // newer instance

    // Both instances submit (each mints a distinct clientSubmissionId); each blocks on its digest.
    act(() => { inst1.result.current.submit([{ path: '/one', title: 'One' }], undefined); });
    act(() => { inst2.result.current.submit([{ path: '/two', title: 'Two' }], undefined); });
    expect(digestResolvers).toHaveLength(2);

    // Instance 1 enters its pipeline first — writes its (submitting) outbox hint and PARKS on its held create.
    await act(async () => { digestResolvers[0]!(DIGEST); await new Promise((r) => setTimeout(r, 0)); });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Instance 2 runs its whole chain to `finalized` — it now OWNS the single-slot outbox hint.
    await act(async () => { digestResolvers[1]!(DIGEST); await new Promise((r) => setTimeout(r, 0)); });
    const client1 = (mockCreate.mock.calls[0]![0] as { clientSubmissionId: string }).clientSubmissionId;
    const client2 = (mockCreate.mock.calls[1]![0] as { clientSubmissionId: string }).clientSubmissionId;
    expect(client1).not.toBe(client2); // distinct durable identities → independent runs
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: client2, status: 'finalized', submissionId: 200 });

    // NOW instance 1's held create resolves LATE — it finishes PUT/finalize and calls
    // markOutboxFinalized(client1), which MUST be a no-op because the slot belongs to instance 2.
    await act(async () => { resolveCreate1(summaryResponse({ id: 100, source: 'library', status: 'receiving', expectedCount: 1 })); await new Promise((r) => setTimeout(r, 0)); });

    // Both instances drove an INDEPENDENT create/PUT/finalize chain over their own durable id.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockPut.mock.calls.some((c) => c[0] === 100)).toBe(true);
    expect(mockPut.mock.calls.some((c) => c[0] === 200)).toBe(true);
    expect(mockFinalize.mock.calls.some((c) => c[0] === 100)).toBe(true);
    expect(mockFinalize.mock.calls.some((c) => c[0] === 200)).toBe(true);
    // The hint STILL belongs to the newer instance — the late older-instance callback did not rewrite it.
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: client2, status: 'finalized', submissionId: 200 });
  });
});

/**
 * Paused clean-completion policy (#1895 F6/F7/F8/F11). `shouldStayOnClean` is snapshotted
 * per-run AFTER preflight (alongside the frozen submitted paths); a clean completion whose
 * snapshot is true STAYS on the page and deselects the frozen submitted survivors in place
 * (robust to a pruned aggregates-only terminal detail), instead of calling `onCleanNavigate`.
 */
describe('useStagedSubmission — paused clean-completion policy (#1895)', () => {
  const cleanAgg = (accepted: number): SubmissionAggregates => ({ accepted, held: 0, skipped: 0, failed: 0 });

  /** Wire a full submit that polls to a CLEAN `complete`; `pruned` drops the terminal item detail. */
  function wireCleanTerminal(id: number, accepted: number, { pruned = false } = {}): void {
    const agg = cleanAgg(accepted);
    mockCreate.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: accepted }));
    mockPut.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: accepted }));
    mockFinalize.mockResolvedValue(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: accepted, aggregates: agg }));
    mockGet.mockImplementation((_id: number, includeItems?: boolean) => {
      const base = { id, source: 'library' as const, status: 'complete' as const, expectedCount: accepted, processedCount: accepted, aggregates: agg, detailsPruned: pruned };
      if (includeItems && !pruned) {
        const items = Array.from({ length: accepted }, (_, i) => acceptedRow(i, `/p${i}`, `P${i}`));
        return Promise.resolve(detailResponse(items, base));
      }
      // Summary polls, and the terminal detail fetch when pruned (aggregates only, no items).
      return Promise.resolve(summaryResponse(base));
    });
  }

  function renderStay(shouldStayOnClean: () => boolean) {
    const params = {
      source: 'library' as const,
      acceptedVerb: 'registered',
      onCleanNavigate: vi.fn(),
      onDeselectAccepted: vi.fn(),
      captureHeld: vi.fn(),
      clearHeld: vi.fn(),
      shouldStayOnClean,
    };
    const view = renderHook(() => useStagedSubmission(params), { wrapper });
    return { ...view, params };
  }

  /** Drain the create→put→finalize→poll→terminal-detail→projectOutcome chain (real macrotask). */
  async function settle(): Promise<void> {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }

  it('F6: a PRUNED clean terminal (aggregates only, no items) + stay=true → no navigate, deselects EVERY frozen path', async () => {
    wireCleanTerminal(7, 2, { pruned: true });
    const { result, params } = renderStay(() => true);

    act(() => { result.current.submit([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }], undefined); });
    await act(async () => { digestResolvers[0]!(DIGEST); });
    await settle();

    // Proves the clean branch uses `submittedPathsRef` (frozen at submit), not the empty
    // item-derived set — the terminal had NO items to derive an accepted set from.
    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).toHaveBeenCalledTimes(1);
    expect([...params.onDeselectAccepted.mock.calls[0]![0]].sort()).toEqual(['/a', '/b']);
  });

  it.each([
    { initial: true, flipped: false, stays: true },
    { initial: false, flipped: true, stays: false },
  ])('F7: clean terminal follows the SUBMIT-TIME snapshot (initial=$initial), not a later flip to $flipped', async ({ initial, flipped, stays }) => {
    wireCleanTerminal(8, 1, { pruned: false });
    // A single stable closure reading a live `let` — mirrors `() => paused` where a mid-processing
    // `MatchEngine.resume()` clears `paused` synchronously AFTER the run was accepted.
    let stay = initial;
    const { result, params } = renderStay(() => stay);

    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    // Flip the live value BEFORE the terminal resolves (the digest is still pending).
    stay = flipped;
    await act(async () => { digestResolvers[0]!(DIGEST); });
    await settle();

    if (stays) {
      expect(params.onCleanNavigate).not.toHaveBeenCalled();
      expect(params.onDeselectAccepted).toHaveBeenCalledTimes(1);
      expect([...params.onDeselectAccepted.mock.calls[0]![0]].sort()).toEqual(['/a']);
    } else {
      expect(params.onCleanNavigate).toHaveBeenCalledTimes(1);
      expect(params.onDeselectAccepted).not.toHaveBeenCalled();
    }
  });

  it('F8/F11: a superseding submit that FAILS preflight cannot overwrite the active run\'s stay snapshot', async () => {
    wireCleanTerminal(9, 2, { pruned: false });
    let stay = true;
    const { result, params } = renderStay(() => stay);

    // Run A accepted while paused (stay=true) — snapshots true AFTER its preflight; still active
    // (digest pending, so it has NOT reached its terminal projection yet).
    act(() => { result.current.submit([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }], undefined); });
    expect(digestResolvers).toHaveLength(1);

    // Run B carries the OPPOSITE policy (stay=false) but is an explicit zero-survivors submit:
    // it fails preflight with zero classified local exclusions, so it returns BEFORE the
    // post-preflight snapshot line and BEFORE bumping the epoch — leaving A's ownership intact.
    stay = false;
    act(() => { result.current.submit([], undefined); });
    expect(digestResolvers).toHaveLength(1); // B never reached the digest — preflight rejected it

    // A's clean terminal now resolves: it must obey ITS OWN snapshot (stay) — a top-of-submit
    // snapshot bug would have let B's false clobber it and navigate instead.
    await act(async () => { digestResolvers[0]!(DIGEST); });
    await settle();

    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).toHaveBeenCalledTimes(1);
    expect([...params.onDeselectAccepted.mock.calls[0]![0]].sort()).toEqual(['/a', '/b']);
  });
});
