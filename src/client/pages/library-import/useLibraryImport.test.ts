import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useLibraryImport } from './useLibraryImport';
import { ApiError } from '@/lib/api';
import type { BookMetadata, ScanResult } from '@/lib/api';
import { createMockSettings } from '@/__tests__/factories';
import { toast } from 'sonner';

/** A metadata blob padded so a confirm item serializes to roughly `bytes`. */
const bigMetadata = (bytes: number): BookMetadata => ({ blob: 'x'.repeat(bytes) } as unknown as BookMetadata);

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockScanDirectory = vi.fn();
const mockConfirmImport = vi.fn();
const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();
const mockGetSettings = vi.fn();
const mockGetBookIdentifiers = vi.fn();

// Preserve the real runtime exports (notably `ApiError`, imported at runtime by the
// 413 mapping in confirmErrorMessage — #1831) and override only `api`. Replacing the
// barrel wholesale would drop ApiError and break the confirm error path
// (vimock-barrel-replace-drops-named-exports).
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
    confirmImport: (...args: unknown[]) => mockConfirmImport(...args),
    startMatchJob: (...args: unknown[]) => mockStartMatchJob(...args),
    getMatchJob: (...args: unknown[]) => mockGetMatchJob(...args),
    cancelMatchJob: (...args: unknown[]) => mockCancelMatchJob(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    getBookIdentifiers: (...args: unknown[]) => mockGetBookIdentifiers(...args),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(MemoryRouter, null, children));
}

