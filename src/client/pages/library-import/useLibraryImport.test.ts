import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { useLibraryImport } from './useLibraryImport';
import { ApiError } from '@/lib/api';
import type { ScanResult } from '@/lib/api';
import { createMockSettings } from '@/__tests__/factories';
import { toast } from 'sonner';
import { wireStagedComplete, acceptedRow, heldRow, skippedRow, failedRow, type StagedMockFns } from '@/lib/staged-import/__tests__/staged-fixtures';
import { __resetOutboxCache } from '@/lib/staged-import/outbox';
import { FABLEHAVEN, FABLEHAVEN_BEST, FABLEHAVEN_ALTERNATIVES, FABLEHAVEN_TRIMMED_RESPONSE, fablehavenMismatch, fablehavenEdit, deferred } from '@/lib/__tests__/repick-fixtures';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockScanDirectory = vi.fn();
const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();
const mockGetSettings = vi.fn();
const mockGetBookIdentifiers = vi.fn();
const mockCorroborateImportDuration = vi.fn();
const mockCreateSubmission = vi.fn();
const mockPutSubmissionItems = vi.fn();
const mockFinalizeSubmission = vi.fn();
const mockGetSubmission = vi.fn();
const mockGetSubmissionByClientId = vi.fn();
const stagedMocks: StagedMockFns = {
  create: mockCreateSubmission, put: mockPutSubmissionItems, finalize: mockFinalizeSubmission,
  get: mockGetSubmission, byClient: mockGetSubmissionByClientId,
};
const submittedItems = () =>
  mockPutSubmissionItems.mock.calls.flatMap(c => (c[1] as { items: { ordinal: number; item: Record<string, unknown> }[] }).items.map(r => r.item));

