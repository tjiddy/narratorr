import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useStagedSubmission } from './useStagedSubmission.js';
import { summaryResponse, detailResponse, acceptedRow } from './__tests__/staged-fixtures.js';
import { __resetOutboxCache, readOutbox } from './outbox.js';
import type { SubmissionAggregates } from '@/lib/api';

// Hold each digest until the test chooses which run resumes.
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

// Default to real UUID generation; the two-instance race overrides deterministic IDs.
const { clientIdMock } = vi.hoisted(() => ({ clientIdMock: vi.fn<() => string>() }));
vi.mock('./client-uuid.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client-uuid.js')>();
  clientIdMock.mockImplementation(() => actual.generateClientSubmissionId());
  return { ...actual, generateClientSubmissionId: () => clientIdMock() };
});

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
  // mockReset drains any unconsumed mockImplementationOnce queue from supersession tests.
  for (const m of [mockCreate, mockPut, mockFinalize, mockGet, mockByClient]) m.mockReset();
  digestResolvers.length = 0;
  localStorage.clear();
  __resetOutboxCache();
});

// Stop B at processing so its finalized outbox hint remains observable.
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

    act(() => { result.current.submit([{ path: '/a1', title: 'A1' }, { path: '/a2', title: 'A2' }, { path: '/a3', title: 'A3' }], undefined); });
    act(() => { result.current.submit([{ path: '/b', title: 'B' }], undefined); });
    expect(digestResolvers).toHaveLength(2);

    // Resume B before stale A.
    await act(async () => { digestResolvers[1]!(DIGEST); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ expectedCount: 1 });
    // The outbox assertion catches stale writes that the create count cannot.
    const bClientId = (mockCreate.mock.calls[0]![0] as { clientSubmissionId: string }).clientSubmissionId;
    const hint = readOutbox('library');
    expect(hint).not.toBeNull();
    expect(hint).toMatchObject({ clientSubmissionId: bClientId, status: 'finalized', submissionId: 200 });
  });

  it('an unmount during the digest starts no create AND leaves NO outbox record (F19/F23)', async () => {
    const { result, unmount } = renderStaged();

    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    expect(digestResolvers).toHaveLength(1);

    unmount();
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(readOutbox('library')).toBeNull();
  });

  it('a run superseded AFTER it has entered the transport pipeline cannot advance, publish, or own the hint/poll (F19/F24)', async () => {
    // Hold A's create, let B finalize, then release stale A.
    let resolveCreateA: (v: { id: number }) => void = () => {};
    mockCreate.mockImplementationOnce(() => new Promise<{ id: number }>((r) => { resolveCreateA = r; }));
    mockCreate.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 }));
    mockPut.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 }));
    mockFinalize.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'processing', expectedCount: 1 }));
    mockGet.mockResolvedValue(summaryResponse({ id: 200, source: 'library', status: 'processing', expectedCount: 1, processedCount: 0 }));

    const { result, params } = renderStaged();

    // Park A in create.
    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Let B finalize and claim the epoch.
    act(() => { result.current.submit([{ path: '/b', title: 'B' }], undefined); });
    await act(async () => { digestResolvers[1]!(DIGEST); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // Let A's already-superseded create resolve.
    await act(async () => { resolveCreateA({ id: 100 }); await Promise.resolve(); await Promise.resolve(); });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockPut).toHaveBeenCalled();
    expect(mockPut.mock.calls.every((c) => c[0] === 200)).toBe(true);
    expect(mockFinalize.mock.calls.every((c) => c[0] === 200)).toBe(true);
    const bClientId = (mockCreate.mock.calls[1]![0] as { clientSubmissionId: string }).clientSubmissionId;
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: bClientId, status: 'finalized', submissionId: 200 });
    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).not.toHaveBeenCalled();
  });
});