const mockSettings = createMockSettings({ library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' } });
const mockSettingsNoPath = createMockSettings({ library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' } });

const mockScanResult: ScanResult = {
  discoveries: [
    { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
    { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 2, totalSize: 80000, isDuplicate: true, duplicateReason: 'path' },
    { path: '/audiobooks/AuthorC/Book3', parsedTitle: 'Book Three', parsedAuthor: 'Author C', parsedSeries: null, fileCount: 1, totalSize: 60000, isDuplicate: true, duplicateReason: 'slug' },
  ],
  totalFolders: 3,
};

describe('useLibraryImport hook (#133)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetBookIdentifiers.mockResolvedValue([]);
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
    // Chunked confirm runner (#1831) expects each chunk POST to resolve with an ImportResult;
    // tests that assert on outcomes override this.
    mockConfirmImport.mockResolvedValue({ accepted: 0, heldReview: [], skipped: [], failed: [] });
  });

  it('on mount with library path configured: calls api.scanDirectory, starts match job, transitions to review state', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.step).toBe('review');
    });

    expect(mockScanDirectory).toHaveBeenCalledWith('/audiobooks');
    expect(mockStartMatchJob).toHaveBeenCalled();
  });

  it('on mount without library path: no scan initiated, hasLibraryPath=false state set', async () => {
    mockGetSettings.mockResolvedValue(mockSettingsNoPath);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.hasLibraryPath).toBe(false);
    });

    expect(mockScanDirectory).not.toHaveBeenCalled();
  });

  it('settings fetch fails: shows fallback (same as missing-path state)', async () => {
    mockGetSettings.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.hasLibraryPath).toBe(false);
    });

    expect(mockScanDirectory).not.toHaveBeenCalled();
  });

  it('scan request fails: scanError state set', async () => {
    mockScanDirectory.mockRejectedValue(new Error('Permission denied'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.scanError).toBe('Permission denied');
    });
  });

  it('match results merge: confidence=none result deselects non-duplicate row; duplicate row stays unselected', async () => {
    // Poll resolves immediately with a 'completed' job that has a 'none' confidence result
    // for the non-duplicate row. The interval fires at POLL_INTERVAL (2s) so we extend timeout.
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1',
      status: 'completed',
      total: 1,
      matched: 1,
      results: [
        { path: '/audiobooks/AuthorA/Book1', confidence: 'none', bestMatch: null, alternatives: [] },
      ],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    // Before poll fires: non-dup starts selected
    const nonDupRowBefore = result.current.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRowBefore?.selected).toBe(true);

    // After poll fires (2s interval): non-dup row should be deselected due to confidence='none'
    await waitFor(() => {
      const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.selected).toBe(false);
    }, { timeout: 5000 });

    // Duplicate rows remain unselected regardless
    const pathDupRow = result.current.rows.find(r => r.book.duplicateReason === 'path');
    expect(pathDupRow?.selected).toBe(false);
  });

  it('post-match duplicate (F8): high-confidence result flagged isDuplicate deselects the row and excludes it from the confirm payload (#1662)', async () => {
    // A selectable sibling keeps the confirm request non-empty so the payload actually ships;
    // the flagged duplicate (Book1) must be absent from it.
    mockScanDirectory.mockResolvedValue({
      ...mockScanResult,
      discoveries: [
        ...mockScanResult.discoveries,
        { path: '/audiobooks/AuthorD/Book4', parsedTitle: 'Book Four', parsedAuthor: 'Author D', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
      ],
    });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1',
      status: 'completed',
      total: 1,
      matched: 1,
      results: [
        {
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'high',
          bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
          alternatives: [],
          isDuplicate: true,
          existingBookId: 421,
          duplicateReason: 'slug',
        },
      ],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));
    expect(result.current.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(true);

    // After the post-match flag arrives, the row is flagged AND deselected.
    await waitFor(() => {
      const row = result.current.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1');
      expect(row?.book.isDuplicate).toBe(true);
      expect(row?.book.existingBookId).toBe(421);
      expect(row?.selected).toBe(false);
    }, { timeout: 5000 });

    // It is therefore absent from the confirm payload (which still carries the sibling).
    act(() => result.current.handleRegister());
    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalled());
    const items = mockConfirmImport.mock.calls.flatMap(c => c[0] as Array<{ path: string }>);
    expect(items.some(i => i.path === '/audiobooks/AuthorD/Book4')).toBe(true);
    expect(items.some(i => i.path === '/audiobooks/AuthorA/Book1')).toBe(false);
  });

  it('match results merge: confidence=medium (Review) deselects non-duplicate row; reviewCount increments, selectedCount excludes it', async () => {
    // Medium-confidence ("Review" badge) rows must NOT default to checked — a human
    // should eyeball the match before importing it (#1318).
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1',
      status: 'completed',
      total: 1,
      matched: 1,
      results: [
        { path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] },
      ],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    // Before poll fires: non-dup starts selected
    const nonDupRowBefore = result.current.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRowBefore?.selected).toBe(true);

    // After poll fires: non-dup row deselected due to confidence='medium'
    await waitFor(() => {
      const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.matchResult?.confidence).toBe('medium');
      expect(nonDupRow?.selected).toBe(false);
    }, { timeout: 5000 });

    // reviewCount counts the medium row; selectedCount must not include it
    expect(result.current.reviewCount).toBe(1);
    const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
    expect(result.current.selectedCount).toBe(0);
    expect(nonDupRow?.selected).toBe(false);
  });

  it('Select All: only selects rows where isDuplicate=false', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    // First deselect the non-dup row to set up a partial state
    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.handleToggle(nonDupIdx));

    // Now handleSelectAll should re-select only non-dup rows
    act(() => result.current.handleSelectAll());

    const pathDupRow = result.current.rows.find(r => r.book.duplicateReason === 'path');
    const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
    expect(pathDupRow?.selected).toBe(false);
    expect(nonDupRow?.selected).toBe(true);
  });

  it('slug-duplicate row: after editing title+author to non-colliding value, row becomes importable', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');
    expect(slugDupIdx).toBeGreaterThanOrEqual(0);

    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'Different Title', author: 'Different Author', series: '' });
    });

    await waitFor(() => {
      const row = result.current.rows[slugDupIdx];
      expect(row!.book.isDuplicate).toBe(false);
    });
  });

  it('slug-duplicate row: case-only / colon-subtitle title change KEEPS row flagged (normalized contract #1662)', async () => {
    // Existing book has title 'Book Three' / 'Author C'. Under the shared
    // normalized-title + author-slug predicate, a case-only ('book three') or
    // colon-subtitle ('Book Three: A Subtitle') change still collides — the row
    // stays flagged (the recheck no longer uses exact title equality).
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'Book Three: A Subtitle', author: 'author c', series: '' });
    });

    // Give the recheck a tick; the row must remain flagged.
    await waitFor(() => expect(result.current.rows[slugDupIdx]!.userEdited).toBe(true));
    expect(result.current.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('slug-duplicate row flagged by ASIN stays flagged after non-colliding title/author edits (#1662 F5)', async () => {
    // The library entry shares only the ASIN. Editing the title + author to a
    // genuinely different identity must NOT clear the flag, because the ASIN
    // (carried on the edited state) still matches branch 1 of the predicate.
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: 'B0OWNEDASIN', title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'Totally Different', author: 'Someone Else', series: '', asin: 'B0OWNEDASIN' });
    });

    await waitFor(() => expect(result.current.rows[slugDupIdx]!.userEdited).toBe(true));
    expect(result.current.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('match-job start failure: pauses start-failed (no active job) instead of a raw error string (#1864)', async () => {
    mockStartMatchJob.mockRejectedValue(new Error('match server unavailable'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    await waitFor(() => {
      expect(result.current.paused).toBe(true);
      expect(result.current.pausedReason).toBe('start-failed');
    });
  });

  it('handleRestartMatch: starts a new logical run with non-duplicate candidates and clears the pause (#1864)', async () => {
    // Initial attempt fails at start (paused start-failed)
    mockStartMatchJob
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.paused).toBe(true));

    // Restart — beginLogical clears the pause synchronously before the new start.
    act(() => result.current.handleRestartMatch());

    await waitFor(() => expect(result.current.paused).toBe(false));

    // startMatchJob called twice: initial scan + restart
    expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    const restartCandidates = mockStartMatchJob.mock.calls[1]![0] as Array<{ path: string; title: string }>;
    expect(restartCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/audiobooks/AuthorA/Book1', title: 'Book One' }),
    ]));
  });

  // #1849 — Restart threads the (possibly user-edited) seriesPosition into the
  // re-match candidate so the position tiebreaker survives a Restart. Pins position 0
  // (regression guard, #1028): deleting the spread at useLibraryImport.ts would drop it.
  it('handleRestartMatch: threads edited seriesPosition (including 0) into restart candidates (#1849)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    // Seed a genuine position-0 via edit so the restart builder must carry it.
    act(() => {
      result.current.handleEdit(nonDupIdx, { title: 'Book One', author: 'Author A', series: 'Fablehaven', seriesPosition: 0 });
    });

    // Isolate the restart call from the initial auto-scan match job.
    mockStartMatchJob.mockClear();
    act(() => { result.current.handleRestartMatch(); });
    await waitFor(() => { expect(mockStartMatchJob).toHaveBeenCalled(); });

    const restartCandidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string; seriesPosition?: number }>;
    const seeded = restartCandidates.find(c => c.path === '/audiobooks/AuthorA/Book1');
    expect(seeded?.seriesPosition).toBe(0);
  });

  it('Restart CLEARS already-matched rows to pending immediately (#1864 §5b/F5)', async () => {
    // Drain any leaked `*Once()` queue from a prior test (vitest-clearallmocks-once-queue).
    mockGetMatchJob.mockReset();
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'X', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const idx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.rows[idx]!.matchResult?.confidence).toBe('high'), { timeout: 5000 });

    // Restart clears the stale match to pending BEFORE the new run's first result lands.
    act(() => result.current.handleRestartMatch());
    expect(result.current.rows[idx]!.matchResult).toBeUndefined();
  });

  it('Resume PRESERVES already-matched rows and only re-matches the remainder (#1864 §5b/F5)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/A/B1', parsedTitle: 'B1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
        { path: '/audiobooks/A/B2', parsedTitle: 'B2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
      totalFolders: 2,
    });
    const b1 = { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'B1', authors: [{ name: 'A' }] }, alternatives: [] };
    const b2 = { path: '/audiobooks/A/B2', confidence: 'high', bestMatch: { title: 'B2', authors: [{ name: 'A' }] }, alternatives: [] };
    // Drain any leaked `*Once()` queue from a prior test (vitest-clearallmocks-once-queue).
    mockGetMatchJob.mockReset();
    mockGetMatchJob
      .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 2, matched: 1, results: [b1] })   // B1 observed (partial)
      .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))                                          // pause request-rejected, id retained
      .mockResolvedValueOnce({ id: 'job-1', status: 'completed', total: 2, matched: 2, results: [b1, b2] }); // resume-entry probe completes

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.rows.length).toBe(2));

    // B1 matches, then the run pauses — B1's match is kept.
    await waitFor(() => expect(result.current.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high'), { timeout: 5000 });
    await waitFor(() => expect(result.current.paused).toBe(true), { timeout: 5000 });
    expect(result.current.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high');

    // Resume preserves B1 and fills in B2.
    act(() => result.current.handleResumeMatch());
    await waitFor(() => expect(result.current.rows.find(r => r.book.path === '/audiobooks/A/B2')?.matchResult?.confidence).toBe('high'), { timeout: 5000 });
    expect(result.current.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high');
    expect(result.current.paused).toBe(false);
  }, 20000);

  it('path-duplicate row: no edit-triggered recheck, row stays locked', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Two', authorName: 'Author B', authorSlug: 'author-b' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    const pathDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'path');

    act(() => {
      result.current.handleEdit(pathDupIdx, { title: 'Totally Different', author: 'New Author', series: '' });
    });

    await waitFor(() => {
      const row = result.current.rows[pathDupIdx];
      expect(row!.book.isDuplicate).toBe(true);
      expect(row!.book.duplicateReason).toBe('path');
    });
  });

  it('Register call: confirmImport called with correct items payload and no mode', async () => {
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });

    expect(mockConfirmImport).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/audiobooks/AuthorA/Book1',
          title: 'Book One',
          authorName: 'Author A',
        }),
      ]),
      undefined,
    );
  });

  it('register returning heldReview stores the held items, stays on the page, and warns (#1711 F1)', async () => {
    const heldPath = '/audiobooks/AuthorA/Book1';
    mockConfirmImport.mockResolvedValueOnce({
      accepted: 0,
      heldReview: [{ path: heldPath, title: 'Book One', reason: 'recording-review-required', existingBookId: 9 }],
      skipped: [], failed: [],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });

    await waitFor(() => expect(result.current.heldReview).toHaveLength(1));
    expect(result.current.heldReview[0]!.path).toBe(heldPath);
    expect(result.current.heldReview[0]!.reason).toBe('recording-review-required');
    // Partial success keeps the user on the import page (does not navigate away).
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
  });

  it('handleReconfirmHeld re-submits the held rows with forceImport=true (#1711 F1)', async () => {
    const heldPath = '/audiobooks/AuthorA/Book1';
    mockConfirmImport.mockResolvedValueOnce({
      accepted: 0,
      heldReview: [{ path: heldPath, title: 'Book One', reason: 'recording-review-required' }],
      skipped: [], failed: [],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });
    await waitFor(() => expect(result.current.heldReview).toHaveLength(1));

    // Re-confirm: the held row is resubmitted with forceImport bypassing the safety-net.
    mockConfirmImport.mockResolvedValueOnce({ accepted: 1, heldReview: [], skipped: [], failed: [] });
    await act(async () => { result.current.handleReconfirmHeld(); });

    const lastCall = mockConfirmImport.mock.calls.at(-1)!;
    expect(lastCall[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: heldPath, forceImport: true }),
    ]));
    // The re-confirm with nothing held navigates to the library.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'));
  });

  it('handleRegister forwards edited.narrators and seriesPosition (#1028)', async () => {
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One',
        author: 'Author A',
        series: 'Discworld',
        narrators: ['Jim Dale'],
        seriesPosition: 27,
      });
    });

    await act(async () => { result.current.handleRegister(); });

    expect(mockConfirmImport).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          narrators: ['Jim Dale'],
          seriesPosition: 27,
        }),
      ]),
      undefined,
    );
  });

  it('handleRegister forwards seriesPosition: 0 (regression guard) (#1028)', async () => {
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One',
        author: 'Author A',
        series: 'Series',
        seriesPosition: 0,
      });
    });

    await act(async () => { result.current.handleRegister(); });

    const items = (mockConfirmImport.mock.calls[0]![0]) as Array<Record<string, unknown>>;
    const found = items.find((b) => b.path === '/audiobooks/AuthorA/Book1');
    expect(found?.seriesPosition).toBe(0);
  });

  it('parser-seeded parsedSeriesPosition flows from scan to register payload (#1042)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/Author/Series/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: 'Series', parsedSeriesPosition: 2.5, fileCount: 1, totalSize: 1000, isDuplicate: false },
      ],
      totalFolders: 1,
    });
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    expect(result.current.rows[0]!.edited.seriesPosition).toBe(2.5);

    await act(async () => { result.current.handleRegister(); });

    const items = (mockConfirmImport.mock.calls[0]![0]) as Array<Record<string, unknown>>;
    expect(items[0]!.seriesPosition).toBe(2.5);
  });

  it('parser-seeded parsedSeriesPosition survives a no-position best match merge (#1042)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/Author/Series/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: 'Series', parsedSeriesPosition: 3, fileCount: 1, totalSize: 1000, isDuplicate: false },
      ],
      totalFolders: 1,
    });
    // Best match arrives without a series position — fallback to parser-seeded value must hold.
    mockGetMatchJob.mockResolvedValue({
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
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await waitFor(() => {
      expect(result.current.rows[0]!.edited.metadata).toBeDefined();
    }, { timeout: 5000 });

    expect(result.current.rows[0]!.edited.seriesPosition).toBe(3);

    await act(async () => { result.current.handleRegister(); });
    const items = (mockConfirmImport.mock.calls[0]![0]) as Array<Record<string, unknown>>;
    expect(items[0]!.seriesPosition).toBe(3);
  });

  it('handleRegister does not forward narrators when empty array (#1028)', async () => {
    mockConfirmImport.mockResolvedValue({ accepted: 1, heldReview: [], skipped: [], failed: [] });
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One',
        author: 'Author A',
        series: '',
        narrators: [],
      });
    });

    await act(async () => { result.current.handleRegister(); });

    const items = (mockConfirmImport.mock.calls[0]![0]) as Array<Record<string, unknown>>;
    const found = items.find((b) => b.path === '/audiobooks/AuthorA/Book1');
    expect(found).not.toHaveProperty('narrators');
  });

  it('all-skipped register shows amber, no green, no navigate (#1822)', async () => {
    mockConfirmImport.mockResolvedValue({
      accepted: 0,
      heldReview: [],
      skipped: [{ path: '/audiobooks/AuthorA/Book1', title: 'Book One', reason: 'already-in-library', existingBookId: 4, existingTitle: 'Book One' }],
      failed: [],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });
    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalled());

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith("already in your library as 'Book One'");
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('all-failed register shows red, no green, no navigate (#1822)', async () => {
    mockConfirmImport.mockResolvedValue({
      accepted: 0,
      heldReview: [],
      skipped: [],
      failed: [{ path: '/audiobooks/AuthorA/Book1', title: 'Book One', message: 'Import failed — see server logs for details.' }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });
    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalled());

    expect(toast.error).toHaveBeenCalledWith('1 failed');
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('held + failed register surfaces the failure (regression pin for the early-return swallow) (#1822)', async () => {
    mockConfirmImport.mockResolvedValue({
      accepted: 0,
      heldReview: [{ path: '/audiobooks/AuthorA/Book1', title: 'Book One', reason: 'recording-review-required' }],
      skipped: [],
      failed: [{ path: '/audiobooks/AuthorA/Book1b', title: 'Book One B', message: 'Import failed — see server logs for details.' }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });
    await waitFor(() => expect(result.current.heldReview).toHaveLength(1));

    expect(toast.warning).toHaveBeenCalledWith('1 held for recording review');
    expect(toast.error).toHaveBeenCalledWith('1 failed');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('partial success (accepted + skipped) stays on the page and deselects the accepted rows (#1822)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 2, totalSize: 80000, isDuplicate: false },
      ],
      totalFolders: 2,
    });
    mockConfirmImport.mockResolvedValue({
      accepted: 1,
      heldReview: [],
      skipped: [{ path: '/audiobooks/AuthorB/Book2', title: 'Book Two', reason: 'already-in-library' }],
      failed: [],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => { result.current.handleRegister(); });
    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalled());

    expect(toast.warning).toHaveBeenCalledWith('1 registered · 1 already in your library');
    expect(mockNavigate).not.toHaveBeenCalled();
    // The accepted row (Book1) is deselected; the skipped row (Book2) is left as-is.
    const book1 = result.current.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')!;
    expect(book1.selected).toBe(false);
  });

  it('Register error path: toast.error shown when confirmImport rejects', async () => {
    mockConfirmImport.mockRejectedValue(new Error('network failure'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Import failed: network failure');
    });
  });

  it('413 confirm failure maps to import-domain wording (#1831)', async () => {
    mockConfirmImport.mockRejectedValue(new ApiError(413, { error: 'Payload Too Large' }));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));
    await act(async () => { result.current.handleRegister(); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Import failed: The import request was too large to send. Select fewer books and try again.',
      );
    });
  });

  it('self-oversize confirm item is diverted to tooLarge — never sent, row stays selected, no navigation (#1831)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    // Edit Book1 to carry a metadata blob above the per-item transport ceiling (~900 KiB).
    const idx = result.current.rows.findIndex(r => r.book.path === '/audiobooks/AuthorA/Book1');
    act(() => result.current.handleEdit(idx, { title: 'Book One', author: 'Author A', series: '', metadata: bigMetadata(950 * 1024) }));

    act(() => result.current.handleRegister());

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('too large to submit')));
    // No POST leaves the client, and nothing navigates.
    expect(mockConfirmImport).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The too-large row stays selected (fail-open — nothing landed).
    expect(result.current.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(true);
  });

  it('mid-sequence chunk failure applies completed chunks and keeps the remainder selected, no navigation (#1831)', async () => {
    // Two selectable rows, each edited above the chunk byte budget → two separate chunks.
    mockScanDirectory.mockResolvedValue({
      ...mockScanResult,
      discoveries: [
        { path: '/audiobooks/X/B1', parsedTitle: 'B1', parsedAuthor: 'X', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
        { path: '/audiobooks/Y/B2', parsedTitle: 'B2', parsedAuthor: 'Y', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
    });
    mockConfirmImport
      .mockResolvedValueOnce({ accepted: 1, heldReview: [], skipped: [], failed: [] })
      .mockRejectedValueOnce(new Error('connection reset'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.rows.length).toBe(2));

    act(() => result.current.handleEdit(0, { title: 'B1', author: 'X', series: '', metadata: bigMetadata(500 * 1024) }));
    act(() => result.current.handleEdit(1, { title: 'B2', author: 'Y', series: '', metadata: bigMetadata(500 * 1024) }));
    act(() => result.current.handleRegister());

    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalledTimes(2));
    // Completed chunk's row is deselected; the failing/never-sent row stays selected.
    await waitFor(() => expect(result.current.rows.find(r => r.book.path === '/audiobooks/X/B1')?.selected).toBe(false));
    expect(result.current.rows.find(r => r.book.path === '/audiobooks/Y/B2')?.selected).toBe(true);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('not confirmed'));
  });

  it('held item from an early chunk survives a later chunk failure (#1831)', async () => {
    // captureHeld REPLACES held state, so it must run once over the aggregate at run end —
    // a per-chunk capture (or an onError that skips it) would drop chunk 1's held item.
    mockScanDirectory.mockResolvedValue({
      ...mockScanResult,
      discoveries: [
        { path: '/audiobooks/X/B1', parsedTitle: 'B1', parsedAuthor: 'X', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
        { path: '/audiobooks/Y/B2', parsedTitle: 'B2', parsedAuthor: 'Y', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
    });
    mockConfirmImport
      .mockResolvedValueOnce({
        accepted: 0,
        heldReview: [{ path: '/audiobooks/X/B1', title: 'B1', reason: 'recording-review-required' }],
        skipped: [],
        failed: [],
      })
      .mockRejectedValueOnce(new Error('connection reset'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.rows.length).toBe(2));

    // Push each row over the chunk byte budget → two separate chunks.
    act(() => result.current.handleEdit(0, { title: 'B1', author: 'X', series: '', metadata: bigMetadata(500 * 1024) }));
    act(() => result.current.handleEdit(1, { title: 'B2', author: 'Y', series: '', metadata: bigMetadata(500 * 1024) }));
    act(() => result.current.handleRegister());

    await waitFor(() => expect(mockConfirmImport).toHaveBeenCalledTimes(2));
    // Chunk 1's held item is captured despite chunk 2's failure.
    await waitFor(() => expect(result.current.heldReview).toHaveLength(1));
    expect(result.current.heldReview[0]!.path).toBe('/audiobooks/X/B1');
    expect(toast.warning).toHaveBeenCalledWith('1 held for recording review');
    // The run failure still surfaces, and nothing navigates.
    expect(toast.error).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // AC3: empty state (#141)
  it('returns emptyResult=true when scan returns zero discoveries', async () => {
    mockScanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.emptyResult).toBe(true);
    });
    expect(result.current.scanError).toBeNull();
    expect(mockStartMatchJob).not.toHaveBeenCalled();
  });

  it('returns emptyResult=true when scan returns only duplicate discoveries (all caught up)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 2, totalSize: 80000, isDuplicate: true, duplicateReason: 'path' },
        { path: '/audiobooks/AuthorC/Book3', parsedTitle: 'Book Three', parsedAuthor: 'Author C', parsedSeries: null, fileCount: 1, totalSize: 60000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 2,
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.emptyResult).toBe(true);
    });
    expect(result.current.scanError).toBeNull();
    expect(mockStartMatchJob).not.toHaveBeenCalled();
  });

  it('returns emptyResult=false and starts matching when scan returns mix of new and duplicate books', async () => {
    // mockScanResult has 1 new + 2 duplicate
    mockScanDirectory.mockResolvedValue(mockScanResult);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.step).toBe('review');
    });
    expect(result.current.emptyResult).toBe(false);
    expect(mockStartMatchJob).toHaveBeenCalled();
  });

  describe('review-flagged rows default-selection (#1031)', () => {
    it('non-duplicate row carrying reviewReason starts selected (review flag is a warning, not a blocker)', async () => {
      mockScanDirectory.mockResolvedValue({
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

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.step).toBe('review'));

      const row = result.current.rows.find(r => !!r.book.reviewReason);
      expect(row).toBeDefined();
      expect(row!.selected).toBe(true);
    });
  });
});

