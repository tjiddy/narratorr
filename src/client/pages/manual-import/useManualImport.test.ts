import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useManualImport } from './useManualImport';
import { ApiError } from '@/lib/api';
import type { ScanResult, BookMetadata, MatchResult } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

// Preserve the real runtime exports (notably `ApiError`) and override only `api`. Replacing
// the barrel wholesale would drop ApiError (vimock-barrel-replace-drops-named-exports).
// The staged submit + poll pipeline (#1902) replaces the direct confirm.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    scanDirectory: vi.fn(),
    startMatchJob: vi.fn(),
    getMatchJob: vi.fn(),
    cancelMatchJob: vi.fn(),
    createImportSubmission: vi.fn(),
    putImportSubmissionItems: vi.fn(),
    finalizeImportSubmission: vi.fn(),
    getImportSubmission: vi.fn(),
    getImportSubmissionByClientId: vi.fn(),
  },
}));

// Deterministic engine clock (#1864 F12): the MatchEngine's poll timer is routed through
// `@/hooks/match-timer`; mocking it lets us advance polling without sleeping on real time
// (globally faking setTimeout would deadlock Query — vitest-faketimers-react-query).
vi.mock('@/hooks/match-timer', async () => {
  const { createMatchTimerMock } = await import('@/__tests__/match-timer-mock');
  return createMatchTimerMock();
});

import { api } from '@/lib/api';
import { toast } from 'sonner';
import * as matchTimer from '@/hooks/match-timer';
import type { MatchTimerMock } from '@/__tests__/match-timer-mock';
import { wireStagedComplete, acceptedRow, heldRow, skippedRow, failedRow, summaryResponse, detailResponse, type StagedMockFns } from '@/lib/staged-import/__tests__/staged-fixtures';
import { __resetOutboxCache, readOutbox, putOutbox } from '@/lib/staged-import/outbox';
import { STAGED_COPY } from '@/lib/staged-import/messages';
import { PREFLIGHT_COPY } from '@/lib/staged-import/preflight';

/** A wrapper whose QueryClient is spied so tests can observe invalidation timing (F8). */
function createSpyWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper, invalidateSpy };
}
/** The first segment of each invalidated query key, e.g. 'books' / 'importSubmissions'. */
const invalidatedRoots = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  spy.mock.calls.map((c: unknown[]) => ((c[0] as { queryKey?: unknown[] }).queryKey?.[0]) as string);

/** Adapter so the staged fixtures can drive the mocked `api` staged methods. */
const stagedMocks: StagedMockFns = {
  create: vi.mocked(api.createImportSubmission), put: vi.mocked(api.putImportSubmissionItems),
  finalize: vi.mocked(api.finalizeImportSubmission), get: vi.mocked(api.getImportSubmission),
  byClient: vi.mocked(api.getImportSubmissionByClientId),
};
/** A staged item as sent on the wire (loose shape for assertion convenience). */
type SubmittedItem = Record<string, unknown> & { metadata?: Record<string, unknown> };
/** The staged items actually PUT to the server, flattened across chunks. */
const submittedItems = (): SubmittedItem[] =>
  vi.mocked(api.putImportSubmissionItems).mock.calls.flatMap(c => (c[1] as { items: { ordinal: number; item: SubmittedItem }[] }).items.map(r => r.item));

const engineClock = matchTimer as unknown as MatchTimerMock;
/** Advance the engine by one poll interval (fires the single pending poll/retry). */
async function tickPoll(): Promise<void> {
  await act(async () => { engineClock.__flushNext(); });
}

// Reset the deterministic clock before every test (clearAllMocks doesn't touch its closure state).
beforeEach(() => { engineClock.__reset(); });

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

const SCAN_RESULT: ScanResult = {
  discoveries: [
    {
      path: '/audiobooks/Book A',
      parsedTitle: 'Book A',
      parsedAuthor: 'Author A',
      parsedSeries: null,
      fileCount: 3,
      totalSize: 1000,
      isDuplicate: false,
    },
    {
      path: '/audiobooks/Book B',
      parsedTitle: 'Book B',
      parsedAuthor: null,
      parsedSeries: 'Series B',
      fileCount: 1,
      totalSize: 500,
      isDuplicate: false,
    },
  ],
  totalFolders: 2,
};

const SCAN_RESULT_WITH_DUPLICATES: ScanResult = {
  discoveries: [
    {
      path: '/audiobooks/New Book',
      parsedTitle: 'New Book',
      parsedAuthor: 'Author A',
      parsedSeries: null,
      fileCount: 2,
      totalSize: 800,
      isDuplicate: false,
    },
    {
      path: '/audiobooks/Existing Book',
      parsedTitle: 'Existing Book',
      parsedAuthor: 'Author B',
      parsedSeries: null,
      fileCount: 1,
      totalSize: 500,
      isDuplicate: true,
      existingBookId: 42,
    },
    {
      path: '/audiobooks/Another Existing',
      parsedTitle: 'Another Existing',
      parsedAuthor: 'Author C',
      parsedSeries: null,
      fileCount: 3,
      totalSize: 1200,
      isDuplicate: true,
      existingBookId: 99,
    },
  ],
  totalFolders: 3,
};

const MATCH_METADATA: BookMetadata = {
  title: 'Book A (Official)',
  authors: [{ name: 'Author A Official' }],
  series: [{ name: 'Awesome Series', position: 1 }],
  coverUrl: 'https://example.com/cover.jpg',
  asin: 'B001TEST01',
};