// Independent hooks share only the source-scoped outbox; client-ID guards protect its newest hint.
describe('useStagedSubmission — two independent instances (AC1 client, #1921)', () => {
  const CLIENT_1 = '11111111-1111-4111-8111-111111111111';
  const CLIENT_2 = '22222222-2222-4222-8222-222222222222';

  // Fixed microtask draining reaches finalized before the irrelevant poll timer can fire.
  async function drainMicrotasks(): Promise<void> {
    await act(async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); });
  }

  it('two instances hold distinct id/PUT/finalize chains; a late older-instance callback cannot rewrite the newer instance\'s outbox hint', async () => {
    clientIdMock.mockReturnValueOnce(CLIENT_1).mockReturnValueOnce(CLIENT_2);
    // Park both polls at processing so finalized hints remain observable.
    mockPut.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'receiving', expectedCount: 1 })));
    mockFinalize.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1 })));
    mockGet.mockImplementation((id: number) => Promise.resolve(summaryResponse({ id, source: 'library', status: 'processing', expectedCount: 1, processedCount: 0 })));
    // Hold instance 1's create until instance 2 owns the outbox.
    let resolveCreate1!: (v: ReturnType<typeof summaryResponse>) => void;
    mockCreate
      .mockImplementationOnce(() => new Promise<ReturnType<typeof summaryResponse>>((r) => { resolveCreate1 = r; }))
      .mockImplementationOnce(() => Promise.resolve(summaryResponse({ id: 200, source: 'library', status: 'receiving', expectedCount: 1 })));

    const inst1 = renderStaged();
    const inst2 = renderStaged();

    act(() => { inst1.result.current.submit([{ path: '/one', title: 'One' }], undefined); });
    act(() => { inst2.result.current.submit([{ path: '/two', title: 'Two' }], undefined); });
    expect(digestResolvers).toHaveLength(2);

    // Park instance 1 in create.
    await act(async () => { digestResolvers[0]!(DIGEST); });
    await drainMicrotasks();
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Let instance 2 finalize and claim the outbox.
    await act(async () => { digestResolvers[1]!(DIGEST); });
    await drainMicrotasks();
    const client1 = (mockCreate.mock.calls[0]![0] as { clientSubmissionId: string }).clientSubmissionId;
    const client2 = (mockCreate.mock.calls[1]![0] as { clientSubmissionId: string }).clientSubmissionId;
    expect(client1).toBe(CLIENT_1);
    expect(client2).toBe(CLIENT_2);
    expect(client1).not.toBe(client2);
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: CLIENT_2, status: 'finalized', submissionId: 200 });

    // Release instance 1 after its hint is stale.
    resolveCreate1(summaryResponse({ id: 100, source: 'library', status: 'receiving', expectedCount: 1 }));
    await drainMicrotasks();

    expect(mockCreate).toHaveBeenCalledTimes(2);
    // Each durable ID must retain its own item payload.
    const put100 = mockPut.mock.calls.find((c) => c[0] === 100)!;
    const put200 = mockPut.mock.calls.find((c) => c[0] === 200)!;
    expect(put100[1]).toMatchObject({ items: [{ ordinal: 0, item: { path: '/one', title: 'One' } }] });
    expect(put200[1]).toMatchObject({ items: [{ ordinal: 0, item: { path: '/two', title: 'Two' } }] });
    expect(mockFinalize.mock.calls.some((c) => c[0] === 100)).toBe(true);
    expect(mockFinalize.mock.calls.some((c) => c[0] === 200)).toBe(true);
    expect(readOutbox('library')).toMatchObject({ clientSubmissionId: CLIENT_2, status: 'finalized', submissionId: 200 });
  });
});

describe('useStagedSubmission — paused clean-completion policy (#1895)', () => {
  const cleanAgg = (accepted: number): SubmissionAggregates => ({ accepted, held: 0, skipped: 0, failed: 0 });

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

    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).toHaveBeenCalledTimes(1);
    expect([...params.onDeselectAccepted.mock.calls[0]![0]].sort()).toEqual(['/a', '/b']);
  });

  it.each([
    { initial: true, flipped: false, stays: true },
    { initial: false, flipped: true, stays: false },
  ])('F7: clean terminal follows the SUBMIT-TIME snapshot (initial=$initial), not a later flip to $flipped', async ({ initial, flipped, stays }) => {
    wireCleanTerminal(8, 1, { pruned: false });
    // Stable closure mirrors () => paused while the value changes mid-run.
    let stay = initial;
    const { result, params } = renderStay(() => stay);

    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
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

    act(() => { result.current.submit([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }], undefined); });
    expect(digestResolvers).toHaveLength(1);

    // Empty B fails before claiming an epoch or terminal-policy snapshot.
    stay = false;
    act(() => { result.current.submit([], undefined); });
    expect(digestResolvers).toHaveLength(1);

    await act(async () => { digestResolvers[0]!(DIGEST); });
    await settle();

    expect(params.onCleanNavigate).not.toHaveBeenCalled();
    expect(params.onDeselectAccepted).toHaveBeenCalledTimes(1);
    expect([...params.onDeselectAccepted.mock.calls[0]![0]].sort()).toEqual(['/a', '/b']);
  });
});