describe('match merge — selection behavior (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetBookIdentifiers.mockResolvedValue([]);
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
  });

  it('high confidence preserves existing row.selected value (no auto-select of a deselected row)', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'high',
        bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] },
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    // Deselect the non-duplicate row before match results arrive
    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.handleToggle(nonDupIdx));
    expect(result.current.rows[nonDupIdx]!.selected).toBe(false);

    // Match result with high confidence merges — should NOT auto-select
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    expect(result.current.rows[nonDupIdx]!.selected).toBe(false);
  });

  it('high confidence keeps a default (still-checked) non-duplicate row selected', async () => {
    // Regression guard: 'high' must preserve the default checked state — only
    // 'medium' and 'none' flip to unchecked (#1318).
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'high',
        bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] },
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    // Do NOT touch the row — it starts selected by default
    await waitFor(() => {
      const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    const nonDupRow = result.current.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRow?.selected).toBe(true);
    expect(result.current.readyCount).toBe(1);
  });

  it('edit-during-matching preserves selection: a user-FIXED row stays checked when a later medium match merges (#1374)', async () => {
    // Job is still matching when the user fixes the row via the edit modal.
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    // User commits a fix — sets userEdited + auto-checks the row.
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Corrected Title', author: 'Author A', series: '',
        metadata: { title: 'Corrected Title', authors: [{ name: 'Author A' }] },
      });
    });
    expect(result.current.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);

    // The in-flight job (searched on the scan-time title) returns a medium result.
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    // userEdited row keeps its selection despite the medium merge.
    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);
    expect(result.current.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.selectedCount).toBeGreaterThanOrEqual(1);
  });

  it('Retry Match preserves a user-FIXED row: a re-result at medium does not uncheck it (#1374)', async () => {
    // Job first settles on a high match.
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high'), { timeout: 5000 });

    // User fixes the row.
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Corrected', author: 'Author A', series: '',
        metadata: { title: 'Corrected', authors: [{ name: 'Author A' }] },
      });
    });
    expect(result.current.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);

    // Restart re-matches all non-dup rows; the re-result comes back medium.
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Other', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });
    act(() => result.current.handleRestartMatch());

    await waitFor(() => expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium'), { timeout: 5000 });
    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);
  });

  it('#1318 guard: a merely-toggled (not edited) row is still unchecked by a medium merge', async () => {
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    // Bare checkbox interaction (toggle off then on) must NOT set userEdited.
    act(() => result.current.handleToggle(nonDupIdx));
    act(() => result.current.handleToggle(nonDupIdx));
    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);
    expect(result.current.rows[nonDupIdx]!.userEdited).toBe(false);

    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await waitFor(() => expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium'), { timeout: 5000 });
    expect(result.current.rows[nonDupIdx]!.selected).toBe(false);
    expect(result.current.rows[nonDupIdx]!.userEdited).toBe(false);
    expect(result.current.reviewCount).toBe(1);
    expect(result.current.selectedCount).toBe(0);
  });

  it('garbage confidence fails closed (unchecked) for a non-userEdited row', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'garbage', bestMatch: { title: 'X', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.rows[nonDupIdx]!.matchResult).toBeDefined(), { timeout: 5000 });
    expect(result.current.rows[nonDupIdx]!.selected).toBe(false);
  });
});

