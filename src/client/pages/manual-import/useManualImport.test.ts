import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { useManualImport } from './useManualImport';
import type { ScanResult, BookMetadata } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({
  api: {
    scanDirectory: vi.fn(),
    confirmImport: vi.fn(),
    startMatchJob: vi.fn(),
    getMatchJob: vi.fn(),
    cancelMatchJob: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { toast } from 'sonner';

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
    expect(result.current.state.rows[0].selected).toBe(true);
    expect(result.current.state.rows[0].edited.title).toBe('Book A');
    expect(result.current.state.rows[0].edited.author).toBe('Author A');
    expect(result.current.state.rows[1].edited.title).toBe('Book B');
    expect(result.current.state.rows[1].edited.author).toBe('');
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
    expect(result.current.state.rows[0].book.isDuplicate).toBe(true);
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

    expect(result.current.state.rows[0].selected).toBe(false);
    expect(result.current.state.rows[1].selected).toBe(true);
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
    vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 3 });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

    // Select all rows including duplicates
    act(() => { result.current.actions.handleToggleAll(); });
    expect(result.current.counts.allSelected).toBe(true);
    expect(result.current.counts.selectedCount).toBe(3);

    await act(async () => { result.current.actions.handleImport(); });
    await waitFor(() => { expect(vi.mocked(api.confirmImport)).toHaveBeenCalled(); });

    const [books] = vi.mocked(api.confirmImport).mock.calls[0];
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

    expect(result.current.state.rows[0].edited.title).toBe('Edited Title');
    expect(result.current.state.rows[0].edited.author).toBe('Edited Author');
    expect(result.current.state.rows[0].edited.metadata).toBe(MATCH_METADATA);
  });

  it('handleImport sends selected rows to API and navigates on success', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 2 });

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
      expect(api.confirmImport).toHaveBeenCalled();
    });

    const [items, mode] = vi.mocked(api.confirmImport).mock.calls[0];
    expect(items).toHaveLength(2);
    expect(items[0].path).toBe('/audiobooks/Book A');
    expect(items[0].title).toBe('Book A');
    expect(mode).toBe('copy');

    expect(toast.success).toHaveBeenCalledWith('2 books queued for import');
    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  it('handleImport shows error toast on failure', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    vi.mocked(api.confirmImport).mockRejectedValue(new Error('Server error'));

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
      expect(toast.error).toHaveBeenCalledWith('Import failed: Server error');
    });
  });

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

      expect(result.current.state.rows[0].edited.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards metadata.narrators to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

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
      await waitFor(() => { expect(api.confirmImport).toHaveBeenCalled(); });

      const [items] = vi.mocked(api.confirmImport).mock.calls[0];
      expect(items[0].metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards coverUrl to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

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
      await waitFor(() => { expect(api.confirmImport).toHaveBeenCalled(); });

      const [items] = vi.mocked(api.confirmImport).mock.calls[0];
      expect(items[0].coverUrl).toBe('https://example.com/new-cover.jpg');
      expect(items[0].metadata?.coverUrl).toBe('https://example.com/new-cover.jpg');
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
        result.current.actions.handleEdit(0, {
          title: 'Book A (Updated)',
          author: 'Author A',
          series: '',
          metadata: result.current.state.rows[0].edited.metadata,
        });
      });

      expect(result.current.state.rows[0].edited.title).toBe('Book A (Updated)');
      expect(result.current.state.rows[0].edited.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('mergeMatchResults seeds edited.metadata.narrators from bestMatch.narrators on first arrival', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

        expect(result.current.state.rows[0].edited.metadata?.narrators).toEqual(['Stephen Fry']);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('readyCount decrements when a high-confidence row is deselected', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

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
      const callArgs = vi.mocked(api.startMatchJob).mock.calls[0][0];
      expect(callArgs.every(c => !SCAN_RESULT_WITH_DUPLICATES.discoveries.find(d => d.path === c.path && d.isDuplicate))).toBe(true);
    });

    it('handleImport sends forceImport: true for selected duplicate rows', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      // Manually select the first duplicate row (index 1)
      act(() => { result.current.actions.handleToggle(1); });

      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(vi.mocked(api.confirmImport)).toHaveBeenCalled(); });

      const [books] = vi.mocked(api.confirmImport).mock.calls[0];
      const dupItem = books.find(b => b.path === '/audiobooks/Existing Book');
      expect(dupItem?.forceImport).toBe(true);
    });

    it('handleImport omits forceImport for non-duplicate selected rows', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.state.setScanPath('/audiobooks'); });
      await act(async () => { result.current.actions.handleScan(); });
      await waitFor(() => { expect(result.current.state.rows).toHaveLength(3); });

      // Only the non-duplicate row (index 0) is selected by default
      await act(async () => { result.current.actions.handleImport(); });
      await waitFor(() => { expect(vi.mocked(api.confirmImport)).toHaveBeenCalled(); });

      const [books] = vi.mocked(api.confirmImport).mock.calls[0];
      const newItem = books.find(b => b.path === '/audiobooks/New Book');
      expect(newItem?.forceImport).toBeUndefined();
    });

    it('duplicate rows do not auto-select when match result arrives', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

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
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

      // Existing edited state preserved (not overwritten by null bestMatch)
      expect(result.current.state.rows[0].edited.title).toBe('Book A');
      expect(result.current.state.rows[0].edited.author).toBe('Author A');
      expect(result.current.state.rows[0].matchResult?.confidence).toBe('none');
    } finally {
      vi.useRealTimers();
    }
  });

  it('bestMatch with empty authors array falls back to existing row.edited.author', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

      // Title from bestMatch, author falls back to original parsed value
      expect(result.current.state.rows[0].edited.title).toBe('Official Title');
      expect(result.current.state.rows[0].edited.author).toBe('Author A');
    } finally {
      vi.useRealTimers();
    }
  });

  it('confidence=none auto-unchecks the row (selected → false)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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
      expect(result.current.state.rows[0].selected).toBe(true);

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

      // After match merge with confidence=none, row is auto-unchecked
      expect(result.current.state.rows[0].selected).toBe(false);
      expect(result.current.state.rows[0].matchResult?.confidence).toBe('none');
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
    expect(result.current.state.rows[0].selected).toBe(false);

    // Edit with metadata → should auto-select
    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.state.rows[0].selected).toBe(true);
  });

  it('already-selected row with metadata provided remains selected', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    expect(result.current.state.rows[0].selected).toBe(true);

    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.state.rows[0].selected).toBe(true);
  });

  it('selected row with metadata removed/null remains selected', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.state.setScanPath('/audiobooks'); });
    await act(async () => { result.current.actions.handleScan(); });
    await waitFor(() => { expect(result.current.state.rows).toHaveLength(2); });

    expect(result.current.state.rows[0].selected).toBe(true);

    // Edit without metadata (metadata undefined) → should remain selected
    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
      });
    });

    expect(result.current.state.rows[0].selected).toBe(true);
  });

  it('row with matchResult confidence=none and new metadata — confidence upgrades to medium', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(result.current.state.rows[0].matchResult?.confidence).toBe('none');

      // Edit with metadata → confidence upgrades from 'none' to 'medium'
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0].matchResult?.confidence).toBe('medium');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── #335 Manual match override: medium → high ──────────────────────────
  it('row with matchResult confidence=medium and provider metadata → confidence upgrades to high', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(result.current.state.rows[0].matchResult?.confidence).toBe('medium');

      // Edit with provider metadata → confidence upgrades from 'medium' to 'high'
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0].matchResult?.confidence).toBe('high');
    } finally {
      vi.useRealTimers();
    }
  });

  it('row with matchResult confidence=high and new metadata → confidence stays high', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
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

      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(result.current.state.rows[0].matchResult?.confidence).toBe('high');

      // Edit with provider metadata → confidence stays 'high'
      act(() => {
        result.current.actions.handleEdit(0, {
          title: 'Book A', author: 'Author A', series: '',
          metadata: MATCH_METADATA,
        });
      });

      expect(result.current.state.rows[0].matchResult?.confidence).toBe('high');
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
    expect(result.current.state.rows[0].matchResult).toBeUndefined();

    act(() => {
      result.current.actions.handleEdit(0, {
        title: 'Book A', author: 'Author A', series: '',
        metadata: MATCH_METADATA,
      });
    });

    // No crash; matchResult stays undefined (no confidence upgrade without existing matchResult)
    expect(result.current.state.rows[0].matchResult).toBeUndefined();
    expect(result.current.state.rows[0].selected).toBe(true);
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
      duplicateCount: 0,
      allSelected: false,
    });
  });
});