// Keep real exports such as ApiError; replacing the barrel would silently drop them.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
    startMatchJob: (...args: unknown[]) => mockStartMatchJob(...args),
    getMatchJob: (...args: unknown[]) => mockGetMatchJob(...args),
    cancelMatchJob: (...args: unknown[]) => mockCancelMatchJob(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    getBookIdentifiers: (...args: unknown[]) => mockGetBookIdentifiers(...args),
    corroborateImportDuration: (...args: unknown[]) => mockCorroborateImportDuration(...args),
    createImportSubmission: (...args: unknown[]) => mockCreateSubmission(...args),
    putImportSubmissionItems: (...args: unknown[]) => mockPutSubmissionItems(...args),
    finalizeImportSubmission: (...args: unknown[]) => mockFinalizeSubmission(...args),
    getImportSubmission: (...args: unknown[]) => mockGetSubmission(...args),
    getImportSubmissionByClientId: (...args: unknown[]) => mockGetSubmissionByClientId(...args),
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
    // Default to a complete staged pipeline; failure tests override individual calls.
    localStorage.clear();
    __resetOutboxCache();
    wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/AuthorA/Book1', 'Book One')] });
  });

  it('on mount with library path configured: calls api.scanDirectory, starts match job, transitions to review state', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.step).toBe('review');
    });

    expect(mockScanDirectory).toHaveBeenCalledWith('/audiobooks');
    expect(mockStartMatchJob).toHaveBeenCalled();
  });

  it('on mount without library path: no scan initiated, hasLibraryPath=false state set', async () => {
    mockGetSettings.mockResolvedValue(mockSettingsNoPath);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.hasLibraryPath).toBe(false);
    });

    expect(mockScanDirectory).not.toHaveBeenCalled();
  });

  it('settings fetch fails: shows fallback (same as missing-path state)', async () => {
    mockGetSettings.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.hasLibraryPath).toBe(false);
    });

    expect(mockScanDirectory).not.toHaveBeenCalled();
  });

  it('scan request fails: scanError state set', async () => {
    mockScanDirectory.mockRejectedValue(new Error('Permission denied'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.scanError).toBe('Permission denied');
    });
  });

  it('match results merge: confidence=none result deselects non-duplicate row; duplicate row stays unselected', async () => {
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

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupRowBefore = result.current.state.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRowBefore?.selected).toBe(true);

    await waitFor(() => {
      const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.selected).toBe(false);
    }, { timeout: 5000 });

    const pathDupRow = result.current.state.rows.find(r => r.book.duplicateReason === 'path');
    expect(pathDupRow?.selected).toBe(false);
  });

  it('post-match duplicate (F8): high-confidence result flagged isDuplicate deselects the row and excludes it from the confirm payload (#1662)', async () => {
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

    await waitFor(() => expect(result.current.state.step).toBe('review'));
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(true);

    await waitFor(() => {
      const row = result.current.state.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1');
      expect(row?.book.isDuplicate).toBe(true);
      expect(row?.book.existingBookId).toBe(421);
      expect(row?.selected).toBe(false);
    }, { timeout: 5000 });

    act(() => result.current.actions.handleRegister());
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());
    const paths = submittedItems().map(i => i.path);
    expect(paths).toContain('/audiobooks/AuthorD/Book4');
    expect(paths).not.toContain('/audiobooks/AuthorA/Book1');
  });

  it('match results merge: confidence=medium (Review) deselects non-duplicate row; reviewCount increments, selectedCount excludes it', async () => {
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

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupRowBefore = result.current.state.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRowBefore?.selected).toBe(true);

    await waitFor(() => {
      const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.matchResult?.confidence).toBe('medium');
      expect(nonDupRow?.selected).toBe(false);
    }, { timeout: 5000 });

    expect(result.current.counts.reviewCount).toBe(1);
    const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
    expect(result.current.counts.selectedCount).toBe(0);
    expect(nonDupRow?.selected).toBe(false);
  });

  it('Select All: only selects rows where isDuplicate=false', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.actions.handleToggle(nonDupIdx));

    act(() => result.current.actions.handleSelectAll());

    const pathDupRow = result.current.state.rows.find(r => r.book.duplicateReason === 'path');
    const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
    expect(pathDupRow?.selected).toBe(false);
    expect(nonDupRow?.selected).toBe(true);
  });

  it('slug-duplicate row: after editing title+author to non-colliding value, row becomes importable', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');
    expect(slugDupIdx).toBeGreaterThanOrEqual(0);

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'Different Title', author: 'Different Author', series: '' });
    });

    await waitFor(() => {
      const row = result.current.state.rows[slugDupIdx];
      expect(row!.book.isDuplicate).toBe(false);
    });
  });

  it('slug-duplicate row: case-only / colon-subtitle title change KEEPS row flagged (normalized contract #1662)', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'Book Three: A Subtitle', author: 'author c', series: '' });
    });

    await waitFor(() => expect(result.current.state.rows[slugDupIdx]!.userEdited).toBe(true));
    expect(result.current.state.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('slug-duplicate row flagged by ASIN stays flagged after non-colliding title/author edits (#1662 F5)', async () => {
    // ASIN identity outranks the edited title and author.
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: 'B0OWNEDASIN', title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'Totally Different', author: 'Someone Else', series: '', asin: 'B0OWNEDASIN' });
    });

    await waitFor(() => expect(result.current.state.rows[slugDupIdx]!.userEdited).toBe(true));
    expect(result.current.state.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('match-job start failure: pauses start-failed (no active job) instead of a raw error string (#1864)', async () => {
    mockStartMatchJob.mockRejectedValue(new Error('match server unavailable'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await waitFor(() => {
      expect(result.current.state.paused).toBe(true);
      expect(result.current.state.pausedReason).toBe('start-failed');
    });
  });

  it('handleRestartMatch: starts a new logical run with non-duplicate candidates and clears the pause (#1864)', async () => {
    mockStartMatchJob
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.paused).toBe(true));

    act(() => result.current.actions.handleRestartMatch());

    await waitFor(() => expect(result.current.state.paused).toBe(false));

    expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    const restartCandidates = mockStartMatchJob.mock.calls[1]![0] as Array<{ path: string; title: string }>;
    expect(restartCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/audiobooks/AuthorA/Book1', title: 'Book One' }),
    ]));
  });

  it('handleRestartMatch: threads edited seriesPosition (including 0) into restart candidates (#1849)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, { title: 'Book One', author: 'Author A', series: 'Fablehaven', seriesPosition: 0 });
    });

    mockStartMatchJob.mockClear();
    act(() => { result.current.actions.handleRestartMatch(); });
    await waitFor(() => { expect(mockStartMatchJob).toHaveBeenCalled(); });

    const restartCandidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string; seriesPosition?: number }>;
    const seeded = restartCandidates.find(c => c.path === '/audiobooks/AuthorA/Book1');
    expect(seeded?.seriesPosition).toBe(0);
  });

  it('recovering is true during an automatic retry backoff, activating the fail-closed gate (#1864 F1)', async () => {
    mockGetMatchJob.mockReset();
    mockGetMatchJob
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));
    await waitFor(() => expect(result.current.state.recovering).toBe(true), { timeout: 5000 });
  });

  it('Restart CLEARS already-matched rows to pending immediately (#1864 §5b/F5)', async () => {
    // clearAllMocks preserves queued once-values.
    mockGetMatchJob.mockReset();
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'X', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const idx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.state.rows[idx]!.matchResult?.confidence).toBe('high'), { timeout: 5000 });

    act(() => result.current.actions.handleRestartMatch());
    expect(result.current.state.rows[idx]!.matchResult).toBeUndefined();
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
    // clearAllMocks preserves queued once-values.
    mockGetMatchJob.mockReset();
    mockGetMatchJob
      .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 2, matched: 1, results: [b1] })
      .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))
      .mockResolvedValueOnce({ id: 'job-1', status: 'completed', total: 2, matched: 2, results: [b1, b2] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.rows.length).toBe(2));

    await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high'), { timeout: 5000 });
    await waitFor(() => expect(result.current.state.paused).toBe(true), { timeout: 5000 });
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high');

    act(() => result.current.actions.handleResumeMatch());
    await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/A/B2')?.matchResult?.confidence).toBe('high'), { timeout: 5000 });
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/A/B1')?.matchResult?.confidence).toBe('high');
    expect(result.current.state.paused).toBe(false);
  }, 20000);

  it('path-duplicate row: no edit-triggered recheck, row stays locked', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Two', authorName: 'Author B', authorSlug: 'author-b' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const pathDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'path');

    act(() => {
      result.current.actions.handleEdit(pathDupIdx, { title: 'Totally Different', author: 'New Author', series: '' });
    });

    await waitFor(() => {
      const row = result.current.state.rows[pathDupIdx];
      expect(row!.book.isDuplicate).toBe(true);
      expect(row!.book.duplicateReason).toBe('path');
    });
  });

  it('Register: createImportSubmission called with source=library, no mode, and the shaped items', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());

    expect(mockCreateSubmission.mock.calls[0]![0]).toMatchObject({ source: 'library' });
    expect(mockCreateSubmission.mock.calls[0]![0]).not.toHaveProperty('mode');
    expect(submittedItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/audiobooks/AuthorA/Book1', title: 'Book One', authorName: 'Author A' }),
    ]));
  });

  it('poll surfacing heldReview stores the held items, stays on the page, and warns (#1711 F1)', async () => {
    const heldPath = '/audiobooks/AuthorA/Book1';
    wireStagedComplete(stagedMocks, { source: 'library', items: [heldRow(0, heldPath, 'Book One')] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });

    await waitFor(() => expect(result.current.state.heldReview).toHaveLength(1));
    expect(result.current.state.heldReview[0]!.path).toBe(heldPath);
    expect(result.current.state.heldReview[0]!.reason).toBe('recording-review-required');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
  });

  it('handleReconfirmHeld re-submits the held rows with forceImport=true (#1711 F1)', async () => {
    const heldPath = '/audiobooks/AuthorA/Book1';
    wireStagedComplete(stagedMocks, { source: 'library', items: [heldRow(0, heldPath, 'Book One')] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(result.current.state.heldReview).toHaveLength(1));

    mockPutSubmissionItems.mockClear();
    wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, heldPath, 'Book One')] });
    await act(async () => { result.current.actions.handleReconfirmHeld(); });

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/library'));
    expect(submittedItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: heldPath, forceImport: true }),
    ]));
  });

  it('handleRegister forwards edited.narrators and seriesPosition (#1028)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, { title: 'Book One', author: 'Author A', series: 'Discworld', narrators: ['Jim Dale'], seriesPosition: 27 });
    });

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());

    expect(submittedItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ narrators: ['Jim Dale'], seriesPosition: 27 }),
    ]));
  });

  it('handleRegister forwards seriesPosition: 0 (regression guard) (#1028)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, { title: 'Book One', author: 'Author A', series: 'Series', seriesPosition: 0 });
    });

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());
    const found = submittedItems().find(b => b.path === '/audiobooks/AuthorA/Book1');
    expect(found?.seriesPosition).toBe(0);
  });

  it('parser-seeded parsedSeriesPosition flows from scan to the staged payload (#1042)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/Author/Series/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: 'Series', parsedSeriesPosition: 2.5, fileCount: 1, totalSize: 1000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));
    expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(2.5);

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());
    expect(submittedItems()[0]!.seriesPosition).toBe(2.5);
  });

  it('handleRegister does not forward narrators when empty array (#1028)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, { title: 'Book One', author: 'Author A', series: '', narrators: [] });
    });

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(mockCreateSubmission).toHaveBeenCalled());
    const found = submittedItems().find(b => b.path === '/audiobooks/AuthorA/Book1');
    expect(found).not.toHaveProperty('narrators');
  });

  it('all-skipped completion shows amber, no green, no navigate (#1822)', async () => {
    wireStagedComplete(stagedMocks, { source: 'library', items: [skippedRow(0, '/audiobooks/AuthorA/Book1', 'Book One')] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('1 already in your library'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('all-failed completion shows red, no green, no navigate (#1822)', async () => {
    wireStagedComplete(stagedMocks, { source: 'library', items: [failedRow(0, '/audiobooks/AuthorA/Book1', 'Book One')] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 failed'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('held + failed completion surfaces the failure (regression pin for the early-return swallow) (#1822)', async () => {
    wireStagedComplete(stagedMocks, {
      source: 'library',
      items: [heldRow(0, '/audiobooks/AuthorA/Book1', 'Book One'), failedRow(1, '/audiobooks/AuthorA/Book1b', 'Book One B')],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(result.current.state.heldReview).toHaveLength(1));

    expect(toast.warning).toHaveBeenCalledWith('1 held for recording review');
    expect(toast.error).toHaveBeenCalledWith('1 failed');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('partial completion (accepted + skipped) stays on the page and deselects the accepted rows (#1822)', async () => {
    mockScanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 2, totalSize: 80000, isDuplicate: false },
      ],
      totalFolders: 2,
    });
    wireStagedComplete(stagedMocks, {
      source: 'library',
      items: [acceptedRow(0, '/audiobooks/AuthorA/Book1', 'Book One'), skippedRow(1, '/audiobooks/AuthorB/Book2', 'Book Two')],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));
    await waitFor(() => expect(result.current.state.rows).toHaveLength(2));

    await act(async () => { result.current.actions.handleRegister(); });
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('1 registered · 1 already in your library'));
    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(false));
  });

  it('create failure surfaces a recoverable banner and does not navigate (F9)', async () => {
    mockCreateSubmission.mockRejectedValue(new ApiError(400, { error: 'invalid-body' }));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));
    await act(async () => { result.current.actions.handleRegister(); });

    await waitFor(() => expect(result.current.state.banner).toBeTruthy());
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('permanent PUT failure stops the upload, keeps rows selected, does not finalize or navigate (F10)', async () => {
    mockPutSubmissionItems.mockRejectedValue(new ApiError(409, { error: 'submission-not-receiving' }));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));
    await act(async () => { result.current.actions.handleRegister(); });

    await waitFor(() => expect(result.current.state.banner).toBeTruthy());
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(true);
  });

  it('an all-oversize selection is refused pre-create with the too-large banner, rows stay selected (F17/F39)', async () => {
    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const idx = result.current.state.rows.findIndex(r => r.book.path === '/audiobooks/AuthorA/Book1');
    const oversizeMeta = { title: 'Book One', authors: [{ name: 'x'.repeat(513) }] } as unknown as import('@/lib/api').BookMetadata;
    act(() => result.current.actions.handleEdit(idx, { title: 'Book One', author: 'Author A', series: '', metadata: oversizeMeta }));

    act(() => result.current.actions.handleRegister());

    await waitFor(() => expect(result.current.state.banner).toMatch(/too large/i));
    expect(mockCreateSubmission).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(result.current.state.rows.find(r => r.book.path === '/audiobooks/AuthorA/Book1')?.selected).toBe(true);
  });

  it('returns emptyResult=true when scan returns zero discoveries', async () => {
    mockScanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.emptyResult).toBe(true);
    });
    expect(result.current.state.scanError).toBeNull();
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
      expect(result.current.state.emptyResult).toBe(true);
    });
    expect(result.current.state.scanError).toBeNull();
    expect(mockStartMatchJob).not.toHaveBeenCalled();
  });

  it('returns emptyResult=false and starts matching when scan returns mix of new and duplicate books', async () => {
    mockScanDirectory.mockResolvedValue(mockScanResult);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.step).toBe('review');
    });
    expect(result.current.state.emptyResult).toBe(false);
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

      await waitFor(() => expect(result.current.state.step).toBe('review'));

      const row = result.current.state.rows.find(r => !!r.book.reviewReason);
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.actions.handleToggle(nonDupIdx));
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(false);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(false);
  });

  it('high confidence keeps a default (still-checked) non-duplicate row selected', async () => {
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    await waitFor(() => {
      const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
      expect(nonDupRow?.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    const nonDupRow = result.current.state.rows.find(r => !r.book.isDuplicate);
    expect(nonDupRow?.selected).toBe(true);
    expect(result.current.counts.readyCount).toBe(1);
  });

  it('edit-during-matching preserves selection: a user-FIXED row stays checked when a later medium match merges (#1374)', async () => {
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Corrected Title', author: 'Author A', series: '',
        metadata: { title: 'Corrected Title', authors: [{ name: 'Author A' }] },
      });
    });
    expect(result.current.state.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);

    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);
    expect(result.current.state.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.counts.selectedCount).toBeGreaterThanOrEqual(1);
  });

  it('Retry Match preserves a user-FIXED row: a re-result at medium does not uncheck it (#1374)', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high'), { timeout: 5000 });

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Corrected', author: 'Author A', series: '',
        metadata: { title: 'Corrected', authors: [{ name: 'Author A' }] },
      });
    });
    expect(result.current.state.rows[nonDupIdx]!.userEdited).toBe(true);
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);

    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Other', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });
    act(() => result.current.actions.handleRestartMatch());

    await waitFor(() => expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium'), { timeout: 5000 });
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);
  });

  it('#1318 guard: a merely-toggled (not edited) row is still unchecked by a medium merge', async () => {
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.actions.handleToggle(nonDupIdx));
    act(() => result.current.actions.handleToggle(nonDupIdx));
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);
    expect(result.current.state.rows[nonDupIdx]!.userEdited).toBe(false);

    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'medium', bestMatch: { title: 'Official', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await waitFor(() => expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium'), { timeout: 5000 });
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(false);
    expect(result.current.state.rows[nonDupIdx]!.userEdited).toBe(false);
    expect(result.current.counts.reviewCount).toBe(1);
    expect(result.current.counts.selectedCount).toBe(0);
  });

  it('garbage confidence fails closed (unchecked) for a non-userEdited row', async () => {
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'garbage', bestMatch: { title: 'X', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => expect(result.current.state.rows[nonDupIdx]!.matchResult).toBeDefined(), { timeout: 5000 });
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(false);
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    act(() => result.current.actions.handleToggle(nonDupIdx));
    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(false);

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.selected).toBe(true);
  });

  it('confidence upgrade from none to medium when metadata provided', async () => {
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
  });

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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    const preloadedMetadata = result.current.state.rows[nonDupIdx]!.edited.metadata;
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        ...(preloadedMetadata !== undefined && { metadata: preloadedMetadata }),
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
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
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
    }, { timeout: 5000 });

    // applyMetadata creates a new reference for an explicit pick.
    act(() => {
      result.current.actions.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { ...bestMatch },
      });
    });

    expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
  });

  it('slug-duplicate row: title+author still collides → stays duplicate', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'Book Three', author: 'Author C', series: '' });
    });

    expect(result.current.state.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

  it('slug-duplicate row: title+author no longer collides → duplicate cleared', async () => {
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'New Title', author: 'New Author', series: '' });
    });

    expect(result.current.state.rows[slugDupIdx]!.book.isDuplicate).toBe(false);
  });

  it('undefined bookIdentifiers (query not yet resolved) — no crash, guard prevents recheck', async () => {
    mockGetBookIdentifiers.mockReturnValue(undefined as never);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const slugDupIdx = result.current.state.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.actions.handleEdit(slugDupIdx, { title: 'New Title', author: 'New Author', series: '' });
    });

    expect(result.current.state.rows[slugDupIdx]!.book.isDuplicate).toBe(true);
  });

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
      await waitFor(() => expect(result.current.state.step).toBe('review'));

      const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      }, { timeout: 5000 });

      expect(result.current.state.rows[nonDupIdx]!.matchResult?.reason).toBe(
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
      await waitFor(() => expect(result.current.state.step).toBe('review'));

      const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      }, { timeout: 5000 });
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.reason).toBeDefined();

      act(() => {
        result.current.actions.handleEdit(nonDupIdx, {
          title: 'Book One', author: 'Author A', series: '',
          metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
        });
      });

      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.reason).toBeUndefined();
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
      await waitFor(() => expect(result.current.state.step).toBe('review'));

      const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
      await waitFor(() => {
        expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
      }, { timeout: 5000 });

      act(() => {
        result.current.actions.handleEdit(nonDupIdx, {
          title: 'Book One', author: 'Author A', series: '',
          metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
        });
      });

      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('medium');
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.reason).toBeUndefined();
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
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'First Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.edited.title).toBe('First Match');
    }, { timeout: 5000 });

    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-2', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Retry Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    await act(async () => { result.current.actions.handleRetry(); });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const retryNonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.state.rows[retryNonDupIdx]!.edited.title).toBe('Retry Match');
    }, { timeout: 5000 });
  });

  it('handleRestartMatch resets stale offset so new match results merge after restart', async () => {
    mockScanDirectory.mockResolvedValue(mockScanResult);
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'none', bestMatch: null, alternatives: [] }],
    });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.state.step).toBe('review'));

    const nonDupIdx = result.current.state.rows.findIndex(r => !r.book.isDuplicate);
    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-2', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Better Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    act(() => { result.current.actions.handleRestartMatch(); });

    await waitFor(() => {
      expect(result.current.state.rows[nonDupIdx]!.matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });
    expect(result.current.state.rows[nonDupIdx]!.edited.title).toBe('Better Match');
  });
});