describe('handleEdit — auto-check, confidence upgrade, slug-duplicate recheck (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetBookIdentifiers.mockResolvedValue([]);
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
  });

  it('unselected row with metadata attached auto-selects the row', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.handleToggle(nonDupIdx));
    expect(result.current.rows[nonDupIdx]!.selected).toBe(false);

    // Edit with metadata → auto-selects
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx]!.selected).toBe(true);
  });

  it('confidence upgrade from none to medium when metadata provided', async () => {
    // Set up match results with confidence=none
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'none',
        bestMatch: null,
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    // Edit with metadata → confidence upgrades to medium
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
  });

  // ── #335 Manual match override: medium → high ──────────────────────────
  it('confidence upgrade from medium to high when provider metadata provided', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'medium',
        bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    // Edit with provider metadata → confidence upgrades to high
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
  });

  it('confidence stays high when provider metadata provided on high-confidence row', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'high',
        bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    // Edit with provider metadata → confidence stays high
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
  });

  it('confidence stays medium when saved with preloaded metadata (no re-selection)', async () => {
    const bestMatch = { title: 'Book One', authors: [{ name: 'Author A' }] };
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'medium',
        bestMatch,
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    // Save with the SAME metadata reference (user opened modal without re-selecting)
    const preloadedMetadata = result.current.rows[nonDupIdx]!.edited.metadata;
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        ...(preloadedMetadata !== undefined && { metadata: preloadedMetadata }),
      });
    });

    // Should NOT upgrade — no explicit provider re-selection
    expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
  });

  it('confidence upgrade from medium to high when explicit click on SAME current match', async () => {
    const bestMatch = { title: 'Book One', authors: [{ name: 'Author A' }] };
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{
        path: '/audiobooks/AuthorA/Book1',
        confidence: 'medium',
        bestMatch,
        alternatives: [],
      }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    // Simulate explicit click on the current match — applyMetadata spreads to new reference
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { ...bestMatch },
      });
    });

    expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
  });

  it('slug-duplicate row: title+author still collides → stays duplicate', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    // Edit but keep same colliding title+author
    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'Book Three', author: 'Author C', series: '' });
    });

    expect(result.current.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('slug-duplicate row: title+author no longer collides → duplicate cleared', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'New Title', author: 'New Author', series: '' });
    });

    expect(result.current.rows[slugDupIdx]!.book.isDuplicate).toBe(false);
  });

  it('undefined bookIdentifiers (query not yet resolved) — no crash, guard prevents recheck', async () => {
    // Return undefined for bookIdentifiers (simulating query not yet resolved)
    mockGetBookIdentifiers.mockReturnValue(undefined as never);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    // Edit slug-duplicate row — should not crash even though bookIdentifiers is undefined
    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'New Title', author: 'New Author', series: '' });
    });

    // Row stays duplicate because the guard skipped the recheck
    expect(result.current.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  // ── #415 Match confidence reason passthrough ────────────────────────
  describe('confidence reason lifecycle (#415)', () => {
    it('mergeMatchResults preserves reason field from MatchResult onto ImportRow', async () => {
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'medium',
          bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
          alternatives: [],
          reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.step).toBe('review'));

      const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      }, { timeout: 5000 });

      expect(result.current.rows[nonDupIdx]!.matchResult?.reason).toBe(
        'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
      );
    });

    it('medium → high upgrade clears reason to undefined', async () => {
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'medium',
          bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
          alternatives: [],
          reason: 'Duration mismatch — scanned 10.0hrs vs expected 11.6hrs',
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.step).toBe('review'));

      const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      }, { timeout: 5000 });
      expect(result.current.rows[nonDupIdx]!.matchResult?.reason).toBeDefined();

      // Edit with NEW metadata → upgrades to high, reason must be cleared
      act(() => {
        result.current.handleEdit(nonDupIdx, {
          title: 'Book One', author: 'Author A', series: '',
          metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
        });
      });

      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
      expect(result.current.rows[nonDupIdx]!.matchResult?.reason).toBeUndefined();
    });

    it('none → medium upgrade does not set a reason (user-initiated)', async () => {
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'none',
          bestMatch: null,
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => expect(result.current.step).toBe('review'));

      const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
      }, { timeout: 5000 });

      // Edit with metadata → upgrades to medium, but no system reason
      act(() => {
        result.current.handleEdit(nonDupIdx, {
          title: 'Book One', author: 'Author A', series: '',
          metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
        });
      });

      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      expect(result.current.rows[nonDupIdx]!.matchResult?.reason).toBeUndefined();
    });
  });
});

