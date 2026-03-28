import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { useLibraryImport } from './useLibraryImport';
import type { ScanResult } from '@/lib/api';
import { createMockSettings } from '@/__tests__/factories';
import { toast } from 'sonner';

const mockScanDirectory = vi.fn();
const mockConfirmImport = vi.fn();
const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();
const mockGetSettings = vi.fn();
const mockGetBookIdentifiers = vi.fn();

vi.mock('@/lib/api', () => ({
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
  toast: { success: vi.fn(), error: vi.fn() },
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
      expect(row.book.isDuplicate).toBe(false);
    });
  });

  it('slug-duplicate row: case-only title change unlocks row (exact title equality contract)', async () => {
    // Existing book has title 'Book Three' (mixed case). Editing to 'book three' (all lowercase)
    // must NOT collide because exact equality 'book three' !== 'Book Three'.
    mockGetBookIdentifiers.mockResolvedValue([
      { asin: null, title: 'Book Three', authorName: 'Author C', authorSlug: 'author-c' },
    ]);

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    const slugDupIdx = result.current.rows.findIndex(r => r.book.duplicateReason === 'slug');

    act(() => {
      result.current.handleEdit(slugDupIdx, { title: 'book three', author: 'Author C', series: '' });
    });

    await waitFor(() => {
      const row = result.current.rows[slugDupIdx];
      expect(row.book.isDuplicate).toBe(false);
    });
  });

  it('match-job failure: matchJobError is set after startMatchJob rejects', async () => {
    mockStartMatchJob.mockRejectedValue(new Error('match server unavailable'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    await waitFor(() => {
      expect(result.current.matchJobError).toBe('match server unavailable');
    });
  });

  it('handleRetryMatch: starts a new match job with non-duplicate candidates and clears error', async () => {
    // Initial attempt fails
    mockStartMatchJob
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [] });

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.matchJobError).toBe('first failure'));

    // Retry
    act(() => result.current.handleRetryMatch());

    // Error clears immediately because startMatching sets error=null before the async call
    await waitFor(() => expect(result.current.matchJobError).toBeNull());

    // startMatchJob called twice: initial scan + retry
    expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    // Retry call contains the non-duplicate candidate
    const retryCandidates = mockStartMatchJob.mock.calls[1][0] as Array<{ path: string; title: string }>;
    expect(retryCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/audiobooks/AuthorA/Book1', title: 'Book One' }),
    ]));
  });

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
      expect(row.book.isDuplicate).toBe(true);
      expect(row.book.duplicateReason).toBe('path');
    });
  });

  it('Register call: confirmImport called with correct items payload and no mode', async () => {
    mockConfirmImport.mockResolvedValue({ accepted: 1 });

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

  it('Register error path: toast.error shown when confirmImport rejects', async () => {
    mockConfirmImport.mockRejectedValue(new Error('network failure'));

    const { result } = renderHook(() => useLibraryImport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.step).toBe('review'));

    await act(async () => { result.current.handleRegister(); });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Registration failed: network failure');
    });
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

  it('high/medium confidence preserves existing row.selected value (no auto-select)', async () => {
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
    expect(result.current.rows[nonDupIdx].selected).toBe(false);

    // Match result with high confidence merges — should NOT auto-select
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx].matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });

    expect(result.current.rows[nonDupIdx].selected).toBe(false);
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
    expect(result.current.rows[nonDupIdx].selected).toBe(false);

    // Edit with metadata → auto-selects
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx].selected).toBe(true);
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
      expect(result.current.rows[nonDupIdx].matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    // Edit with metadata → confidence upgrades to medium
    act(() => {
      result.current.handleEdit(nonDupIdx, {
        title: 'Book One', author: 'Author A', series: '',
        metadata: { title: 'Book One', authors: [{ name: 'Author A' }] },
      });
    });

    expect(result.current.rows[nonDupIdx].matchResult?.confidence).toBe('medium');
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

    expect(result.current.rows[slugDupIdx].book.isDuplicate).toBe(true);
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

    expect(result.current.rows[slugDupIdx].book.isDuplicate).toBe(false);
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
    expect(result.current.rows[slugDupIdx].book.isDuplicate).toBe(true);
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
      expect(result.current.rows[nonDupIdx].edited.title).toBe('First Match');
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
      expect(result.current.rows[retryNonDupIdx].edited.title).toBe('Retry Match');
    }, { timeout: 5000 });
  });

  it('handleRetryMatch resets stale offset so new match results merge after retry', async () => {
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
      expect(result.current.rows[nonDupIdx].matchResult?.confidence).toBe('none');
    }, { timeout: 5000 });

    // Phase 2: retryMatch — new match job with different result
    mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-2', status: 'completed', total: 1, matched: 1,
      results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Better Match', authors: [{ name: 'Author A' }] }, alternatives: [] }],
    });

    act(() => { result.current.handleRetryMatch(); });

    // Observable: post-retry result merged at index 0 — confidence upgraded and title changed
    await waitFor(() => {
      expect(result.current.rows[nonDupIdx].matchResult?.confidence).toBe('high');
    }, { timeout: 5000 });
    expect(result.current.rows[nonDupIdx].edited.title).toBe('Better Match');
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
});
