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

    expect(result.current.step).toBe('path');
    expect(result.current.scanPath).toBe('');
    expect(result.current.rows).toEqual([]);
    expect(result.current.selectedCount).toBe(0);
  });

  it('scan creates rows from discoveries and transitions to review step', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setScanPath('/audiobooks');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.step).toBe('review');
    });

    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[0].selected).toBe(true);
    expect(result.current.rows[0].edited.title).toBe('Book A');
    expect(result.current.rows[0].edited.author).toBe('Author A');
    expect(result.current.rows[1].edited.title).toBe('Book B');
    expect(result.current.rows[1].edited.author).toBe('');
    expect(result.current.selectedCount).toBe(2);
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
      result.current.setScanPath('/empty');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.scanError).toBeTruthy();
    });

    expect(result.current.step).toBe('path'); // stays on path step
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
      result.current.setScanPath('/dupes');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.step).toBe('review');
    });
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0].book.isDuplicate).toBe(true);
    // No match job started when all books are duplicates — empty candidates list guard
    expect(vi.mocked(api.startMatchJob)).not.toHaveBeenCalled();
  });

  it('sets scanError when scan API rejects', async () => {
    vi.mocked(api.scanDirectory).mockRejectedValue(new Error('Permission denied'));

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setScanPath('/noaccess');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.scanError).toBe('Permission denied');
    });
  });

  it('calls onScanSuccess with the trimmed scan path when scan returns discoveries', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    const onScanSuccess = vi.fn();

    const { result } = renderHook(() => useManualImport({ onScanSuccess }), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.setScanPath('  /audiobooks  ');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.step).toBe('review');
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
      result.current.setScanPath('/empty');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.scanError).toBeTruthy();
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
      result.current.setScanPath('/noaccess');
    });

    await act(async () => {
      result.current.handleScan();
    });

    await waitFor(() => {
      expect(result.current.scanError).toBe('Permission denied');
    });

    expect(onScanSuccess).not.toHaveBeenCalled();
  });

  it('does not scan when path is empty', async () => {
    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.handleScan();
    });

    expect(api.scanDirectory).not.toHaveBeenCalled();
  });

  it('handleToggle toggles row selection', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    act(() => {
      result.current.handleToggle(0);
    });

    expect(result.current.rows[0].selected).toBe(false);
    expect(result.current.rows[1].selected).toBe(true);
    expect(result.current.selectedCount).toBe(1);
  });

  it('handleToggleAll selects/deselects all rows', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    // All selected → deselect all
    act(() => {
      result.current.handleToggleAll();
    });
    expect(result.current.allSelected).toBe(false);
    expect(result.current.selectedCount).toBe(0);

    // All deselected → select all
    act(() => {
      result.current.handleToggleAll();
    });
    expect(result.current.allSelected).toBe(true);
    expect(result.current.selectedCount).toBe(2);
  });

  it('select-all then import sends forceImport: true for duplicate rows (intended behavior per spec)', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);
    vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 3 });

    const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

    // Select all rows including duplicates
    act(() => { result.current.handleToggleAll(); });
    expect(result.current.allSelected).toBe(true);
    expect(result.current.selectedCount).toBe(3);

    await act(async () => { result.current.handleImport(); });
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

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    act(() => {
      result.current.handleEdit(0, {
        title: 'Edited Title',
        author: 'Edited Author',
        series: 'Edited Series',
        metadata: MATCH_METADATA,
      });
    });

    expect(result.current.rows[0].edited.title).toBe('Edited Title');
    expect(result.current.rows[0].edited.author).toBe('Edited Author');
    expect(result.current.rows[0].edited.metadata).toBe(MATCH_METADATA);
  });

  it('handleImport sends selected rows to API and navigates on success', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
    vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 2 });

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    await act(async () => {
      result.current.handleImport();
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

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    await act(async () => {
      result.current.handleImport();
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

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.step).toBe('review'); });

    act(() => {
      result.current.handleBack();
    });

    expect(result.current.step).toBe('path');
    expect(result.current.rows).toEqual([]);
  });

  it('handleBack from path navigates to library', () => {
    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => {
      result.current.handleBack();
    });

    expect(mockNavigate).toHaveBeenCalledWith('/library');
  });

  describe('narrator persistence through edit flow', () => {
    it('handleEdit with metadata.narrators persists narrators in row edited state', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

      act(() => {
        result.current.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
      });

      expect(result.current.rows[0].edited.metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards metadata.narrators to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

      act(() => {
        result.current.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
        // deselect row 1 to simplify assertion
        result.current.handleToggle(1);
      });

      await act(async () => { result.current.handleImport(); });
      await waitFor(() => { expect(api.confirmImport).toHaveBeenCalled(); });

      const [items] = vi.mocked(api.confirmImport).mock.calls[0];
      expect(items[0].metadata?.narrators).toEqual(['Jim Dale']);
    });

    it('handleImport after edit forwards coverUrl to ImportConfirmItem', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

      act(() => {
        result.current.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          coverUrl: 'https://example.com/new-cover.jpg',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'], coverUrl: 'https://example.com/new-cover.jpg' },
        });
        result.current.handleToggle(1);
      });

      await act(async () => { result.current.handleImport(); });
      await waitFor(() => { expect(api.confirmImport).toHaveBeenCalled(); });

      const [items] = vi.mocked(api.confirmImport).mock.calls[0];
      expect(items[0].coverUrl).toBe('https://example.com/new-cover.jpg');
      expect(items[0].metadata?.coverUrl).toBe('https://example.com/new-cover.jpg');
    });

    it('editing title only does not discard narrator from existing edited.metadata', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

      // First edit: set metadata with narrators
      act(() => {
        result.current.handleEdit(0, {
          title: 'Book A',
          author: 'Author A',
          series: '',
          metadata: { title: 'Book A', authors: [{ name: 'Author A' }], narrators: ['Jim Dale'] },
        });
      });

      // Second edit: change only the title, keep same metadata
      act(() => {
        result.current.handleEdit(0, {
          title: 'Book A (Updated)',
          author: 'Author A',
          series: '',
          metadata: result.current.rows[0].edited.metadata,
        });
      });

      expect(result.current.rows[0].edited.title).toBe('Book A (Updated)');
      expect(result.current.rows[0].edited.metadata?.narrators).toEqual(['Jim Dale']);
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
        act(() => { result.current.setScanPath('/audiobooks'); });
        await act(async () => { result.current.handleScan(); });
        await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

        // Advance past the 2000ms poll interval so the first poll fires
        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

        expect(result.current.rows[0].edited.metadata?.narrators).toEqual(['Stephen Fry']);
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
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

      // Advance past the 2000ms poll interval so match results arrive
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

      // Row 0 is high confidence and selected → ready count = 1
      expect(result.current.readyCount).toBe(1);

      // Deselect the matched row → ready count drops to 0
      act(() => { result.current.handleToggle(0); });
      expect(result.current.readyCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes pendingCount and noMatchCount correctly', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT);

    const { result } = renderHook(() => useManualImport(), {
      wrapper: createWrapper(),
    });

    act(() => { result.current.setScanPath('/audiobooks'); });
    await act(async () => { result.current.handleScan(); });
    await waitFor(() => { expect(result.current.rows).toHaveLength(2); });

    // Before any match results, all are pending
    expect(result.current.pendingCount).toBe(2);
    expect(result.current.noMatchCount).toBe(0);
    expect(result.current.readyCount).toBe(0);
    expect(result.current.reviewCount).toBe(0);
  });

  // ===========================================================================
  // #114 — duplicate row behavior
  // ===========================================================================
  describe('duplicate rows (isDuplicate: true)', () => {
    it('duplicate rows initialize with selected: false', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

      const dupRows = result.current.rows.filter(r => r.book.isDuplicate);
      expect(dupRows).toHaveLength(2);
      expect(dupRows.every(r => !r.selected)).toBe(true);
    });

    it('duplicate rows are excluded from startMatching candidates', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

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
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

      // Manually select the first duplicate row (index 1)
      act(() => { result.current.handleToggle(1); });

      await act(async () => { result.current.handleImport(); });
      await waitFor(() => { expect(vi.mocked(api.confirmImport)).toHaveBeenCalled(); });

      const [books] = vi.mocked(api.confirmImport).mock.calls[0];
      const dupItem = books.find(b => b.path === '/audiobooks/Existing Book');
      expect(dupItem?.forceImport).toBe(true);
    });

    it('handleImport omits forceImport for non-duplicate selected rows', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);
      vi.mocked(api.confirmImport).mockResolvedValue({ accepted: 1 });

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

      // Only the non-duplicate row (index 0) is selected by default
      await act(async () => { result.current.handleImport(); });
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
        act(() => { result.current.setScanPath('/audiobooks'); });
        await act(async () => { result.current.handleScan(); });
        await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

        await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

        const dupRow = result.current.rows.find(r => r.book.path === '/audiobooks/Existing Book');
        expect(dupRow?.selected).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('duplicateCount equals the number of discoveries with isDuplicate: true', async () => {
      vi.mocked(api.scanDirectory).mockResolvedValue(SCAN_RESULT_WITH_DUPLICATES);

      const { result } = renderHook(() => useManualImport(), { wrapper: createWrapper() });
      act(() => { result.current.setScanPath('/audiobooks'); });
      await act(async () => { result.current.handleScan(); });
      await waitFor(() => { expect(result.current.rows).toHaveLength(3); });

      expect(result.current.duplicateCount).toBe(2);
    });
  });
});