describe('retry mechanics (#185)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetBookIdentifiers.mockResolvedValue([]);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
  });

  it('handleRetry resets stale offset so post-retry match results merge into rows from index 0', async () => {
    // Phase 1: initial scan + first match result arrives
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'First Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    // Wait for initial match results to merge (poll interval fires)
    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.edited.title).toBe('First Match');
    }, { timeout: 5000 });

    // Phase 2: retry — new scan + new match with different result
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-2', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Retry Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await act(async () => { result.current.handleRetry(); });
    await waitFor(() => expect(result.current.step).toBe('review'));

    // Observable: post-retry result is merged from index 0, not lost to stale offset
    const retryNonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.rows[retryNonDupIdx]!.edited.title).toBe('Retry Match');
    }, { timeout: 5000 });
  });

  it('handleRestartMatch resets stale offset so new match results merge after restart', async () => {
    // Phase 1: initial scan + match completes with none confidence
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'none', bestMatch: null, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.step).toBe('review'));

    const nonDupIdx = result.current.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    // Phase 2: Restart — new match job with different result
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-2', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Better Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    act(() => { result.current.handleRestartMatch(); });

    // Observable: post-retry result merged at index 0 — confidence upgraded and title changed
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });
    expect(result.current.rows[nonDupIdx]!.edited.title).toBe('Better Match');
  });
});

