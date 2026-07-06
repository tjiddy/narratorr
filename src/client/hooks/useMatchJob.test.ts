import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMatchJob, packMatchCandidates } from './useMatchJob';
import type { MatchCandidate, MatchJobStatus } from '@/lib/api';

const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    startMatchJob: (...args: unknown[]) => mockStartMatchJob(...args),
    getMatchJob: (...args: unknown[]) => mockGetMatchJob(...args),
    cancelMatchJob: (...args: unknown[]) => mockCancelMatchJob(...args),
  },
}));

describe('useMatchJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // Default: cancelMatchJob always returns a resolved promise (needed for cleanup effect)
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useMatchJob());
    expect(result.current.isMatching).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(result.current.progress).toEqual({ matched: 0, total: 0 });
  });

  it('sets isMatching to true when startMatching is called', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'Book' }]);
    });

    expect(result.current.isMatching).toBe(true);
    expect(mockStartMatchJob).toHaveBeenCalledWith([{ path: '/a', title: 'Book' }]);
  });

  it('polls for results after starting', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue({
      id: 'job-1',
      status: 'matching',
      total: 2,
      matched: 1,
      results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
    } satisfies MatchJobStatus);

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
    });

    // Advance past poll interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(mockGetMatchJob).toHaveBeenCalledWith('job-1');
    expect(result.current.results).toHaveLength(1);
    expect(result.current.progress).toEqual({ matched: 1, total: 2 });
  });

  it('stops polling when job completes', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValueOnce({
      id: 'job-1',
      status: 'completed',
      total: 1,
      matched: 1,
      results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
    } satisfies MatchJobStatus);

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.isMatching).toBe(false);

    // Advance again — should NOT poll again
    mockGetMatchJob.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('cancels job and stops polling on cancel()', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValueOnce({ cancelled: true });

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    act(() => {
      result.current.cancel();
    });

    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
    expect(result.current.isMatching).toBe(false);

    // Should not poll after cancel
    mockGetMatchJob.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('cancels previous job when starting a new one', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-2' });

    await act(async () => {
      await result.current.startMatching([{ path: '/b', title: 'B' }]);
    });

    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
  });

  it('handles startMatchJob failure gracefully', async () => {
    mockStartMatchJob.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    expect(result.current.isMatching).toBe(false);
  });

  it('stops polling on poll error (job expired)', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockRejectedValueOnce(new Error('Not found'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.isMatching).toBe(false);
  });

  it('sets error when startMatchJob fails', async () => {
    mockStartMatchJob.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    expect(result.current.error).toBe('Network error');
    expect(result.current.isMatching).toBe(false);
  });

  it('sets stringified error when startMatchJob rejects a non-Error value', async () => {
    mockStartMatchJob.mockRejectedValueOnce('string-rejection');

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    expect(result.current.error).toBe('string-rejection');
    expect(result.current.isMatching).toBe(false);
  });

  it('sets error when poll fails', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockRejectedValueOnce(new Error('Job expired'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.error).toBe('Job expired');
  });

  it('sets stringified error and stops polling when getMatchJob rejects a non-Error value', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockRejectedValueOnce('string-rejection');

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.error).toBe('string-rejection');
    expect(result.current.isMatching).toBe(false);

    // Confirm polling has stopped — another tick should not trigger a call
    mockGetMatchJob.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('clears error when starting a new job', async () => {
    mockStartMatchJob.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    expect(result.current.error).toBe('Network error');

    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-2' });

    await act(async () => {
      await result.current.startMatching([{ path: '/b', title: 'B' }]);
    });

    expect(result.current.error).toBeNull();
  });

  // #1831 — byte-budgeted match chunking + sequential chunk-job queue
  describe('chunked match submission (#1831)', () => {
    /** A candidate whose padded title pushes each one above the byte budget → 1 per chunk. */
    const bigCandidate = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });

    it('packMatchCandidates splits by byte budget, preserving order', () => {
      const chunks = packMatchCandidates([bigCandidate('/a'), bigCandidate('/b'), bigCandidate('/c')]);
      expect(chunks).toHaveLength(3);
      expect(chunks.flat().map(c => c.path)).toEqual(['/a', '/b', '/c']);
    });

    it('packs small candidates into a single chunk', () => {
      const chunks = packMatchCandidates([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
      expect(chunks).toHaveLength(1);
    });

    it('runs chunk jobs sequentially — the next chunk starts only after the previous completes', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob.mockImplementation((id: string) => Promise.resolve({
        id,
        status: 'completed',
        total: 1,
        matched: 1,
        results: [{ path: id === 'job-1' ? '/a' : '/b', confidence: 'high', bestMatch: null, alternatives: [] }],
      } satisfies MatchJobStatus));

      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        await result.current.startMatching([bigCandidate('/a'), bigCandidate('/b')]);
      });

      // Only the first chunk's job has started.
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);

      // One poll completes chunk 1 → chunk 2's job launches.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

      // Next poll completes chunk 2.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(result.current.isMatching).toBe(false);

      // Append-only accumulation across chunks + queue-wide aggregate progress.
      expect(result.current.results.map(r => r.path)).toEqual(['/a', '/b']);
      expect(result.current.progress).toEqual({ matched: 2, total: 2 });
    });

    it('accumulates results append-only — chunk 1 results survive while chunk 2 is still matching', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce({ id: 'job-1', status: 'completed', total: 1, matched: 1, results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }] })
        .mockResolvedValueOnce({ id: 'job-2', status: 'matching', total: 1, matched: 0, results: [] });

      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        await result.current.startMatching([bigCandidate('/a'), bigCandidate('/b')]);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // chunk 1 completes, chunk 2 starts
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // chunk 2 first poll (still matching)

      // Chunk 1's frozen result is still present; total spans the whole queue.
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.progress.total).toBe(2);
    });

    it('packMatchCandidates budgets UTF-8 bytes, not characters', () => {
      // 80k 3-byte chars ≈ 240 KiB serialized per candidate → two exceed the 400 KiB budget
      // → 2 chunks. Char-count accounting (~160k) would pack them together.
      const mk = (p: string): MatchCandidate => ({ path: p, title: 'あ'.repeat(80 * 1024) });
      expect(packMatchCandidates([mk('/a'), mk('/b')])).toHaveLength(2);
    });

    it('startMatching([]) is a no-op: no API call, idle state', async () => {
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { await result.current.startMatching([]); });
      expect(mockStartMatchJob).not.toHaveBeenCalled();
      expect(result.current.isMatching).toBe(false);
      expect(result.current.progress).toEqual({ matched: 0, total: 0 });
    });

    // Chunk N>1 failure paths flow through the startChunkRef indirection — structurally
    // distinct from the first-chunk path, so a stale-closure or ref-wiring bug would only
    // manifest on the second chunk, exactly where these look.
    it('chunk N>1 start failure surfaces the error, stops the queue, and preserves chunk 1 results', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockRejectedValueOnce(new Error('provider down'));
      mockGetMatchJob.mockResolvedValueOnce({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
      } satisfies MatchJobStatus);

      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        await result.current.startMatching([bigCandidate('/a'), bigCandidate('/b')]);
      });
      // Chunk 1 completes → chunk 2's start rejects.
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

      expect(result.current.error).toBe('provider down');
      expect(result.current.isMatching).toBe(false);
      // Chunk 1's frozen results survive the failure.
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      // No further starts after the failure.
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    });

    it('chunk N>1 poll failure stops polling, surfaces the error, and preserves chunk 1 results', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce({
          id: 'job-1', status: 'completed', total: 1, matched: 1,
          results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
        } satisfies MatchJobStatus)
        .mockRejectedValueOnce(new Error('job expired'));

      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        await result.current.startMatching([bigCandidate('/a'), bigCandidate('/b')]);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // chunk 1 completes, chunk 2 starts
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // chunk 2's first poll rejects

      expect(result.current.error).toBe('job expired');
      expect(result.current.isMatching).toBe(false);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      // Polling has stopped.
      mockGetMatchJob.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(mockGetMatchJob).not.toHaveBeenCalled();
    });

    it('cancel mid-queue abandons pending chunks', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 1, matched: 0, results: [] });

      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        await result.current.startMatching([bigCandidate('/a'), bigCandidate('/b')]);
      });

      act(() => { result.current.cancel(); });
      expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
      expect(result.current.isMatching).toBe(false);

      // The queued second chunk never starts.
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
    });
  });

  it('resets results when starting a new job', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValueOnce({
      id: 'job-1',
      status: 'completed',
      total: 1,
      matched: 1,
      results: [{ path: '/a', confidence: 'high', bestMatch: null, alternatives: [] }],
    });

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      await result.current.startMatching([{ path: '/a', title: 'A' }]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.results).toHaveLength(1);

    // Start new job
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-2' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });

    await act(async () => {
      await result.current.startMatching([{ path: '/b', title: 'B' }]);
    });

    expect(result.current.results).toEqual([]);
  });
});