describe('empty result edge case', () => {
  it('scanError is null (not set) when emptyResult is triggered', async () => {
    mockScanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.state.emptyResult).toBe(true);
    });
    expect(result.current.state.scanError).toBeNull();
  });

  describe('former within-scan rows — visibility and selection (#1925)', () => {
    const scanResultWithWithinScan: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 3,
    };

    it('a former within-scan row is default-selected on initial load (#1925 AC4)', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      const withinScanRow = result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
      expect(withinScanRow?.selected).toBe(true);
    });

    it('former within-scan rows participate in select-all toggling', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      const findWs = () => result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
      expect(findWs()?.selected).toBe(true);
      act(() => { result.current.actions.handleSelectAll(); });
      expect(findWs()?.selected).toBe(false);
      act(() => { result.current.actions.handleSelectAll(); });
      expect(findWs()?.selected).toBe(true);
    });

    it('DB duplicates (path/slug) are excluded from select-all toggling', async () => {
      mockScanDirectory.mockResolvedValue(scanResultWithWithinScan);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      act(() => { result.current.actions.handleSelectAll(); });

      const dbDupRow = result.current.state.rows.find(r => r.book.duplicateReason === 'slug');
      expect(dbDupRow?.selected).toBe(false);
    });
  });

  describe('former within-scan rows — match flow (#1925)', () => {
    const scanResultMatchFlow: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 3,
    };

    it('initial matcher candidates include former within-scan rows but exclude DB duplicates', async () => {
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

    it('mergeMatchResults applies match data to a former within-scan row and seeds edited metadata', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
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

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      await waitFor(() => {
        const withinScanRow = result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
        expect(withinScanRow?.matchResult?.confidence).toBe('high');
      }, { timeout: 5000 });

      const withinScanRow = result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
      expect(withinScanRow?.edited.title).toBe('Matched Title');
      expect(withinScanRow?.edited.author).toBe('Matched Author');
      expect(withinScanRow?.edited.asin).toBe('B999');
    });

    it('mergeMatchResults with confidence=none deselects a former within-scan row', async () => {
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

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      const initial = result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
      expect(initial?.selected).toBe(true);

      await waitFor(() => {
        const row = result.current.state.rows.find(r => r.book.path === '/audiobooks/Copy/Author/Book');
        expect(row?.matchResult?.confidence).toBe('none');
        expect(row?.selected).toBe(false);
      }, { timeout: 5000 });
    });

    it('handleRestartMatch includes former within-scan rows and excludes DB duplicates', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMatchFlow);
      mockStartMatchJob
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValue({ jobId: 'job-2' });
      mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 2, matched: 2, results: [] });

      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.state.paused).toBe(true));

      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-2' });

      act(() => result.current.actions.handleRestartMatch());

      await waitFor(() => expect(mockStartMatchJob).toHaveBeenCalledTimes(1));

      const restartCandidates = mockStartMatchJob.mock.calls[0]![0] as Array<{ path: string }>;
      const restartPaths = restartCandidates.map((c: { path: string }) => c.path);
      expect(restartPaths).toContain('/audiobooks/Author/Book');
      expect(restartPaths).toContain('/audiobooks/Copy/Author/Book');
      expect(restartPaths).not.toContain('/audiobooks/DbDup/Book');
    });
  });

  describe('former within-scan rows — derived state (#1925)', () => {
    const scanResultMixed: ScanResult = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        { path: '/audiobooks/DbDup/Book', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 3,
    };

    it('readyCount includes selected former within-scan rows with high-confidence matches', async () => {
      mockScanDirectory.mockReset().mockResolvedValue(scanResultMixed);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
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

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.counts.readyCount).toBe(2);
      }, { timeout: 5000 });
    });

    it('pendingCount includes former within-scan rows awaiting match results', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      expect(result.current.counts.pendingCount).toBe(2);
    });

    it('selectedPendingCount tracks pending rows scoped to user selection', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      expect(result.current.counts.pendingCount).toBe(2);
      expect(result.current.counts.selectedPendingCount).toBe(2);
    });

    it('selectedPendingCount excludes DB duplicates even if forcibly selected', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      const dbDupIndex = result.current.state.rows.findIndex(r =>
        r.book.isDuplicate && r.book.duplicateReason === 'slug',
      );
      expect(dbDupIndex).toBeGreaterThanOrEqual(0);
      act(() => { result.current.actions.handleToggle(dbDupIndex); });
      expect(result.current.state.rows[dbDupIndex]!.selected).toBe(true);

      expect(result.current.counts.selectedPendingCount).toBe(2);
    });

    it('duplicateCount counts only DB duplicates', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      expect(result.current.counts.duplicateCount).toBe(1);
    });

    it('allSelected treats former within-scan rows as actionable', async () => {
      mockScanDirectory.mockResolvedValue(scanResultMixed);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      expect(result.current.counts.allSelected).toBe(true);

      const withinScanIdx = result.current.state.rows.findIndex(r => r.book.path === '/audiobooks/Copy/Author/Book');
      act(() => { result.current.actions.handleToggle(withinScanIdx); });
      expect(result.current.counts.allSelected).toBe(false);

      act(() => { result.current.actions.handleSelectAll(); });
      expect(result.current.counts.allSelected).toBe(true);
    });
  });

  describe('former within-scan rows — registration (#1925)', () => {
    it('handleRegister omits forceImport for a selected former within-scan row (#1925 AC5)', async () => {
      const scanResult: ScanResult = {
        discoveries: [
          { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
          { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        ],
        totalFolders: 2,
      };
      mockScanDirectory.mockResolvedValue(scanResult);
      wireStagedComplete(stagedMocks, {
        source: 'library',
        items: [acceptedRow(0, '/audiobooks/Author/Book', 'Book'), acceptedRow(1, '/audiobooks/Copy/Author/Book', 'Book')],
      });
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      act(() => { result.current.actions.handleRegister(); });

      await waitFor(() => { expect(mockCreateSubmission).toHaveBeenCalled(); });

      const items = submittedItems() as Array<{ path: string; forceImport?: boolean }>;
      const nonDup = items.find(i => i.path === '/audiobooks/Author/Book');
      const withinScanRow = items.find(i => i.path === '/audiobooks/Copy/Author/Book');
      expect(nonDup?.forceImport).toBeUndefined();
      expect(withinScanRow?.forceImport).toBeUndefined();
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

      await waitFor(() => { expect(result.current.state.emptyResult).toBe(true); });
    });

    it('scan with mix of new + former within-scan rows does NOT show All caught up', async () => {
      const mixedResult: ScanResult = {
        discoveries: [
          { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
          { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        ],
        totalFolders: 2,
      };
      mockScanDirectory.mockResolvedValue(mixedResult);
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

      await waitFor(() => { expect(result.current.state.step).toBe('review'); });
      expect(result.current.state.emptyResult).toBe(false);
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
      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.state.rows[0]!.edited.narrators).toEqual(['Jim Dale']);
        expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(27);
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
      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.state.rows[0]!.edited.seriesPosition).toBe(0);
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
      await waitFor(() => { expect(result.current.state.step).toBe('review'); });

      await waitFor(() => {
        expect(result.current.state.rows[0]!.matchResult?.confidence).toBe('high');
      }, { timeout: 5000 });

      expect(result.current.state.rows[0]!.edited).not.toHaveProperty('narrators');
      expect(result.current.state.rows[0]!.edited).not.toHaveProperty('seriesPosition');
    });
  });

  describe('#1929 re-pick re-evaluates duration evidence (library surface)', () => {
    const scanWithSingleNew: ScanResult = {
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    };
    const durationMismatchResult = {
      path: '/audiobooks/AuthorA/Book1',
      confidence: 'medium' as const,
      bestMatch: { title: 'Official', authors: [{ name: 'Author A' }], duration: 898 },
      alternatives: [],
      reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
      reasonKind: 'duration-mismatch' as const,
      scannedSeconds: 53580,
    };

    async function seedMismatchRow() {
      mockScanDirectory.mockReset().mockResolvedValue(scanWithSingleNew);
      mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'completed', total: 1, matched: 1, results: [durationMismatchResult] });
      const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
      await waitFor(() => { expect(result.current.state.step).toBe('review'); });
      await waitFor(() => { expect(result.current.state.rows[0]!.matchResult?.reasonKind).toBe('duration-mismatch'); }, { timeout: 5000 });
      return result;
    }

    it('re-picking the SAME (out-of-band) edition keeps the row in Review, not green', async () => {
      const result = await seedMismatchRow();

      // The modal returns a fresh metadata object even when the same edition is selected.
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Official', author: 'Author A', series: '',
          metadata: { title: 'Official', authors: [{ name: 'Author A' }], duration: 898 },
        });
      });

      const match = result.current.state.rows[0]!.matchResult;
      expect(match?.confidence).toBe('medium');
      expect(match?.reasonKind).toBe('duration-mismatch');
      expect(match?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
      expect(match?.scannedSeconds).toBe(53580);
    });

    it('re-picking an in-band edition legitimately clears the row to Matched', async () => {
      const result = await seedMismatchRow();

      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Official', author: 'Author A', series: '',
          metadata: { title: 'Official', authors: [{ name: 'Author A' }], duration: 894 },
        });
      });

      const match = result.current.state.rows[0]!.matchResult;
      expect(match?.confidence).toBe('high');
      expect(match?.reason).toBeUndefined();
      expect(match?.reasonKind).toBeUndefined();
      expect(match?.scannedSeconds).toBe(53580);
    });
  });
});

