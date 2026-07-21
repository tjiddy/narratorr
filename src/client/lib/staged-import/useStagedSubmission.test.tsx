import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useStagedSubmission } from './useStagedSubmission.js';
import { wireStagedComplete, acceptedRow, type StagedMockFns } from './__tests__/staged-fixtures.js';
import { __resetOutboxCache } from './outbox.js';

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

const stagedMocks: StagedMockFns = { create: mockCreate, put: mockPut, finalize: mockFinalize, get: mockGet, byClient: mockByClient };
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
  vi.clearAllMocks();
  digestResolvers.length = 0;
  localStorage.clear();
  __resetOutboxCache();
});

describe('useStagedSubmission — run supersession (F19)', () => {
  it('a run superseded during its digest starts NO network chain; only the newer run creates', async () => {
    wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/b', 'B')] });
    const { result } = renderStaged();

    // Run A (3 items) starts and blocks on its digest; run B (1 item) supersedes it.
    act(() => { result.current.submit([{ path: '/a1', title: 'A1' }, { path: '/a2', title: 'A2' }, { path: '/a3', title: 'A3' }], undefined); });
    act(() => { result.current.submit([{ path: '/b', title: 'B' }], undefined); });
    expect(digestResolvers).toHaveLength(2);

    // Resolve B first → B runs its pipeline. Then resolve A's (now superseded) digest.
    await act(async () => { digestResolvers[1]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    // Exactly one create — run B (expectedCount 1). Run A (expectedCount 3) never touched the network.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0]).toMatchObject({ expectedCount: 1 });
  });

  it('an unmount during the digest aborts the run — the continuation starts no create', async () => {
    const { result, unmount } = renderStaged();

    act(() => { result.current.submit([{ path: '/a', title: 'A' }], undefined); });
    expect(digestResolvers).toHaveLength(1);

    // Unmount BEFORE the digest resolves; cleanup aborts the (already-created) controller.
    unmount();
    await act(async () => { digestResolvers[0]!(DIGEST); await Promise.resolve(); await Promise.resolve(); });

    // The digest continuation saw the aborted signal and bailed — no network chain started.
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