describe('useManualImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: match job starts but no results yet
    vi.mocked(api.startMatchJob).mockResolvedValue({ jobId: 'job-123' });
    vi.mocked(api.getMatchJob).mockResolvedValue({
      id: 'job-123',
      status: 'matching',
      matched: 0,
      total: 2,
      results: [],
    });
    vi.mocked(api.cancelMatchJob).mockResolvedValue(undefined as never);
    // Staged pipeline (#1902): reset the source-scoped outbox hint and wire a clean
    // create→PUT→finalize→poll(complete)→detail chain for manual (mode copy). The poll's
    // first tick fires immediately, so a `complete` summary resolves via microtasks — no
    // fake timers needed. Tests that assert other outcomes re-wire.
    localStorage.clear();
    __resetOutboxCache();
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [acceptedRow(0, '/audiobooks/Book A', 'Book A'), acceptedRow(1, '/audiobooks/Book B', 'Book B')] });
  });

  it('starts at path step with empty state', () => {
    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    expect(result.current.state.step).toBe('path');
    expect(result.current.state.scanPath).toBe('');
    expect(result.current.state.rows).toEqual([]);
    expect(result.current.counts.selectedCount).toBe(0);
  });

  it('scan creates rows from discoveries and transitions to review step', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/audiobooks');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.step).toBe('review');
    });

    expect(result.current.state.rows).toHaveLength(2);
    expect(result.current.state.rows[0]!.selected).toBe(true);
    expect(result.current.state.rows[0]!.edited.title).toBe('Book A');
    expect(result.current.state.rows[0]!.edited.author).toBe('Author A');
    expect(result.current.state.rows[1]!.edited.title).toBe('Book B');
    expect(result.current.state.rows[1]!.edited.author).toBe('');
    expect(result.current.counts.selectedCount).toBe(2);
  });

  it('sets scanError when scan finds no discoveries', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [],
      totalFolders: 0,
    });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/empty');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.scanError).toBeTruthy();
    });

    expect(result.current.state.step).toBe('path'); // stays on path step
  });

  it('goes to review step when all discoveries are duplicates (users can force-import)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [
        {
          path: '/audiobooks/Dup',
          parsedTitle: 'Dup',
          parsedAuthor: 'Author',
          parsedSeries: null,
          fileCount: 1,
          totalSize: 100,
          isDuplicate: true,
          existingBookId: 1,
        },
      ],
      totalFolders: 1,
    });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/dupes');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.step).toBe('review');
    });
    expect(result.current.state.rows).toHaveLength(1);
    expect(result.current.state.rows[0]!.book.isDuplicate).toBe(true);
    // No match job started when all books are duplicates — empty candidates list guard
    expect(vi.mocked(api.startMatchJob)).not.toHaveBeenCalled();
  });

  it('sets scanError when scan API rejects', async () => {
    vi.mocked(api.scanDirectory).mockRejectedValue(new Error('Permission denied'));

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/noaccess');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.scanError).toBe('Permission denied');
    });
  });

  it('calls onScanSuccess with the trimmed scan path when scan returns discoveries', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    const onScanSuccess = vi.fn();

    const { result } = renderHook(() => useManualImport({ onScanSuccess }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('  /audiobooks  ');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.step).toBe('review');
    });

    expect(onScanSuccess).toHaveBeenCalledWith('/audiobooks');
    expect(onScanSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not call onScanSuccess when scan returns zero discoveries', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [],
      totalFolders: 0,
    });
    const onScanSuccess = vi.fn();

    const { result } = renderHook(() => useManualImport({ onScanSuccess }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/empty');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.scanError).toBeTruthy();
    });

    expect(onScanSuccess).not.toHaveBeenCalled();
  });

  it('does not call onScanSuccess when scan API rejects', async () => {
    vi.mocked(api.scanDirectory).mockRejectedValue(new Error('Permission denied'));
    const onScanSuccess = vi.fn();

    const { result } = renderHook(() => useManualImport({ onScanSuccess }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.state.setScanPath('/noaccess');
    });

    await act(async () => {
      result.current.actions.handleScan();
    });

    await waitFor(() => {
      expect(result.current.state.scanError).toBe('Permission denied');
    });

    expect(onScanSuccess).not.toHaveBeenCalled();
  });

  it('does not scan when path is empty', async () => {
    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.actions.handleScan();
    });

    expect(api.scanDirectory).not.toHaveBeenCalled();
  });

  it('handleToggle toggles row selection', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    act(() => {
      result.current.actions.handleToggle(0);
    });

    expect(result.current.state.rows[0]!.selected).toBe(false);
    expect(result.current.state.rows[1]!.selected).toBe(true);
    expect(result.current.counts.selectedCount).toBe(1);
  });

  it('handleToggleAll selects/deselects all rows', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    // All selected → deselect all
    act(() => {
      result.current.actions.handleToggleAll();
    });
    expect(result.current.counts.allSelected).toBe(false);
    expect(result.current.counts.selectedCount).toBe(0);

    // All deselected → select all
    act(() => {
      result.current.actions.handleToggleAll();
    });
    expect(result.current.counts.allSelected).toBe(true);
    expect(result.current.counts.selectedCount).toBe(2);
  });

  it('select-all then import sends forceImport: true for duplicate rows (intended behavior per spec)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

    // Select all rows including duplicates
    act(() => { result.current.actions.handleToggleAll(); });
    expect(result.current.counts.allSelected).toBe(true);
    expect(result.current.counts.selectedCount).toBe(3);

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(vi.mocked(api.createImportSubmission)).toHaveBeenCalled(); });

    const books = submittedItems();
    const dupItems = books.filter(b =>
      SCAN_RESULT_WITH_DUPLICATES.discoveries.find(d => d.path === b.path && d.isDuplicate),
    );
    // All selected duplicate rows must have forceImport: true
    expect(dupItems).toHaveLength(2);
    expect(dupItems.every(b => b.forceImport === true)).toBe(true);
  });

  it('handleEdit updates row edited state', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Edited Title',
        author: 'Edited Author',
        series: 'Edited Series',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.state.rows[0]!.edited.title).toBe('Edited Title');
    expect(result.current.state.rows[0]!.edited.author).toBe('Edited Author');
    expect(result.current.state.rows[0]!.edited.metadata).toBe(MATCH_METADATA);
  });

  it('handleImport sends selected rows to API and navigates on success', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => {
      result.current.actions.handleImport();
    });

    await waitFor(() => {
      expect(api.createImportSubmission).toHaveBeenCalled();
    });

    const items = submittedItems();
    const mode = (vi.mocked(api.createImportSubmission).mock.calls[0]![0] as { mode?: string }).mode;
    expect(items).toHaveLength(2);
    // Payload is built by the shared toConfirmItem builder (#1765): optional fields
    // carry through and a non-duplicate row omits forceImport (force=false).
    expect(items[0]!.path).toBe('/audiobooks/Book A');
    expect(items[0]!.title).toBe('Book A');
    expect(items[0]!.authorName).toBe('Author A');
    expect(items[0]!.forceImport).toBeUndefined();
    expect(mode).toBe('copy');

    expect(toast.success).toHaveBeenCalledWith('2 books queued for import');
    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  it('surfaces held-review items as recoverable state instead of navigating away (#1732)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, {
      source: 'manual', mode: 'copy',
      items: [acceptedRow(0, '/audiobooks/Book B', 'Book B'), heldRow(1, '/audiobooks/Book A', 'Book A')],
    });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

    // Held items populate recoverable state and are surfaced via a warning toast...
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });
    expect(result.current.state.heldReview[0]!.path).toBe('/audiobooks/Book A');
    expect(toast.warning).toHaveBeenCalledWith('1 held for recording review');
    // ...a held outcome is no longer a green success (#1822): the accepted item queued
    // but the batch is not fully clean, so no green toast fires...
    expect(toast.success).not.toHaveBeenCalled();
    // ...and the user is NOT navigated away (the old dead-end behavior).
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('handleReconfirmHeld re-submits held rows with forceImport and the snapshot mode (#1732)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'move', items: [heldRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    act(() => { result.current.state.setMode('move'); });
    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });

    // Re-confirm creates a FRESH staged submission carrying force + the snapshot mode.
    vi.mocked(api.putImportSubmissionItems).mockClear();
    vi.mocked(api.createImportSubmission).mockClear();
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'move', items: [acceptedRow(0, '/audiobooks/Book A', 'Book A')] });
    await act(async () => { result.current.actions.handleReconfirmHeld(); });

    await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });
    const items = submittedItems();
    expect(items).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/audiobooks/Book A', forceImport: true })]),
    );
    // Items carry no per-item mode key — mode is on the create body.
    expect(items[0]).not.toHaveProperty('mode');
    expect((vi.mocked(api.createImportSubmission).mock.calls[0]![0] as { mode?: string }).mode).toBe('move');
  });

  it('re-confirm uses the mode snapshotted at confirm time, not a later selector change (#1732)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'move', items: [heldRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    // Import with mode 'move', receive held rows...
    act(() => { result.current.state.setMode('move'); });
    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });

    // ...then flip the still-editable selector to 'copy' and re-confirm.
    vi.mocked(api.createImportSubmission).mockClear();
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'move', items: [acceptedRow(0, '/audiobooks/Book A', 'Book A')] });
    act(() => { result.current.state.setMode('copy'); });
    await act(async () => { result.current.actions.handleReconfirmHeld(); });

    await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });
    // The snapshot wins: re-confirm still uses 'move', not the live 'copy' selector.
    expect((vi.mocked(api.createImportSubmission).mock.calls[0]![0] as { mode?: string }).mode).toBe('move');
  });

  it('clears the held panel after a fully-accepted re-confirm (mixed success) (#1732)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [heldRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });

    // The fresh (empty) heldReview from a clean re-confirm clears the panel.
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [acceptedRow(0, '/audiobooks/Book A', 'Book A')] });
    await act(async () => { result.current.actions.handleReconfirmHeld(); });

    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(0); });
    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  it('clears held state when the user backs out of review (#1732)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [heldRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });

    act(() => { result.current.actions.handleBack(); });

    expect(result.current.state.heldReview).toHaveLength(0);
    expect(result.current.state.step).toBe('path');
  });

  it('all-skipped batch shows amber (no green, no navigate) (#1822)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, {
      source: 'manual', mode: 'copy',
      items: [skippedRow(0, '/audiobooks/Book A', 'Book A'), skippedRow(1, '/audiobooks/Book B', 'Book B')],
    });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(toast.warning).toHaveBeenCalledWith('2 already in your library'); });

    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('single-skip batch reads amber and stays in place (#1822)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [skippedRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(toast.warning).toHaveBeenCalledWith('1 already in your library'); });

    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('all-failed batch shows red (no green, no navigate) (#1822)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [failedRow(0, '/audiobooks/Book A', 'Book A')] });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(toast.error).toHaveBeenCalledWith('1 failed'); });

    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('held + failed batch surfaces the failure (regression pin for the early-return swallow) (#1822)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, {
      source: 'manual', mode: 'copy',
      items: [heldRow(0, '/audiobooks/Book A', 'Book A'), failedRow(1, '/audiobooks/Book B', 'Book B')],
    });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

    // Held is surfaced via its panel/warning AND the failure is still shown — not
    // swallowed by an early return.
    await waitFor(() => { expect(result.current.state.heldReview).toHaveLength(1); });
    expect(toast.warning).toHaveBeenCalledWith('1 held for recording review');
    expect(toast.error).toHaveBeenCalledWith('1 failed');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('partial success (accepted + skipped) stays on the page and deselects the accepted rows (#1822)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, {
      source: 'manual', mode: 'copy',
      items: [acceptedRow(0, '/audiobooks/Book A', 'Book A'), skippedRow(1, '/audiobooks/Book B', 'Book B')],
    });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });
    // Both rows start selected (non-duplicate).
    expect(result.current.counts.selectedCount).toBe(2);

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

    expect(toast.warning).toHaveBeenCalledWith('1 queued for import · 1 already in your library');
    expect(mockNavigate).not.toHaveBeenCalled();
    // The accepted row (Book A) is deselected so a re-submit can't re-send it; the
    // skipped row (Book B) is left as-is.
    await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.selected).toBe(false));
  });

  it('a create failure surfaces a recoverable banner and does not navigate (F9)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    // A non-retryable typed 4xx fails fast (no backoff) and surfaces its banner.
    vi.mocked(api.createImportSubmission).mockRejectedValue(new ApiError(400, { error: 'invalid-body' }));

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => { expect(result.current.state.banner).toBeTruthy(); });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a permanent PUT failure stops the upload, keeps rows selected, does not finalize (F10)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    vi.mocked(api.putImportSubmissionItems).mockRejectedValue(new ApiError(409, { error: 'submission-not-receiving' }));

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => { expect(result.current.state.banner).toBeTruthy(); });
    expect(api.finalizeImportSubmission).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.selected).toBe(true);
  });

  it('an all-oversize selection is refused pre-create with the too-large banner, row stays selected (F17/F39)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/Book A', parsedTitle: 'Book A', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(1); });

    // A metadata author name over the 512-char bound is a pure `too_big` exclusion → oversize.
    const oversizeMeta = { title: 'Book A', authors: [{ name: 'x'.repeat(513) }] } as unknown as BookMetadata;
    act(() => { result.current.actions.handleEdit(0, { title: 'Book A', author: 'Author A', series: '', metadata: oversizeMeta }); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toMatch(/too large/i));
    // No submission leaves the client, and nothing navigates.
    expect(api.createImportSubmission).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The oversize row stays selected (fail-open — nothing landed).
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.selected).toBe(true);
  });

  // ── Zero-survivor category mixes through the submit hook (F14/F39) ────────────
  const INVALID_META = { title: 'X', authors: [{ name: 'A' }], bogusUnknownKey: 1 } as unknown as BookMetadata; // unknown key → invalid
  const OVERSIZE_META = { title: 'X', authors: [{ name: 'x'.repeat(513) }] } as unknown as BookMetadata; // too_big → oversize

  async function scanTwo() {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });
    return result;
  }

  it('all-invalid zero-survivor: no create/hint/digest, rows stay selected, truthful invalid count (F14/F39)', async () => {
    const result = await scanTwo();
    act(() => { result.current.actions.handleEdit(0, { title: 'Book A', author: 'A', series: '', metadata: INVALID_META }); });
    act(() => { result.current.actions.handleEdit(1, { title: 'Book B', author: 'B', series: '', metadata: INVALID_META }); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toMatch(/couldn.t be prepared/i));
    expect(result.current.state.banner).toContain('2'); // truthful invalid count
    expect(api.createImportSubmission).not.toHaveBeenCalled();
    expect(api.putImportSubmissionItems).not.toHaveBeenCalled();
    expect(readOutbox('manual')).toBeNull(); // no hint stored
    expect(result.current.state.rows.every(r => r.selected)).toBe(true); // selection unchanged
  });

  it('mixed invalid + oversize with no valid row: no create/hint, BOTH counts truthful, selection unchanged (F14/F39)', async () => {
    const result = await scanTwo();
    act(() => { result.current.actions.handleEdit(0, { title: 'Book A', author: 'A', series: '', metadata: INVALID_META }); });
    act(() => { result.current.actions.handleEdit(1, { title: 'Book B', author: 'B', series: '', metadata: OVERSIZE_META }); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toMatch(/couldn.t be prepared/i));
    expect(result.current.state.banner).toMatch(/too large/i); // both categories named
    expect(api.createImportSubmission).not.toHaveBeenCalled();
    expect(readOutbox('manual')).toBeNull();
    expect(result.current.state.rows.every(r => r.selected)).toBe(true);
  });

  // ── Cache invalidation timing (F8) ────────────────────────────────────────────
  it('a clean completion invalidates books AND import-report reads, with books BEFORE navigation (F8)', async () => {
    const { wrapper, invalidateSpy } = createSpyWrapper();
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [acceptedRow(0, '/audiobooks/Book A', 'Book A'), acceptedRow(1, '/audiobooks/Book B', 'Book B')] });
    const { result } = renderHook(() => useManualImport(), { wrapper });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'));

    const roots = invalidatedRoots(invalidateSpy);
    expect(roots).toContain('books');
    expect(roots).toContain('importSubmissions');
    // books() invalidation runs before the /library navigation so the list isn't stale.
    const booksIdx = invalidateSpy.mock.calls.findIndex((c) => (c[0] as { queryKey?: unknown[] }).queryKey?.[0] === 'books');
    expect(invalidateSpy.mock.invocationCallOrder[booksIdx]!).toBeLessThan(mockNavigate.mock.invocationCallOrder[0]!);
  });

  it('a create failure does NOT invalidate books (F8)', async () => {
    const { wrapper, invalidateSpy } = createSpyWrapper();
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    vi.mocked(api.createImportSubmission).mockRejectedValue(new ApiError(400, { error: 'invalid-body' }));
    const { result } = renderHook(() => useManualImport(), { wrapper });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => expect(result.current.state.banner).toBeTruthy());

    expect(invalidatedRoots(invalidateSpy)).not.toContain('books');
  });

  it('create invalidates import-report reads but NOT books until a successful terminal detail (F8)', async () => {
    const { wrapper, invalidateSpy } = createSpyWrapper();
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    // create/PUT/finalize resolve, then the poll stays processing (no terminal detail yet).
    vi.mocked(api.createImportSubmission).mockResolvedValue(summaryResponse({ id: 3, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.putImportSubmissionItems).mockResolvedValue(summaryResponse({ id: 3, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.finalizeImportSubmission).mockResolvedValue(summaryResponse({ id: 3, source: 'manual', mode: 'copy', status: 'processing', expectedCount: 2 }));
    vi.mocked(api.getImportSubmission).mockResolvedValue(summaryResponse({ id: 3, source: 'manual', mode: 'copy', status: 'processing', expectedCount: 2, processedCount: 1 }));
    const { result } = renderHook(() => useManualImport(), { wrapper });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => expect(invalidatedRoots(invalidateSpy)).toContain('importSubmissions'));

    expect(invalidatedRoots(invalidateSpy)).not.toContain('books'); // no terminal detail → no books refresh
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ── Distinct permanent-failure dispositions (F7) ──────────────────────────────
  it('a permanent PUT failure shows the distinct upload-failure copy and RETAINS the hint (F7)', async () => {
    const result = await scanTwo();
    vi.mocked(api.putImportSubmissionItems).mockRejectedValue(new ApiError(409, { error: 'submission-not-receiving' }));
    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toBe(STAGED_COPY.putFailed));
    expect(result.current.state.banner).not.toBe(STAGED_COPY.createUnreachable); // NOT connectivity copy
    expect(api.finalizeImportSubmission).not.toHaveBeenCalled();
    expect(readOutbox('manual')).not.toBeNull(); // receiving hint left for reconcile
  });

  it('an invalid-body create shows the validation copy and EVICTS the hint (F7)', async () => {
    const result = await scanTwo();
    vi.mocked(api.createImportSubmission).mockRejectedValue(new ApiError(400, { error: 'invalid-body' }));
    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toBe(STAGED_COPY.createInvalid));
    expect(readOutbox('manual')).toBeNull();
  });

  it('a finalize 409 (gaps/digest-mismatch) shows the finalization-failure copy and EVICTS (F7)', async () => {
    const result = await scanTwo();
    vi.mocked(api.createImportSubmission).mockResolvedValue(summaryResponse({ id: 4, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.putImportSubmissionItems).mockResolvedValue(summaryResponse({ id: 4, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.finalizeImportSubmission).mockRejectedValue(new ApiError(409, { error: 'finalize-gaps' }));
    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toBe(STAGED_COPY.finalizeFailed));
    expect(readOutbox('manual')).toBeNull();
  });

  // ── Recovered-on-remount projections are read-only / non-navigating (F4/F5) ───
  const RECOVER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const RECOVER_DIGEST = 'b'.repeat(64);

  it('a completion recovered on remount keeps held detail READ-ONLY (no live re-confirm) (F5)', async () => {
    putOutbox({ version: 1, clientSubmissionId: RECOVER_UUID, source: 'manual', status: 'finalized', payloadDigest: RECOVER_DIGEST, expectedCount: 1, submissionId: 7 });
    vi.mocked(api.getImportSubmissionByClientId).mockResolvedValue(summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } }));
    vi.mocked(api.getImportSubmission).mockImplementation((_id: number, includeItems?: boolean) =>
      Promise.resolve(includeItems
        ? detailResponse([heldRow(0, '/audiobooks/Held', 'Held Book')], { id: 7, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } })
        : summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } })) as never);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('1 held for recording review'));
    expect(result.current.state.heldReview).toHaveLength(0); // NOT captured into the live actionable panel
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a clean completion recovered on remount surfaces in place and NEVER navigates (F4)', async () => {
    putOutbox({ version: 1, clientSubmissionId: RECOVER_UUID, source: 'manual', status: 'finalized', payloadDigest: RECOVER_DIGEST, expectedCount: 1, submissionId: 8 });
    vi.mocked(api.getImportSubmissionByClientId).mockResolvedValue(summaryResponse({ id: 8, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 1, held: 0, skipped: 0, failed: 0 } }));
    vi.mocked(api.getImportSubmission).mockImplementation((_id: number, includeItems?: boolean) =>
      Promise.resolve(includeItems
        ? detailResponse([acceptedRow(0, '/audiobooks/Book A', 'Book A')], { id: 8, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 1, held: 0, skipped: 0, failed: 0 } })
        : summaryResponse({ id: 8, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 1, aggregates: { accepted: 1, held: 0, skipped: 0, failed: 0 } })) as never);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });

    // A clean IN-SESSION completion would navigate; a recovered one must NOT (it only surfaces).
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('1 book queued for import'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(result.current.state.step).not.toBe('review'); // stayed on its recovered mount, no scan
  });

  // ── Post-prune-safe outcome projection (F6/F29) ───────────────────────────────
  it('a mixed completion pruned before detail stays count-driven non-green with held actions unavailable (F6/F29)', async () => {
    const result = await scanTwo();
    // A pruned record's detail fetch carries NO items; severity must fall back to COUNTS:
    // accepted+held+skipped+failed with failed>0 ⇒ error (never green), and the actionable
    // held panel is not populated because the per-row detail is gone.
    const agg = { accepted: 1, held: 1, skipped: 1, failed: 1 };
    const pruned = summaryResponse({ id: 11, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 4, aggregates: agg, detailsPruned: true, processedCount: 4 });
    vi.mocked(api.createImportSubmission).mockResolvedValue(summaryResponse({ id: 11, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 4 }));
    vi.mocked(api.putImportSubmissionItems).mockResolvedValue(summaryResponse({ id: 11, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 4 }));
    vi.mocked(api.finalizeImportSubmission).mockResolvedValue(summaryResponse({ id: 11, source: 'manual', mode: 'copy', status: 'processing', expectedCount: 4 }));
    vi.mocked(api.getImportSubmission).mockResolvedValue(pruned); // both summary + detail arms → pruned summary

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(toast.error).toHaveBeenCalled()); // failed>0 ⇒ error severity
    expect(toast.success).not.toHaveBeenCalled(); // never a false green post-prune
    expect(result.current.state.heldReview).toHaveLength(0); // detail pruned ⇒ no live held actions
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // ── Finalize exhaustion recovers in-session via by-client (F2) ────────────────
  it('finalize exhaustion probes by-client in-session and rejoins the poll to surface completion (F2)', async () => {
    const result = await scanTwo();
    // create/PUT resolve; finalize 5xx EXHAUSTS → finalize-unreachable. The header actually
    // landed, so the in-session by-client probe finds it complete and the rejoined poll surfaces
    // the outcome — rather than parking behind a banner until a future remount.
    const agg = { accepted: 2, held: 0, skipped: 0, failed: 0 };
    vi.mocked(api.createImportSubmission).mockResolvedValue(summaryResponse({ id: 9, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.putImportSubmissionItems).mockResolvedValue(summaryResponse({ id: 9, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
    vi.mocked(api.finalizeImportSubmission).mockRejectedValue(new ApiError(503, { error: 'x' }));
    vi.mocked(api.getImportSubmissionByClientId).mockResolvedValue(summaryResponse({ id: 9, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 2, aggregates: agg }));
    vi.mocked(api.getImportSubmission).mockImplementation((_id: number, incl?: boolean) =>
      Promise.resolve(incl
        ? detailResponse([acceptedRow(0, '/audiobooks/Book A', 'Book A'), acceptedRow(1, '/audiobooks/Book B', 'Book B')], { id: 9, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 2, aggregates: agg })
        : summaryResponse({ id: 9, source: 'manual', mode: 'copy', status: 'complete', expectedCount: 2, aggregates: agg })) as never);

    await act(async () => { result.current.actions.handleImport(); });

    // The by-client probe is the in-session recovery (not a passive banner); the rejoined
    // poll then reaches the clean completion and navigates. (Real finalize backoff runs here.)
    await waitFor(() => expect(api.getImportSubmissionByClientId).toHaveBeenCalled(), { timeout: 12_000 });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'), { timeout: 12_000 });
  }, 15_000);

  // ── Cumulative byte-budget refusal through the submit hook (F13) ───────────────
  it('a cumulative byte-budget overflow is refused pre-create — no create/hint, rows stay selected (F13/F30)', async () => {
    // Each item is a valid survivor just under the per-item ceiling; together they exceed the
    // 64 MiB cumulative cap, so the byte-budget gate refuses the whole batch before any create.
    const perItem = 920_000; // < MAX_SINGLE_ITEM_BYTES (900 KiB) → survives classification
    const count = 74; // 74 × 920,000 ≈ 68 MiB > 64 MiB cap
    const discoveries = Array.from({ length: count }, (_, i) => ({
      path: `/audiobooks/B${i}`, parsedTitle: 'x'.repeat(perItem), parsedAuthor: 'A', parsedSeries: null,
      fileCount: 1, totalSize: 1, isDuplicate: false,
    }));
    vi.mocked(api.scanDirectory).mockResolvedValue({ discoveries, totalFolders: count } as unknown as ScanResult);
    // Leave the match job in the default 'matching' state (never flushed) so the rows stay
    // selected/pending — this test is about the byte gate, not match-driven deselection.

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(count); });
    // Force every row selected (Select-all when not all-selected) so the whole batch is submitted.
    if (!result.current.state.rows.every(r => r.selected)) {
      act(() => { result.current.actions.handleToggleAll(); });
    }
    await waitFor(() => { expect(result.current.counts.selectedCount).toBe(count); });

    await act(async () => { result.current.actions.handleImport(); });

    await waitFor(() => expect(result.current.state.banner).toBe(PREFLIGHT_COPY.byteBudget));
    expect(api.createImportSubmission).not.toHaveBeenCalled();
    expect(api.putImportSubmissionItems).not.toHaveBeenCalled();
    expect(readOutbox('manual')).toBeNull(); // no hint stored
    expect(result.current.state.rows.every(r => r.selected)).toBe(true); // selection unchanged
  }, 20_000);

  it('handleBack from review resets to path step', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.step).toBe('review'); });

    act(() => {
      result.current.actions.handleBack();
    });

    expect(result.current.state.step).toBe('path');
    expect(result.current.state.rows).toEqual([]);
  });

  it('handleBack from path navigates to library', () => {
    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.actions.handleBack();
    });

    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  describe('narrator persistence through edit flow', () => {
    it('handleEdit with metadata.narrators persists narrators in row edited state', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
      });

      expect(result.current.state.rows[0]!.edited.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards metadata.narrators to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
        // deselect row 1 to simplify assertion
        result.current.actions.handleToggle(1);
      });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]!.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards coverUrl to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          coverUrl: 'https://example.com/new-cover.jpg',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'], coverUrl: 'https://example.com/new-cover.jpg' },
        });
        result.current.actions.handleToggle(1);
      });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]!.coverUrl).toBe('https://example.com/new-cover.jpg');
      expect(items[0]!.metadata?.coverUrl).toBe('https://example.com/new-cover.jpg');
    });

    it('editing title only does not discard narrator from existing edited.metadata', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // First edit: set metadata with narrators
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
      });

      // Second edit: change only the title, keep same metadata
      act(() => {
        const prevMetadata = result.current.state.rows[0]!.edited.metadata;
        result.current.actions.handleEdit(0, {
          title: 'Book A (Updated)',
          author: 'Author A',
          series: '',
          ...(prevMetadata !== undefined && { metadata: prevMetadata }),
        });
      });

      expect(result.current.state.rows[0]!.edited.title).toBe('Book A (Updated)');
      expect(result.current.state.rows[0]!.edited.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport forwards edited.narrators and seriesPosition (#1028)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: 'Discworld',
          narrators: ['Jim Dale'],
          seriesPosition: 27,
        });
        result.current.actions.handleToggle(1);
      });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]!.narrators).toEqual(['Jim Dale']);
      expect(items[0]!.seriesPosition).toBe(27);
    });

    it('parser-seeded parsedSeriesPosition flows from scan to import payload (#1042)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/Author/Series/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: 'Series', parsedSeriesPosition: 2.5, fileCount: 1, totalSize: 1000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(1); });

      expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(2.5);

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]!.seriesPosition).toBe(2.5);
    });

    // #1849 — the parsed series position (including 0) must reach the match-start
    // candidate so the server-side position tiebreaker can run.
    it('threads parsedSeriesPosition (including 0) into the match candidate', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/Fablehaven/01', parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: 'Fablehaven', parsedSeriesPosition: 1, fileCount: 1, totalSize: 100, isDuplicate: false },
          { path: '/audiobooks/Fablehaven/00', parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: 'Fablehaven', parsedSeriesPosition: 0, fileCount: 1, totalSize: 100, isDuplicate: false },
          { path: '/audiobooks/Standalone', parsedTitle: 'Standalone', parsedAuthor: 'Someone', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
        ],
        totalFolders: 3,
      });
      vi.mocked(api.startMatchJob).mockClear().mockResolvedValue({ jobId: 'job-123' });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(api.startMatchJob).toHaveBeenCalled(); });

      const candidates = vi.mocked(api.startMatchJob).mock.calls[0]![0];
      const byPath = (p: string) => candidates.find(c => c.path === p);
      expect(byPath('/audiobooks/Fablehaven/01')?.seriesPosition).toBe(1);
      expect(byPath('/audiobooks/Fablehaven/00')?.seriesPosition).toBe(0);
      expect(byPath('/audiobooks/Standalone')).not.toHaveProperty('seriesPosition');
    });

    it('parser-seeded parsedSeriesPosition survives a no-position best match merge (#1042)', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue({
          discoveries: [
            { path: '/audiobooks/Author/Series/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: 'Series', parsedSeriesPosition: 3, fileCount: 1, totalSize: 1000, isDuplicate: false },
          ],
          totalFolders: 1,
        });
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-1',
          status: 'completed',
          total: 1,
          matched: 1,
          results: [
            {
              path: '/audiobooks/Author/Series/Book',
              confidence: 'high',
              bestMatch: { title: 'Book', authors: [{ name: 'Author' }], series: [{ name: 'Series' }] },
              alternatives: [],
            },
          ],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(1); });

        await tickPoll();

        expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(3);

        await act(async () => { result.current.actions.handleImport(); });
        await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

        const items = submittedItems();
        expect(items[0]!.seriesPosition).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('handleImport forwards seriesPosition: 0 (regression guard against falsy drop) (#1028)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: 'Series',
          seriesPosition: 0,
        });
        result.current.actions.handleToggle(1);
      });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]!.seriesPosition).toBe(0);
    });

    it('handleImport does not forward narrators when empty array (#1028)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          narrators: [],
        });
        result.current.actions.handleToggle(1);
      });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(api.createImportSubmission).toHaveBeenCalled(); });

      const items = submittedItems();
      expect(items[0]).not.toHaveProperty('narrators');
    });

    it('mergeMatchResults seeds edited narrators and seriesPosition from bestMatch (#1028)', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123',
          status: 'completed',
          matched: 1,
          total: 2,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'high',
            bestMatch: {
              title: 'Book A',
              authors: [{ name: 'Author A' }],
              narrators: ['Jim Dale'],
              series: [{ name: 'Discworld', position: 27 }],
            },
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();

        expect(result.current.state.rows[0]!.edited.narrators).toEqual(['Jim Dale']);
        expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(27);
      } finally {
        vi.useRealTimers();
      }
    });

    it('mergeMatchResults preserves seriesPosition: 0 (falsy regression at merge boundary) (#1028)', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123',
          status: 'completed',
          matched: 1,
          total: 2,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'high',
            bestMatch: {
              title: 'Book A',
              authors: [{ name: 'Author A' }],
              series: [{ name: 'Prequels', position: 0 }],
            },
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();

        expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('mergeMatchResults omits narrators/seriesPosition when bestMatch lacks them (#1028)', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123',
          status: 'completed',
          matched: 1,
          total: 2,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'high',
            bestMatch: {
              title: 'Book A',
              authors: [{ name: 'Author A' }],
            },
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();

        expect(result.current.state.rows[0]!.edited).not.toHaveProperty('narrators');
        expect(result.current.state.rows[0]!.edited).not.toHaveProperty('seriesPosition');
      } finally {
        vi.useRealTimers();
      }
    });

    it('mergeMatchResults seeds edited.metadata.narrators from bestMatch.narrators on first arrival', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123',
          status: 'completed',
          matched: 1,
          total: 2,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'high',
            bestMatch: { title: 'Book A (Official)', authors: [{ name: 'Author A' }], narrators: ['Stephen Fry'] },
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        // Advance past the 2000ms poll interval so the first poll fires
        await tickPoll();

        expect(result.current.state.rows[0]!.edited.metadata?.narrators).toEqual(['Stephen Fry']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('readyCount decrements when a high-confidence row is deselected', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123',
        status: 'completed',
        matched: 1,
        total: 2,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'high',
          bestMatch: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: [] },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Advance past the 2000ms poll interval so match results arrive
      await tickPoll();

      // Row 0 is high confidence and selected → ready count = 1
      expect(result.current.counts.readyCount).toBe(1);

      // Deselect the matched row → ready count drops to 0
      act(() => { result.current.actions.handleToggle(0); });
      expect(result.current.counts.readyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes pendingCount and noMatchCount correctly', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    // Before any match results, all are pending
    expect(result.current.counts.pendingCount).toBe(2);
    expect(result.current.counts.noMatchCount).toBe(0);
    expect(result.current.counts.readyCount).toBe(0);
    expect(result.current.counts.reviewCount).toBe(0);
  });

  // #1102 — selectedPendingCount: scoped to selected rows (not global)
  describe('selectedPendingCount (#1102)', () => {
    it('only counts selected rows still awaiting a match', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Both rows pending and selected by default
      expect(result.current.counts.pendingCount).toBe(2);
      expect(result.current.counts.selectedPendingCount).toBe(2);

      // Deselect one row → global pending unchanged, selected pending drops
      act(() => { result.current.actions.handleToggle(0); });
      expect(result.current.counts.pendingCount).toBe(2);
      expect(result.current.counts.selectedPendingCount).toBe(1);
    });

    it('excludes duplicate rows from selectedPendingCount', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      // Manually select a duplicate row that has no matchResult — it must NOT
      // be counted in selectedPendingCount (mirrors pendingCount's exclusion).
      act(() => { result.current.actions.handleToggle(1); });
      expect(result.current.state.rows[1]!.selected).toBe(true);
      expect(result.current.state.rows[1]!.book.isDuplicate).toBe(true);
      expect(result.current.counts.selectedPendingCount).toBe(1); // only the non-dup at index 0
    });
  });

  // ===========================================================================
  // #114 — duplicate row behavior
  // ===========================================================================
  describe('duplicate rows (isDuplicate: true)', () => {
    it('duplicate rows initialize with selected: false', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      const dupRows = result.current.state.rows.filter(r => r.book.isDuplicate);
      expect(dupRows).toHaveLength(2);
      expect(dupRows.every(r => !r.selected)).toBe(true);
    });

    it('duplicate rows are excluded from startMatching candidates', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      expect(vi.mocked(api.startMatchJob)).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ path: '/audiobooks/New Book' }),
        ]),
      );
      const callArgs = vi.mocked(api.startMatchJob).mock.calls[0]![0];
      expect(callArgs.every(c => !SCAN_RESULT_WITH_DUPLICATES.discoveries.find(d => d.path === c.path && d.isDuplicate))).toBe(true);
    });

    it('handleImport sends forceImport: true for selected duplicate rows', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      // Manually select the first duplicate row (index 1)
      act(() => { result.current.actions.handleToggle(1); });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(vi.mocked(api.createImportSubmission)).toHaveBeenCalled(); });

      const books = submittedItems();
      const dupItem = books.find(b => b.path === '/audiobooks/Existing Book');
      expect(dupItem?.forceImport).toBe(true);
    });

    it('handleImport omits forceImport for non-duplicate selected rows', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      // Only the non-duplicate row (index 0) is selected by default
      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(vi.mocked(api.createImportSubmission)).toHaveBeenCalled(); });

      const books = submittedItems();
      const newItem = books.find(b => b.path === '/audiobooks/New Book');
      expect(newItem?.forceImport).toBeUndefined();
    });

    it('duplicate rows do not auto-select when match result arrives', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);
        // Match job returns a result for the path of a duplicate row (edge case)
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123',
          status: 'completed',
          matched: 1,
          total: 1,
          results: [{
            path: '/audiobooks/Existing Book',
            confidence: 'high',
            bestMatch: { title: 'Existing Book', authors: [{ name: 'Author B' }], narrators: [] },
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

        await tickPoll();

        const dupRow = result.current.state.rows.find(r => r.book.path === '/audiobooks/Existing Book');
        expect(dupRow?.selected).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('duplicateCount equals the number of discoveries with isDuplicate: true', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      expect(result.current.counts.duplicateCount).toBe(2);
    });
  });

  describe('library root guardrail via libraryPath option (#134)', () => {
    it('does not call scanDirectory when scanPath is inside libraryPath', async () => {
      const { result } = renderHook(
        () => useManualImport({ libraryPath: '/audiobooks' }),
        { wrapper: createWrapper() },
      );
      act(() => { result.current.state.setScanPath('/audiobooks/sub'); });
      await act(async () => { result.current.actions.handleScan(); });
      expect(vi.mocked(api.scanDirectory)).not.toHaveBeenCalled();
    });

    it('does not call scanDirectory when scanPath equals libraryPath exactly', async () => {
      const { result } = renderHook(
        () => useManualImport({ libraryPath: '/audiobooks' }),
        { wrapper: createWrapper() },
      );
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      expect(vi.mocked(api.scanDirectory)).not.toHaveBeenCalled();
    });

    it('calls scanDirectory with trimmed path when scanPath is outside libraryPath', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      const { result } = renderHook(
        () => useManualImport({ libraryPath: '/audiobooks' }),
        { wrapper: createWrapper() },
      );
      act(() => { result.current.state.setScanPath('/media/podcasts'); });
      await act(async () => { result.current.actions.handleScan(); });
      expect(vi.mocked(api.scanDirectory)).toHaveBeenCalledWith('/media/podcasts');
    });

    it('calls scanDirectory normally when libraryPath is not provided', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      const { result } = renderHook(
        () => useManualImport(),
        { wrapper: createWrapper() },
      );
      act(() => { result.current.state.setScanPath('/audiobooks/sub'); });
      await act(async () => { result.current.actions.handleScan(); });
      expect(vi.mocked(api.scanDirectory)).toHaveBeenCalledWith('/audiobooks/sub');
    });

    it('calls scanDirectory normally when libraryPath is empty string', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      const { result } = renderHook(
        () => useManualImport({ libraryPath: '' }),
        { wrapper: createWrapper() },
      );
      act(() => { result.current.state.setScanPath('/audiobooks/sub'); });
      await act(async () => { result.current.actions.handleScan(); });
      expect(vi.mocked(api.scanDirectory)).toHaveBeenCalledWith('/audiobooks/sub');
    });
  });

  describe('review-flagged rows default-selection (#1031)', () => {
    it('non-duplicate row carrying reviewReason starts selected (review flag is a warning, not a blocker)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue({
        discoveries: [{
          path: '/audiobooks/Heir',
          parsedTitle: 'Heir to the Empire',
          parsedAuthor: 'Timothy Zahn',
          parsedSeries: null,
          fileCount: 29,
          totalSize: 800_000_000,
          isDuplicate: false,
          reviewReason: 'Additional non-book content possibly merged',
        }],
        totalFolders: 1,
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });

      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });

      await waitFor(() => expect(result.current.state.step).toBe('review'));

      const row = result.current.state.rows.find(r => !!r.book.reviewReason);
      expect(row).toBeDefined();
      expect(row!.selected).toBe(true);
    });
  });
});