// Re-pick uses the same chapter-runtime second opinion as the match job and Manual Import.
describe('#2055 re-pick corroborates against the chapter runtime (library surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue(mockSettings);
    mockGetBookIdentifiers.mockResolvedValue([]);
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
    localStorage.clear();
    __resetOutboxCache();
    wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/AuthorA/Book1', 'Fablehaven')] });
  });

  const PATH = '/audiobooks/AuthorA/Book1';
  const PATH2 = '/audiobooks/AuthorB/Book2';

  const discovery = (path: string, title: string) => ({
    path, parsedTitle: title, parsedAuthor: 'Brandon Mull', parsedSeries: null,
    fileCount: 3, totalSize: 100000, isDuplicate: false,
  });
  const scanOne: ScanResult = { discoveries: [discovery(PATH, 'Fablehaven')], totalFolders: 1 };
  const scanTwo: ScanResult = { discoveries: [discovery(PATH, 'Fablehaven'), discovery(PATH2, 'Fablehaven Two')], totalFolders: 2 };

  async function seed(scan: ScanResult = scanOne, results = [fablehavenMismatch(PATH)]) {
    mockScanDirectory.mockReset().mockResolvedValue(scan);
    mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'completed', total: results.length, matched: results.length, results });
    const view = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });
    await waitFor(() => { expect(view.result.current.state.step).toBe('review'); });
    await waitFor(() => {
      expect(view.result.current.state.rows[0]!.matchResult?.reasonKind).toBe('duration-mismatch');
    }, { timeout: 5000 });
    return view;
  }

  const matchAt = (result: ReturnType<typeof renderHook<ReturnType<typeof useLibraryImport>, unknown>>['result'], i = 0) =>
    result.current.state.rows[i]!.matchResult;

  beforeEach(() => {
    mockCorroborateImportDuration.mockResolvedValue({ corroborated: false });
  });

  it('promotes the row to Matched when the chapter table corroborates the scanned file', async () => {
    const gate = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValue(gate.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });

    expect(matchAt(result)?.confidence).toBe('medium');
    expect(matchAt(result)?.reason).toBe(FABLEHAVEN.scalarReason);
    expect(mockCorroborateImportDuration).toHaveBeenCalledWith({
      asin: FABLEHAVEN.asin, scannedSeconds: FABLEHAVEN.scannedSeconds,
    });

    gate.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await waitFor(() => { expect(matchAt(result)?.confidence).toBe('high'); });

    expect(matchAt(result)?.reason).toBeUndefined();
    expect(matchAt(result)?.reasonKind).toBeUndefined();
    expect(matchAt(result)?.scannedSeconds).toBe(FABLEHAVEN.scannedSeconds);
    expect(matchAt(result)?.bestMatch).toEqual(FABLEHAVEN_BEST);
    expect(matchAt(result)?.alternatives).toEqual(FABLEHAVEN_ALTERNATIVES);
  });

  it('promotes the row when the server suppressed via the TRIMMED chapter sum', async () => {
    const gate = deferred<typeof FABLEHAVEN_TRIMMED_RESPONSE>();
    mockCorroborateImportDuration.mockReturnValue(gate.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    expect(matchAt(result)?.confidence).toBe('medium');

    gate.resolve(FABLEHAVEN_TRIMMED_RESPONSE);
    await waitFor(() => { expect(matchAt(result)?.confidence).toBe('high'); });

    expect(matchAt(result)?.reason).toBeUndefined();
    expect(matchAt(result)?.reasonKind).toBeUndefined();
    expect(matchAt(result)?.bestMatch).toEqual(FABLEHAVEN_BEST);
    expect(matchAt(result)?.alternatives).toEqual(FABLEHAVEN_ALTERNATIVES);
  });

  it('sends the TRIMMED ASIN and still promotes the row when it resolves', async () => {
    const gate = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValue(gate.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit({ asin: `  ${FABLEHAVEN.asin}  ` })); });

    expect(mockCorroborateImportDuration).toHaveBeenCalledWith({
      asin: FABLEHAVEN.asin, scannedSeconds: FABLEHAVEN.scannedSeconds,
    });

    gate.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await waitFor(() => { expect(matchAt(result)?.confidence).toBe('high'); });
  });

  it('leaves the sync verdict untouched when the chapter table also disagrees', async () => {
    mockCorroborateImportDuration.mockResolvedValue({
      corroborated: false, chapterSeconds: FABLEHAVEN.outOfBandChapterSeconds,
    });
    const { result } = await seed();
    const bannerBefore = result.current.state.banner;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();

    await act(async () => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    await waitFor(() => { expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(1); });
    await act(async () => { await Promise.resolve(); });

    expect(matchAt(result)?.confidence).toBe('medium');
    expect(matchAt(result)?.reasonKind).toBe('duration-mismatch');
    expect(matchAt(result)?.reason).toBe(FABLEHAVEN.scalarReason);
    expect(matchAt(result)?.reason).not.toContain('11h 6m');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.state.banner).toEqual(bannerBefore);
  });

  it.each([
    ['a network failure', new Error('network down')],
    ['a non-2xx ApiError', new ApiError(503, { error: 'unavailable' })],
  ])('leaves the sync verdict untouched and stays silent on %s', async (_label, failure) => {
    mockCorroborateImportDuration.mockRejectedValue(failure);
    const { result } = await seed();
    const bannerBefore = result.current.state.banner;
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();

    await act(async () => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    await waitFor(() => { expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(1); });
    await act(async () => { await Promise.resolve(); });

    expect(matchAt(result)?.confidence).toBe('medium');
    expect(matchAt(result)?.reasonKind).toBe('duration-mismatch');
    expect(matchAt(result)?.reason).toBe(FABLEHAVEN.scalarReason);
    expect(result.current.state.scanError).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.state.banner).toEqual(bannerBefore);
  });

  it('issues exactly one request per qualifying re-pick under StrictMode', async () => {
    const inner = createWrapper();
    const strictWrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(inner, null, React.createElement(React.StrictMode, null, children));

    mockScanDirectory.mockReset().mockResolvedValue(scanOne);
    mockStartMatchJob.mockClear().mockResolvedValue({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'completed', total: 1, matched: 1, results: [fablehavenMismatch(PATH)] });
    const { result } = renderHook(() => useLibraryImport(), { wrapper: strictWrapper });
    await waitFor(() => { expect(result.current.state.step).toBe('review'); });
    await waitFor(() => { expect(matchAt(result)?.reasonKind).toBe('duration-mismatch'); }, { timeout: 5000 });

    await act(async () => { result.current.actions.handleEdit(0, fablehavenEdit()); });

    expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an in-band re-pick the sync path already cleared', () => fablehavenEdit({ duration: 553 })],
    ['a picked edition with no runtime (missing-duration)', () => fablehavenEdit({ duration: undefined })],
    ['a picked edition with no ASIN', () => fablehavenEdit({ asin: undefined })],
  ])('issues no request for %s', async (_label, buildEdit) => {
    const { result } = await seed();

    await act(async () => { result.current.actions.handleEdit(0, buildEdit()); });

    expect(mockCorroborateImportDuration).not.toHaveBeenCalled();
  });

  it('issues no request for the by-reference no-op', async () => {
    const { result } = await seed();
    const sameRef = result.current.state.rows[0]!.edited.metadata!;

    await act(async () => {
      result.current.actions.handleEdit(0, { title: 'Fablehaven', author: 'Brandon Mull', series: '', metadata: sameRef });
    });

    expect(mockCorroborateImportDuration).not.toHaveBeenCalled();
  });

  it('drops a held response after the user re-picks a DIFFERENT edition', async () => {
    const first = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    const second = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    act(() => { result.current.actions.handleEdit(0, fablehavenEdit({ asin: 'B00ALT00002', duration: 540 })); });
    expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(2);

    second.resolve({ corroborated: false, chapterSeconds: FABLEHAVEN.outOfBandChapterSeconds });
    await act(async () => { await Promise.resolve(); });
    first.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(matchAt(result)?.confidence).toBe('medium');
    expect(matchAt(result)?.reasonKind).toBe('duration-mismatch');
  });

  // Restart can reproduce every evidence field, so only the generation stamp rejects this response.
  it('drops a held response across a Restart that reproduces the same evidence fingerprint', async () => {
    const held = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValue(held.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(1);

    mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [fablehavenMismatch(PATH)] });
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    await act(async () => { result.current.actions.handleRestartMatch(); });
    await waitFor(() => { expect(matchAt(result)?.reasonKind).toBe('duration-mismatch'); }, { timeout: 5000 });

    expect(result.current.state.rows[0]!.edited.metadata?.asin).toBe(FABLEHAVEN.asin);
    expect(matchAt(result)?.scannedSeconds).toBe(FABLEHAVEN.scannedSeconds);

    held.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(matchAt(result)?.confidence).toBe('medium');
    expect(matchAt(result)?.reasonKind).toBe('duration-mismatch');
  });

  // Row state is unobservable after unmount; toasts expose lifecycle-local side effects.
  it('settles after unmount without emitting any lifecycle-local side effect', async () => {
    const held = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValue(held.promise);
    const { result, unmount } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();

    unmount();
    held.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  // The path half of this guard is covered in repick-corroboration.test.ts.
  it('patches only the row whose corroboration resolved', async () => {
    mockCorroborateImportDuration.mockResolvedValue({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    const { result } = await seed(scanTwo, [fablehavenMismatch(PATH), fablehavenMismatch(PATH2)]);
    await waitFor(() => { expect(matchAt(result, 1)?.reasonKind).toBe('duration-mismatch'); }, { timeout: 5000 });
    const otherBefore = result.current.state.rows[1]!;

    await act(async () => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    await waitFor(() => { expect(matchAt(result)?.confidence).toBe('high'); });

    expect(result.current.state.rows[1]).toBe(otherBefore);
  });

  // Selection changes must not advance the generation or reject a still-valid corroboration.
  it('keeps a held response live across an unrelated selection toggle', async () => {
    const held = deferred<{ corroborated: boolean; chapterSeconds?: number }>();
    mockCorroborateImportDuration.mockReturnValue(held.promise);
    const { result } = await seed();

    act(() => { result.current.actions.handleEdit(0, fablehavenEdit()); });
    expect(mockCorroborateImportDuration).toHaveBeenCalledTimes(1);

    const selectedBefore = result.current.state.rows[0]!.selected;
    act(() => { result.current.actions.handleToggle(0); });
    expect(result.current.state.rows[0]!.selected).toBe(!selectedBefore);

    held.resolve({ corroborated: true, chapterSeconds: FABLEHAVEN.chapterSeconds });
    await waitFor(() => { expect(matchAt(result)?.confidence).toBe('high'); });
  });
});
