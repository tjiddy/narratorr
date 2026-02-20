import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMatchJob } from './useMatchJob';
import type { MatchJobStatus } from '@/lib/api';

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
    vi.useFakeTimers();
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
      result.current.startMatching([{ path: '/a', title: 'Book' }]);
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
      result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
    });

    // Advance past poll interval
    await act(async () => {
      vi.advanceTimersByTime(2000);
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
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.isMatching).toBe(false);

    // Advance again — should NOT poll again
    mockGetMatchJob.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('cancels job and stops polling on cancel()', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValueOnce({ cancelled: true });

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    act(() => {
      result.current.cancel();
    });

    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
    expect(result.current.isMatching).toBe(false);

    // Should not poll after cancel
    mockGetMatchJob.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('cancels previous job when starting a new one', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-2' });

    await act(async () => {
      result.current.startMatching([{ path: '/b', title: 'B' }]);
    });

    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
  });

  it('handles startMatchJob failure gracefully', async () => {
    mockStartMatchJob.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    expect(result.current.isMatching).toBe(false);
  });

  it('stops polling on poll error (job expired)', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockRejectedValueOnce(new Error('Not found'));

    const { result } = renderHook(() => useMatchJob());

    await act(async () => {
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.isMatching).toBe(false);
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
      result.current.startMatching([{ path: '/a', title: 'A' }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.results).toHaveLength(1);

    // Start new job
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-2' });
    mockCancelMatchJob.mockResolvedValue({ cancelled: true });

    await act(async () => {
      result.current.startMatching([{ path: '/b', title: 'B' }]);
    });

    expect(result.current.results).toEqual([]);
  });
});