describe('handleScan guards (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.startMatchJob).mockResolvedValue({ jobId: 'job-123' });
    vi.mocked(api.getMatchJob).mockResolvedValue({
      id: 'job-123', status: 'matching', matched: 0, total: 2, results: [],
    });
    vi.mocked(api.cancelMatchJob).mockResolvedValue(undefined as never);
  });

  it('whitespace-only path does not trigger scan mutation', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });

    act(() => { result.current.state.setScanPath('   '); });
    act(() => { result.current.actions.handleScan(); });

    expect(api.scanDirectory).not.toHaveBeenCalled();
  });
});

describe('match merge — boundary values (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.startMatchJob).mockResolvedValue({ jobId: 'job-123' });
    vi.mocked(api.cancelMatchJob).mockResolvedValue(undefined as never);
  });

  it('bestMatch=null preserves existing edited state', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'none',
          bestMatch: null,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();

      // Existing edited state preserved (not overwritten by null bestMatch)
      expect(result.current.state.rows[0]!.edited.title).toBe('Book A');
      expect(result.current.state.rows[0]!.edited.author).toBe('Author A');
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bestMatch with empty authors array falls back to existing row.edited.author', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'high',
          bestMatch: { title: 'Official Title', authors: [], series: [{ name: 'S1', position: 1 }] },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();

      // Title from bestMatch, author falls back to original parsed value
      expect(result.current.state.rows[0]!.edited.title).toBe('Official Title');
      expect(result.current.state.rows[0]!.edited.author).toBe('Author A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confidence=none auto-unchecks the row (selected → false)', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'none',
          bestMatch: null,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Row starts selected
      expect(result.current.state.rows[0]!.selected).toBe(true);

      await tickPoll();

      // After match merge with confidence=none, row is auto-unchecked
      expect(result.current.state.rows[0]!.selected).toBe(false);
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confidence=medium (Review) auto-unchecks the row (selected → false)', async () => {
    // Medium-confidence rows must default to unchecked so a human reviews the
    // match before importing — only 'high' stays checked (#1318).
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'medium',
          bestMatch: { title: 'Official Title', authors: [{ name: 'Author A' }] },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Row starts selected
      expect(result.current.state.rows[0]!.selected).toBe(true);

      await tickPoll();

      // After match merge with confidence=medium, row is auto-unchecked
      expect(result.current.state.rows[0]!.selected).toBe(false);
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');

      // Count parity with the library twin: the medium row lands in reviewCount
      // and is excluded from selectedCount (the second, un-matched row stays
      // selected, so selectedCount is 1, not 0).
      expect(result.current.counts.reviewCount).toBe(1);
      expect(result.current.counts.selectedCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('high confidence does NOT re-select a row the user had deselected (#1318 parity)', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      // Job still matching while the user toggles the row off.
      vi.mocked(api.getMatchJob).mockResolvedValue({ id: 'job-123', status: 'matching', matched: 0, total: 1, results: [] });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Deselect row 0 via the bare checkbox before results arrive.
      act(() => { result.current.actions.handleToggle(0); });
      expect(result.current.state.rows[0]!.selected).toBe(false);

      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{ path: '/audiobooks/Book A', confidence: 'high', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
      });

      await tickPoll();

      // High preserves the prior selection — a deselected row stays deselected.
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
      expect(result.current.state.rows[0]!.selected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edit-during-matching preserves selection: a user-FIXED row stays checked when a later medium match merges (#1374)', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      // Job still matching when the user fixes the row.
      vi.mocked(api.getMatchJob).mockResolvedValue({ id: 'job-123', status: 'matching', matched: 0, total: 1, results: [] });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // User commits a fix via the edit modal — sets userEdited + auto-checks.
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Corrected', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });
      expect(result.current.state.rows[0]!.userEdited).toBe(true);
      expect(result.current.state.rows[0]!.selected).toBe(true);

      // The in-flight job (searched on the scan-time title) returns a medium result.
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{ path: '/audiobooks/Book A', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
      });

      await tickPoll();

      // userEdited row keeps its selection despite the medium merge.
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');
      expect(result.current.state.rows[0]!.selected).toBe(true);
      expect(result.current.state.rows[0]!.userEdited).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('edit-during-matching preserves manually-corrected fields when a later bestMatch merges (no metadata picked, #1374 F1)', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({ id: 'job-123', status: 'matching', matched: 0, total: 1, results: [] });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // User corrects fields manually WITHOUT picking a provider result, so the
      // edit modal saves metadata: undefined (BookEditModal.handleSave).
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'My Correction', author: 'My Author', series: '',
        });
      });
      expect(result.current.state.rows[0]!.userEdited).toBe(true);
      expect(result.current.state.rows[0]!.edited.metadata).toBeUndefined();

      // A later best-match result merges in.
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{ path: '/audiobooks/Book A', confidence: 'high', bestMatch: { title: 'Provider Title', authors: [{ name: 'Provider Author' }] }, alternatives: [] }],
      });

      await tickPoll();

      // The user's manual correction survives — userEdited gates auto-populate,
      // not edited.metadata alone.
      expect(result.current.state.rows[0]!.edited.title).toBe('My Correction');
      expect(result.current.state.rows[0]!.edited.author).toBe('My Author');
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  it('#1318 guard: a merely-toggled (not edited) row is still unchecked by a medium merge', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({ id: 'job-123', status: 'matching', matched: 0, total: 1, results: [] });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      // Bare toggle off then on — must NOT set userEdited.
      act(() => { result.current.actions.handleToggle(0); });
      act(() => { result.current.actions.handleToggle(0); });
      expect(result.current.state.rows[0]!.selected).toBe(true);
      expect(result.current.state.rows[0]!.userEdited).toBe(false);

      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{ path: '/audiobooks/Book A', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
      });

      await tickPoll();

      expect(result.current.state.rows[0]!.selected).toBe(false);
      expect(result.current.state.rows[0]!.userEdited).toBe(false);
      expect(result.current.counts.reviewCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('autoCheck re-checks a medium row deselected by the merge when metadata is supplied via edit', async () => {
    // A merge deselects the medium row; supplying metadata through the edit flow
    // is explicit user intent, so the row re-checks (#1318 / #185 autoCheck).
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'medium',
          bestMatch: { title: 'Official Title', authors: [{ name: 'Author A' }] },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();

      // Merge deselected the medium row
      expect(result.current.state.rows[0]!.selected).toBe(false);

      // Supplying metadata via the edit flow re-checks the row
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0]!.selected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handleEdit — auto-check and confidence upgrade (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.startMatchJob).mockResolvedValue({ jobId: 'job-123' });
    vi.mocked(api.getMatchJob).mockResolvedValue({
      id: 'job-123', status: 'matching', matched: 0, total: 2, results: [],
    });
    vi.mocked(api.cancelMatchJob).mockResolvedValue(undefined as never);
  });

  it('unselected row with metadata provided auto-selects the row', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    // Deselect row 0 first
    act(() => { result.current.actions.handleToggle(0); });
    expect(result.current.state.rows[0]!.selected).toBe(false);

    // Edit with metadata → should auto-select
    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.state.rows[0]!.selected).toBe(true);
  });

  it('already-selected row with metadata provided remains selected', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    expect(result.current.state.rows[0]!.selected).toBe(true);

    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.state.rows[0]!.selected).toBe(true);
  });

  it('selected row with metadata removed/null remains selected', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    expect(result.current.state.rows[0]!.selected).toBe(true);

    // Edit without metadata (metadata undefined) → should remain selected
    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
      });
    });

    expect(result.current.state.rows[0]!.selected).toBe(true);
  });

  it('row with matchResult confidence=none and new metadata — confidence upgrades to medium', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'none',
          bestMatch: null,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('none');

      // Edit with metadata → confidence upgrades from 'none' to 'medium'
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── #335 Manual match override: medium → high ──────────────────────────
  it('row with matchResult confidence=medium and NEW provider metadata → confidence upgrades to high', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'medium',
          bestMatch: MATCH_METADATA,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');

      // Edit with a DIFFERENT metadata object (user explicitly re-selected) → upgrades to high
      const newMetadata = { ...MATCH_METADATA, asin: 'B002NEWPICK' };
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: newMetadata,
        });
      });

      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  it('row with matchResult confidence=medium saved with preloaded metadata (no re-selection) → stays medium', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'medium',
          bestMatch: MATCH_METADATA,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');

      // Save with the SAME metadata reference (user opened modal and clicked Save without re-selecting)
      const preloadedMetadata = result.current.state.rows[0]!.edited.metadata;
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          ...(preloadedMetadata !== undefined && { metadata: preloadedMetadata }),
        });
      });

      // Should NOT upgrade — no explicit provider re-selection
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');
    } finally {
      vi.useRealTimers();
    }
  });

  it('row with matchResult confidence=medium and explicit click on SAME current match → upgrades to high', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'medium',
          bestMatch: MATCH_METADATA,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');

      // Simulate explicit click on the current match — applyMetadata spreads to new reference
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: { ...MATCH_METADATA },
        });
      });

      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  it('row with matchResult confidence=high and new metadata → confidence stays high', async () => {
    try {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', matched: 1, total: 1,
        results: [{
          path: '/audiobooks/Book A',
          confidence: 'high',
          bestMatch: MATCH_METADATA,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll();
      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');

      // Edit with provider metadata → confidence stays 'high'
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  it('row with no matchResult and new metadata — no upgrade attempted, no crash', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    // No match results have arrived → matchResult is undefined
    expect(result.current.state.rows[0]!.matchResult).toBeUndefined();

    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    // No crash; matchResult stays undefined (no confidence upgrade without existing matchResult)
    expect(result.current.state.rows[0]!.matchResult).toBeUndefined();
    expect(result.current.state.rows[0]!.selected).toBe(true);
  });
});

describe('grouped return shape (REACT-1 refactor)', () => {
  it('returned object has state, actions, mutations, counts keys with no top-level leaked values', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    expect(result.current).toHaveProperty('state');
    expect(result.current).toHaveProperty('actions');
    expect(result.current).toHaveProperty('mutations');
    expect(result.current).toHaveProperty('counts');
    expect(result.current).not.toHaveProperty('step');
    expect(result.current).not.toHaveProperty('scanPath');
    expect(result.current).not.toHaveProperty('handleScan');
    expect(result.current).not.toHaveProperty('scanMutation');
    expect(result.current).not.toHaveProperty('selectedCount');
  });

  it('state group contains step, scanPath, scanError, rows, mode, editIndex, isMatching, progress and setters', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    expect(result.current.state).toMatchObject({
      step: 'path',
      scanPath: '',
      scanError: null,
      rows: [],
      mode: 'copy',
      editIndex: null,
      isMatching: false,
    });
    expect(result.current.state).toHaveProperty('progress');
    expect(result.current.state).toHaveProperty('setScanPath');
    expect(result.current.state).toHaveProperty('setScanError');
    expect(result.current.state).toHaveProperty('setMode');
    expect(result.current.state).toHaveProperty('setEditIndex');
  });

  it('actions group contains handleScan, handleToggle, handleToggleAll, handleEdit, handleImport, handleBack', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    expect(typeof result.current.actions.handleScan).toBe('function');
    expect(typeof result.current.actions.handleToggle).toBe('function');
    expect(typeof result.current.actions.handleToggleAll).toBe('function');
    expect(typeof result.current.actions.handleEdit).toBe('function');
    expect(typeof result.current.actions.handleImport).toBe('function');
    expect(typeof result.current.actions.handleBack).toBe('function');
  });

  it('mutations group contains scanMutation and importMutation', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    expect(result.current.mutations).toHaveProperty('scanMutation');
    expect(result.current.mutations).toHaveProperty('importMutation');
  });

  it('counts group contains all computed counts with correct initial values', () => {
    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    expect(result.current.counts).toMatchObject({
      selectedCount: 0,
      selectedUnmatchedCount: 0,
      readyCount: 0,
      reviewCount: 0,
      noMatchCount: 0,
      pendingCount: 0,
      selectedPendingCount: 0,
      duplicateCount: 0,
      allSelected: false,
    });
  });

  // ── #415 Match confidence reason passthrough ────────────────────────
  describe('confidence reason lifecycle (#415)', () => {
    it('mergeMatchResults preserves reason field from MatchResult onto ImportRow', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123', status: 'completed', matched: 1, total: 1,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'medium',
            bestMatch: MATCH_METADATA,
            alternatives: [],
            reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();
        expect(result.current.state.rows[0]!.matchResult?.reason).toBe(
          'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('medium → high upgrade clears reason to undefined', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123', status: 'completed', matched: 1, total: 1,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'medium',
            bestMatch: MATCH_METADATA,
            alternatives: [],
            reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();
        expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');
        expect(result.current.state.rows[0]!.matchResult?.reason).toBeDefined();

        // Edit with NEW metadata → upgrades to high, reason must be cleared
        const newMetadata = { ...MATCH_METADATA, asin: 'B002NEWPICK' };
        act(() => {
          result.current.actions.handleEdit(0, {
            title: 'Book A', author: 'Author A', series: '',
            metadata: newMetadata,
          });
        });

        expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
        expect(result.current.state.rows[0]!.matchResult?.reason).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('none → medium upgrade does not set a reason (user-initiated)', async () => {
      try {
        vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
        vi.mocked(api.getMatchJob).mockResolvedValue({
          id: 'job-123', status: 'completed', matched: 1, total: 1,
          results: [{
            path: '/audiobooks/Book A',
            confidence: 'none',
            bestMatch: null,
            alternatives: [],
          }],
        });

        const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
        act(() => { result.current.state.setScanPath('/audiobooks'); });
        await act(async () => { result.current.actions.handleScan(); });
        await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

        await tickPoll();
        expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('none');

        // Edit with metadata → upgrades to medium, but no system reason
        act(() => {
          result.current.actions.handleEdit(0, {
            title: 'Book A', author: 'Author A', series: '',
            metadata: MATCH_METADATA,
          });
        });

        expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('medium');
        expect(result.current.state.rows[0]!.matchResult?.reason).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // #1864 — manual import previously dropped match failures silently (:27 destructure
  // omitted the recovery contract). It now surfaces the paused state with inline recovery.
  describe('match-phase recovery (#1864)', () => {
    // These tests sequence poll responses with `*Once()`. The file's `clearAllMocks`
    // beforeEach does NOT drain those queues (vitest-clearallmocks-once-queue), so a
    // prior test's leftover queued response would be consumed by our first poll. Reset
    // the job mocks fully here before each test re-establishes its own sequence.
    beforeEach(() => {
      vi.mocked(api.getMatchJob).mockReset().mockResolvedValue({ id: 'job-123', status: 'matching', total: 0, matched: 0, results: [] });
      vi.mocked(api.startMatchJob).mockReset().mockResolvedValue({ jobId: 'job-123' });
      vi.mocked(api.cancelMatchJob).mockReset().mockResolvedValue(undefined as never);
    });

    it('a match-start failure surfaces paused state instead of failing silently', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.startMatchJob).mockRejectedValue(new Error('down'));

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await waitFor(() => {
        expect(result.current.state.paused).toBe(true);
        expect(result.current.state.pausedReason).toBe('start-failed');
      });
    });

    it('handleRestartMatch clears matched rows, resets offset, and rebuilds candidates from CURRENT edited rows incl seriesPosition:0 (F5/F6)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockResolvedValue({
        id: 'job-123', status: 'completed', total: 2, matched: 1,
        results: [{ path: '/audiobooks/Book A', confidence: 'high', bestMatch: { title: 'Book A', authors: [{ name: 'Author A' }] }, alternatives: [] }],
      });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });
      await tickPoll(); // fire poll1 → Book A completed/matched
      await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.matchResult?.confidence).toBe('high'));

      // Edit Book A to genuinely-different values, including position 0 (regression-pinned).
      act(() => {
        result.current.actions.handleEdit(0, { title: 'Edited A', author: 'Edited Author', series: 'Fablehaven', seriesPosition: 0 });
      });

      vi.mocked(api.startMatchJob).mockClear();
      act(() => { result.current.actions.handleRestartMatch(); });

      // Restart clears the stale match to pending immediately (row-match clear).
      expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.matchResult).toBeUndefined();

      // The Restart candidate payload reflects the CURRENT edited row values, not the
      // original parsed fields — asserting the exact shape (replacing row.edited would fail this).
      await waitFor(() => expect(api.startMatchJob).toHaveBeenCalled());
      const candidates = vi.mocked(api.startMatchJob).mock.calls[0]![0];
      const editedA = candidates.find(c => c.path === '/audiobooks/Book A');
      expect(editedA).toEqual({ path: '/audiobooks/Book A', title: 'Edited A', author: 'Edited Author', seriesPosition: 0 });
    });

    it('recovering is true during an automatic retry backoff, activating the fail-closed gate (F1)', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob).mockReset();
      vi.mocked(api.getMatchJob)
        .mockRejectedValueOnce(new Error('blip')) // first poll fails → backoff → recovering
        .mockResolvedValue({ id: 'job-123', status: 'matching', total: 2, matched: 0, results: [] });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll(); // poll1 rejects (transport) → bounded backoff → recovering
      expect(result.current.state.recovering).toBe(true);
    });

    it('handleResumeMatch preserves matched rows and re-matches only the remainder (F5)', async () => {
      const a: MatchResult = { path: '/audiobooks/Book A', confidence: 'high', bestMatch: { title: 'Book A', authors: [{ name: 'Author A' }] }, alternatives: [] };
      const b: MatchResult = { path: '/audiobooks/Book B', confidence: 'high', bestMatch: { title: 'Book B', authors: [] }, alternatives: [] };
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.getMatchJob)
        .mockResolvedValueOnce({ id: 'job-123', status: 'matching', total: 2, matched: 1, results: [a] })
        .mockRejectedValueOnce(new ApiError(400, { error: 'bad' })) // pause request-rejected, id retained
        .mockResolvedValueOnce({ id: 'job-123', status: 'completed', total: 2, matched: 2, results: [a, b] }); // resume-entry probe

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

      await tickPoll(); // poll1: matching with [Book A] partial → Book A matched
      await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.matchResult?.confidence).toBe('high'));
      await tickPoll(); // poll2: other-4xx → pause request-rejected (id retained)
      expect(result.current.state.paused).toBe(true);

      // Resume-entry probe (fires getMatchJob immediately, no timer) → completed [a, b].
      await act(async () => { result.current.actions.handleResumeMatch(); });
      await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book B')?.matchResult?.confidence).toBe('high'));
      // Book A's match is preserved across the resume.
      expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/Book A')?.matchResult?.confidence).toBe('high');
      expect(result.current.state.paused).toBe(false);
    });
  });
});