describe('empty result edge case', () => {
  it('scanError is null (not set) when emptyResult is triggered', async () => {
    mockScanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.emptyResult).toBe(true);
    });
    expect(result.current.scanError).toBeNull();
  });

  describe('within-scan duplicates — visibility and selection (#342)', () => {
    const scanResultWithWithinScan: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/audiobooks/Author/Book' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 3,
    };

    it('within-scan duplicates are auto-deselected on initial load', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      const withinScanRow = result.current.rows.find(r => r.book.duplicateReason === 'within-scan');
      expect(withinScanRow?.selected).toBe(false);
    });

    it('within-scan duplicates are included in select-all toggling', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      act(() => { result.current.handleSelectAll(); });

      const withinScanRow = result.current.rows.find(r => r.book.duplicateReason === 'within-scan');
      expect(withinScanRow?.selected).toBe(true);
    });

    it('DB duplicates (path/slug) are excluded from select-all toggling', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      act(() => { result.current.handleSelectAll(); });

      const dbDupRow = result.current.rows.find(r => r.book.duplicateReason === 'slug');
      expect(dbDupRow?.selected).toBe(false);
    });
  });

  describe('within-scan duplicates — match flow (#342)', () => {
    const scanResultMatchFlow: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/audiobooks/Author/Book' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 3,
    };

    it('initial matcher candidates include within-scan duplicates but exclude DB duplicates', async () => {
      // Must set before hook mounts (auto-scan fires on mount)
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(mockStartMatchJob).toHaveBeenCalled(); });

      const candidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string }>;
      const paths = candidates.map((c: { path: string }) => c.path);
      expect(paths).toContain('/audiobooks/Author/Book');
      expect(paths).toContain('/audiobooks/Copy/Author/Book');
      expect(paths).not.toContain('/audiobooks/DbDup/Book');
    });

    // #1849 — the parsed series position (including 0) must reach the match-start
    // candidate so the server-side position tiebreaker can run.
    it('threads parsedSeriesPosition (including 0) into the match candidate', async () => {
      const scanWithPositions: ScanResult = {
        discoveries: [
          { path: '/audiobooks/Fablehaven/01', parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: 'Fablehaven', parsedSeriesPosition: 1, fileCount: 1, totalSize: 100, isDuplicate: false },
          { path: '/audiobooks/Fablehaven/00', parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: 'Fablehaven', parsedSeriesPosition: 0, fileCount: 1, totalSize: 100, isDuplicate: false },
          { path: '/audiobooks/Standalone', parsedTitle: 'Standalone', parsedAuthor: 'Someone', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: false },
        ],
        totalFolders: 3,
      };
      mockScanDirectory.mockReset().mockResolvedValue(scanWithPositions);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(mockStartMatchJob).toHaveBeenCalled(); });

      const candidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string; seriesPosition?: number }>;
      const byPath = (p: string) => candidates.find(c => c.path === p);
      expect(byPath('/audiobooks/Fablehaven/01')?.seriesPosition).toBe(1);
      expect(byPath('/audiobooks/Fablehaven/00')?.seriesPosition).toBe(0);
      expect(byPath('/audiobooks/Standalone')).not.toHaveProperty('seriesPosition');
    });

    it('mergeMatchResults applies match data to within-scan row and seeds edited metadata', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      // Poll returns a high-confidence match for the within-scan duplicate row
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 2,
        matched: 2,
        results: [
          {
            path: '/audiobooks/Copy/Author/Book',
            confidence: 'high',
            bestMatch: { title: 'Matched Title', authors: [{ name: 'Matched Author' }], narrators: ['Jim Dale'], asin: 'B999' },
            alternatives: [],
          },
        ],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // After poll merges match results, within-scan row should have matchResult and edited metadata
      await waitFor(() => {
        const withinScanRow = result.current.rows.find(r => r.book.duplicateReason === 'within-scan');
        expect(withinScanRow?.matchResult?.confidence).toBe('high');
      }, { timeout: 5000 });

      const withinScanRow = result.current.rows.find(r => r.book.duplicateReason === 'within-scan');
      expect(withinScanRow?.edited.title).toBe('Matched Title');
      expect(withinScanRow?.edited.author).toBe('Matched Author');
      expect(withinScanRow?.edited.asin).toBe('B999');
    });

    it('mergeMatchResults with confidence=none deselects within-scan row', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 2,
        matched: 2,
        results: [
          { path: '/audiobooks/Copy/Author/Book', confidence: 'none', bestMatch: null, alternatives: [] },
        ],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Select the within-scan row first
      const withinScanIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'within-scan');
      act(() => { result.current.handleToggle(withinScanIdx); });

      // After poll merges confidence=none, the row should be deselected
      await waitFor(() => {
        const row = result.current.rows.find(r => r.book.duplicateReason === 'within-scan');
        expect(row?.matchResult?.confidence).toBe('none');
        expect(row?.selected).toBe(false);
      }, { timeout: 5000 });
    });

    it('handleRestartMatch includes within-scan rows and excludes DB duplicates', async () => {
      // Initial match attempt fails at start (paused) so we can trigger Restart
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValue({ jobId: 'job-2' });
      mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 2, matched: 2, results: [] });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.paused).toBe(true));

      // Clear call history so we can assert only the restart call
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-2' });

      // Trigger Restart
      act(() => result.current.handleRestartMatch());

      await waitFor(() => expect(mockStartMatchJob).toHaveBeenCalledTimes(1));

      const restartCandidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string }>;
      const restartPaths = restartCandidates.map((c: { path: string }) => c.path);
      expect(restartPaths).toContain('/audiobooks/Author/Book');
      expect(restartPaths).toContain('/audiobooks/Copy/Author/Book');
      expect(restartPaths).not.toContain('/audiobooks/DbDup/Book');
    });
  });

  describe('within-scan duplicates — derived state (#342)', () => {
    const scanResultMixed: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/audiobooks/Author/Book' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 3,
    };

    it('readyCount includes selected within-scan duplicates with high-confidence matches', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMixed);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      // Poll returns high-confidence match for both the non-dup and within-scan dup
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 2,
        matched: 2,
        results: [
          { path: '/audiobooks/Author/Book', confidence: 'high', bestMatch: { title: 'Book', authors: [{ name: 'Author' }], narrators: [], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/Copy/Author/Book', confidence: 'high', bestMatch: { title: 'Book', authors: [{ name: 'Author' }], narrators: [], asin: 'A2' }, alternatives: [] },
        ],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Select all actionable rows (including within-scan dup)
      act(() => { result.current.handleSelectAll(); });

      // Wait for match results to merge
      await waitFor(() => {
        expect(result.current.readyCount).toBe(2); // non-dup + within-scan dup, both selected + high confidence
      }, { timeout: 5000 });
    });

    it('pendingCount includes within-scan duplicates awaiting match results', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Within-scan dup has no matchResult yet → should count as pending
      // DB dup should NOT count as pending
      // Non-dup has no matchResult yet → should count as pending
      expect(result.current.pendingCount).toBe(2); // non-dup + within-scan dup
    });

    // #1102 — selectedPendingCount is scoped to selection, excludes DB duplicates
    it('selectedPendingCount tracks pending rows scoped to user selection', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Non-dup row is auto-selected; within-scan dup is auto-deselected.
      expect(result.current.pendingCount).toBe(2);
      expect(result.current.selectedPendingCount).toBe(1);

      // Selecting all actionable rows includes the within-scan dup → 2 pending selected.
      act(() => { result.current.handleSelectAll(); });
      expect(result.current.selectedPendingCount).toBe(2);
    });

    it('selectedPendingCount excludes DB duplicates even if forcibly selected', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Locate the DB-dup row index (slug duplicate) and force-select it via handleToggle.
      const dbDupIndex = result.current.rows.findIndex(r =>
        r.book.isDuplicate && r.book.duplicateReason !== 'within-scan',
      );
      expect(dbDupIndex).toBeGreaterThanOrEqual(0);
      act(() => { result.current.handleToggle(dbDupIndex); });
      expect(result.current.rows[dbDupIndex]!.selected).toBe(true);

      // DB dup must NOT contribute to selectedPendingCount (matches pendingCount semantics).
      expect(result.current.selectedPendingCount).toBe(1);
    });

    it('duplicateCount counts only DB duplicates', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      expect(result.current.duplicateCount).toBe(1); // only DB slug dup
    });

    it('allSelected treats within-scan duplicates as actionable', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Not all selected yet (within-scan dup is auto-deselected)
      expect(result.current.allSelected).toBe(false);

      // Select all actionable rows
      act(() => { result.current.handleSelectAll(); });

      expect(result.current.allSelected).toBe(true);
    });
  });

  describe('within-scan duplicates — registration (#342)', () => {
    it('handleRegister sends forceImport: true for selected duplicate rows', async () => {
      const scanResult: ScanResult = {
        discoveries: [
          { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
          { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/audiobooks/Author/Book' },
        ],
        totalFolders: 2,
      };
      mockScanDirectory.mockResolvedValue(scanResult);
      mockConfirmImport.mockResolvedValue({ accepted: 2, heldReview: [], skipped: [], failed: [] });
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });

      // Select all (including within-scan dup)
      act(() => { result.current.handleSelectAll(); });
      act(() => { result.current.handleRegister(); });

      await waitFor(() => { expect(mockConfirmImport).toHaveBeenCalled(); });

      const items = mockConfirmImport.mock.calls[0]![0] as Array<{ path: string; forceImport?: boolean }>;
      const nonDup = items.find(i => i.path === '/audiobooks/Author/Book');
      const withinScanDup = items.find(i => i.path === '/audiobooks/Copy/Author/Book');
      expect(nonDup?.forceImport).toBeUndefined();
      expect(withinScanDup?.forceImport).toBe(true);
    });

    it('scan with only DB duplicates still shows All caught up', async () => {
      const allDbDups: ScanResult = {
        discoveries: [
          { path: '/audiobooks/A', parsedTitle: 'A', parsedAuthor: 'X', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: true, duplicateReason: 'path' },
          { path: '/audiobooks/B', parsedTitle: 'B', parsedAuthor: 'Y', parsedSeries: null, fileCount: 1, totalSize: 100, isDuplicate: true, duplicateReason: 'slug' },
        ],
        totalFolders: 2,
      };
      mockScanDirectory.mockResolvedValue(allDbDups);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.emptyResult).toBe(true); });
    });

    it('scan with mix of new + within-scan duplicates does NOT show All caught up', async () => {
      const mixedResult: ScanResult = {
        discoveries: [
          { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
          { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: true, duplicateReason: 'within-scan', duplicateFirstPath: '/audiobooks/Author/Book' },
        ],
        totalFolders: 2,
      };
      mockScanDirectory.mockResolvedValue(mixedResult);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.step).toBe('review'); });
      expect(result.current.emptyResult).toBe(false);
    });
  });

  describe('mergeMatchResults seeds narrators + seriesPosition (#1028)', () => {
    const scanWithSingleNew: ScanResult = {
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    };

    it('seeds edited.narrators and edited.seriesPosition from bestMatch', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanWithSingleNew);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 1,
        matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'high',
          bestMatch: {
            title: 'Book One',
            authors: [{ name: 'Author A' }],
            narrators: ['Jim Dale'],
            series: [{ name: 'Discworld', position: 27 }],
          },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => { expect(result.current.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.rows[0]!.edited.narrators).toEqual(['Jim Dale']);
        expect(result.current.rows[0]!.edited.seriesPosition).toBe(27);
      }, { timeout: 5000 });
    });

    it('preserves seriesPosition: 0 from bestMatch (regression guard)', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanWithSingleNew);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 1,
        matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'high',
          bestMatch: {
            title: 'Book One',
            authors: [{ name: 'Author A' }],
            series: [{ name: 'Prequels', position: 0 }],
          },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => { expect(result.current.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.rows[0]!.edited.seriesPosition).toBe(0);
      }, { timeout: 5000 });
    });

    it('omits narrators/seriesPosition when bestMatch lacks them', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanWithSingleNew);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValue({
        id: 'job-1',
        status: 'completed',
        total: 1,
        matched: 1,
        results: [{
          path: '/audiobooks/AuthorA/Book1',
          confidence: 'high',
          bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }] },
          alternatives: [],
        }],
      });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => { expect(result.current.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.rows[0]!.matchResult?.confidence).toBe('high');
      }, { timeout: 5000 });

      expect(result.current.rows[0]!.edited).not.toHaveProperty('narrators');
      expect(result.current.rows[0]!.edited).not.toHaveProperty('seriesPosition');
    });
  });
});
