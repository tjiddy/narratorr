import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMatchJob, packMatchCandidates, MATCH_CHUNK_BYTE_BUDGET } from './useMatchJob';
import { ApiError } from '@/lib/api';
import type { MatchCandidate, MatchJobStatus, MatchResult } from '@/lib/api';

const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();

// Preserve runtime `ApiError`; replacing the barrel outright breaks the classifier's `instanceof`.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: {
    startMatchJob: (...args: unknown[]) => mockStartMatchJob(...args),
    getMatchJob: (...args: unknown[]) => mockGetMatchJob(...args),
    cancelMatchJob: (...args: unknown[]) => mockCancelMatchJob(...args),
  },
}));

const POLL = 2000;
const BACKOFF = 3000;

const R = (path: string): MatchResult => ({ path, confidence: 'high', bestMatch: null, alternatives: [] });
const matching = (id: string, results: MatchResult[] = []): MatchJobStatus => ({ id, status: 'matching', total: 1, matched: results.length, results });
const completed = (id: string, results: MatchResult[]): MatchJobStatus => ({ id, status: 'completed', total: results.length, matched: results.length, results });
const cancelled = (id: string, results: MatchResult[] = []): MatchJobStatus => ({ id, status: 'cancelled', total: 1, matched: results.length, results });
const failed = (id: string): MatchJobStatus => ({ id, status: 'failed', total: 1, matched: 0, results: [], error: 'boom' });

/** Advance fake timers through awaited poll/probe microtasks. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useMatchJob', () => {
  beforeEach(() => {
    // Reset, not clear: queued `*Once()` responses must not leak across tests.
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    expect(result.current.paused).toBe(false);
  });

  it('sets isMatching true and starts the first chunk on startMatching', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue(matching('job-1'));
    const { result } = renderHook(() => useMatchJob());

    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });

    expect(result.current.isMatching).toBe(true);
    expect(mockStartMatchJob).toHaveBeenCalledWith([{ path: '/a', title: 'A' }]);
  });

  it('polls and completes a single-chunk run', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/a')]));
    const { result } = renderHook(() => useMatchJob());

    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
    await advance(POLL);

    expect(mockGetMatchJob).toHaveBeenCalledWith('job-1');
    expect(result.current.results.map(r => r.path)).toEqual(['/a']);
    expect(result.current.progress).toEqual({ matched: 1, total: 1 });
    expect(result.current.isMatching).toBe(false);
    expect(result.current.paused).toBe(false);
  });

  it('cancel stops polling', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
    mockGetMatchJob.mockResolvedValue(matching('job-1'));
    const { result } = renderHook(() => useMatchJob());
    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });

    act(() => { result.current.cancel(); });
    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
    expect(result.current.isMatching).toBe(false);

    mockGetMatchJob.mockClear();
    await advance(POLL * 3);
    expect(mockGetMatchJob).not.toHaveBeenCalled();
  });

  it('supersedes the prior run and cancels its job on a fresh startMatching', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValue(matching('job-1'));
    const { result } = renderHook(() => useMatchJob());
    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
    await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); });
    expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
  });

  describe('poll retry classification (#1864 §1)', () => {
    it('one transient rejection then success is invisible — no pause, run completes', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce(completed('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(false);
    });

    it('bounded 1 + 3 retries on sustained transport failure, then probe → pause unreachable', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockRejectedValue(new Error('down'));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(BACKOFF);
      await advance(BACKOFF);
      await advance(BACKOFF);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
      expect(mockGetMatchJob).toHaveBeenCalledTimes(5);
    });

    it('5xx is retried like transport', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(503, { error: 'busy' }))
        .mockResolvedValueOnce(completed('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(BACKOFF);

      expect(result.current.paused).toBe(false);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
    });

    it('other 4xx is NOT retried — pauses request-rejected immediately', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockRejectedValue(new ApiError(403, { error: 'nope' }));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('request-rejected');
      expect(mockGetMatchJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('automatic allowance + rechunked remainder (#1864 §2)', () => {
    it('404 on the initial poll consumes the allowance and matches the remainder to completion', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      expect(result.current.paused).toBe(false);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.isMatching).toBe(false);
      expect(result.current.paused).toBe(false);
    });

    it('allowance is once-only: the auto-remainder run 404ing again pauses run-expired (F13)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    });

    it('multi-chunk remainder (F1): failure in chunk 1 re-packs ALL result-less candidates, each within budget', async () => {
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]))
        .mockResolvedValueOnce(completed('job-3', [R('/b')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });
      await advance(POLL);
      await advance(POLL);
      await advance(POLL);

      const remainderCalls = mockStartMatchJob.mock.calls.slice(1).map(c => c[0] as MatchCandidate[]);
      const paths = remainderCalls.flat().map(c => c.path).sort();
      expect(paths).toEqual(['/a', '/b']);
      for (const chunk of remainderCalls) {
        const bytes = new TextEncoder().encode(JSON.stringify({ books: chunk })).length;
        expect(bytes).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
      }
      expect(result.current.results.map(r => r.path).sort()).toEqual(['/a', '/b']);
      expect(result.current.paused).toBe(false);
    });

    it('a completed status with zero remaining is a logical completion, no empty remainder start', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      expect(result.current.isMatching).toBe(false);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
    });
  });

  // Compare original-set remainder, not observed size, to stop omitted-result loops (#1870).
  describe('no-progress remainder guard (#1870)', () => {
    // Keep submitted `total` while omitting results so partial fixtures honor the API contract.
    const partial = (id: string, total: number, results: MatchResult[]): MatchJobStatus =>
      ({ id, status: 'completed', total, matched: results.length, results });
    const oversized = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(450 * 1024) });

    it('a no-progress remainder pauses run-expired instead of re-running the same candidates', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 2, [R('/a')]))
        .mockResolvedValueOnce(partial('job-2', 1, []));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]); });
      await advance(POLL);
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
    });

    it('an off-domain result does NOT count as progress (F2 discriminator — remaining, not observed.size)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(partial('job-1', 1, [R('/unexpected')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
    });

    it('an oversized ejection counts as progress and buys one remainder attempt (F4 discriminator — pre-ingestion baseline)', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 1, []))
        .mockResolvedValueOnce(partial('job-2', 1, []));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([oversized('/big'), { path: '/b', title: 'B' }]); });
      await advance(POLL);
      await advance(POLL);

      const bigResult = result.current.results.find(r => r.path === '/big');
      expect(bigResult?.confidence).toBe('none');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      expect(result.current.reason).toBe('run-expired');
    });

    it('a progress-making remainder still proceeds — the guard does not fire (regression)', async () => {
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]))
        .mockResolvedValueOnce(completed('job-3', [R('/b')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });
      await advance(POLL);
      await advance(POLL);
      await advance(POLL);

      expect(result.current.results.map(r => r.path).sort()).toEqual(['/a', '/b']);
      expect(result.current.paused).toBe(false);
    });

    it('the probe-completed drain path triggers the guard when a book is omitted', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockResolvedValueOnce(partial('job-2', 1, []));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      await advance(BACKOFF);
      await advance(BACKOFF);
      await advance(BACKOFF);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    });

    it('Resume after the guard makes exactly one more bounded attempt, then re-pauses run-expired', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 2, [R('/a')]))
        .mockResolvedValueOnce(partial('job-2', 1, []));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.reason).toBe('run-expired');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

      // The guard clears jobId, so Resume takes the direct-remainder carve-out.
      mockGetMatchJob.mockResolvedValueOnce(partial('job-3', 1, []));
      await act(async () => { result.current.resume(); });
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(3);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
    });

    it('an empty completed response on the initial run pauses immediately, no remainder started', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(partial('job-1', 1, []));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('chunk-start failure (#1864 §4)', () => {
    it('a rejected start POST pauses start-failed with no active job id', async () => {
      mockStartMatchJob.mockRejectedValueOnce(new Error('provider down'));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('start-failed');
      expect(result.current.isMatching).toBe(false);
    });

    it('Resume after a start-failure takes the carve-out — starts the observed remainder directly', async () => {
      mockStartMatchJob.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob.mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      expect(result.current.reason).toBe('start-failed');

      await act(async () => { result.current.resume(); });
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  describe('Resume-remaining probe (#1864 §3)', () => {
    it('Resume after pause probes the retained job; a probe 404 starts a fresh remainder', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.reason).toBe('request-rejected');

      await act(async () => { result.current.resume(); });
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });

    it('Resume adopts a still-alive job when the probe returns matching', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))
        .mockResolvedValueOnce(matching('job-1'))
        .mockResolvedValueOnce(completed('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await act(async () => { result.current.resume(); });
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  describe('single-flight + stale guards (#1864 §0, #1833)', () => {
    it('keeps at most one status request in flight (single-flight)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      let resolvePoll: ((s: MatchJobStatus) => void) | undefined;
      mockGetMatchJob.mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => { resolvePoll = resolve; }));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      await advance(POLL);
      expect(mockGetMatchJob).toHaveBeenCalledTimes(1);

      await act(async () => { resolvePoll?.(completed('job-1', [R('/a')])); });
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
    });

    it('a stale completed poll from a superseded run mutates nothing in the new run', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      let resolveOld: (() => void) | undefined;
      mockGetMatchJob
        .mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => {
          resolveOld = () => resolve(completed('job-1', [R('/old')]));
        }))
        .mockImplementation(() => new Promise<MatchJobStatus>(() => {}));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); });
      await act(async () => { resolveOld?.(); });

      expect(result.current.results).toEqual([]);
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(true);
    });

    it('a stale start rejection from a superseded run does not pause the new run', async () => {
      let rejectStartOld: (() => void) | undefined;
      mockStartMatchJob
        .mockImplementationOnce(() => new Promise<{ jobId: string }>((_, reject) => { rejectStartOld = () => reject(new Error('stale start')); }))
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob.mockImplementation(() => new Promise<MatchJobStatus>(() => {}));
      const { result } = renderHook(() => useMatchJob());

      act(() => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); });
      await act(async () => { rejectStartOld?.(); });

      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(true);
    });

    it('a server cancelled status pauses cancelled and abandons the queue (#1833)', async () => {
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob.mockResolvedValueOnce(cancelled('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });
      await advance(POLL);

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('cancelled');
      expect(result.current.isMatching).toBe(false);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
    });

    it('a direct failed status consumes the allowance and resumes the remainder', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(failed('job-1'))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
    });
  });

  it('restart resets results and starts a fresh logical run', async () => {
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
    mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/a')])).mockResolvedValue(matching('job-2'));
    const { result } = renderHook(() => useMatchJob());

    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
    await advance(POLL);
    expect(result.current.results).toHaveLength(1);

    await act(async () => { result.current.restart([{ path: '/b', title: 'B' }]); });
    expect(result.current.results).toEqual([]);
    expect(result.current.recovering).toBe(true);
  });

  // Restart recomputes derived scannedSeconds/reasonKind; ingest must preserve them (#1929).
  it('restart-produced result carrying scannedSeconds/reasonKind survives MatchEngine ingest (#1929)', async () => {
    const enriched: MatchResult = {
      path: '/b',
      confidence: 'medium',
      bestMatch: null,
      alternatives: [],
      reason: 'Duration mismatch — scanned 14h 53m vs expected 14h 58m',
      reasonKind: 'duration-mismatch',
      scannedSeconds: 53580,
    };
    mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
    mockGetMatchJob
      .mockResolvedValueOnce(completed('job-1', [R('/a')]))
      .mockResolvedValue(completed('job-2', [enriched]));
    const { result } = renderHook(() => useMatchJob());

    await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
    await advance(POLL);
    await act(async () => { result.current.restart([{ path: '/b', title: 'B' }]); });
    await advance(POLL);

    const merged = result.current.results.find(r => r.path === '/b');
    expect(merged?.scannedSeconds).toBe(53580);
    expect(merged?.reasonKind).toBe('duration-mismatch');
    expect(merged?.reason).toBe('Duration mismatch — scanned 14h 53m vs expected 14h 58m');
  });

  describe('recovering gate during automatic recovery (F1)', () => {
    it('is false during a healthy initial poll (keeps the selective-CTA #1102 behavior)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(matching('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.isMatching).toBe(true);
      expect(result.current.recovering).toBe(false);
    });

    it('is true during a transient retry backoff and clears when the retry succeeds', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValueOnce(matching('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.recovering).toBe(true);
      await advance(BACKOFF);
      expect(result.current.recovering).toBe(false);
    });

    it('is true throughout the automatic allowance remainder run', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(matching('job-2'));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.isMatching).toBe(true);
      expect(result.current.recovering).toBe(true);
    });
  });

  describe('duplicate candidate paths (F2)', () => {
    it('collapses duplicate paths first-occurrence-wins: total is unique, one request, consistent completion', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/dup')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => {
        result.current.startMatching([{ path: '/dup', title: 'First' }, { path: '/dup', title: 'Second' }]);
      });
      expect(result.current.total).toBe(1);
      const sent = mockStartMatchJob.mock.calls[0]![0] as MatchCandidate[];
      expect(sent.map(c => c.path)).toEqual(['/dup']);

      await advance(POLL);
      expect(result.current.progress).toEqual({ matched: 1, total: 1 });
      expect(result.current.remaining).toBe(0);
      expect(result.current.isMatching).toBe(false);
      expect(result.current.paused).toBe(false);
    });
  });

  // Import hooks consume only new array suffixes, so redelivered paths must update in place,
  // never grow the array and overwrite live chapter corroboration. Candidate dedupe is separate:
  // candidates are first-write-wins; results are last-write-wins (#2182).
  describe('path-keyed result ingestion (#2182)', () => {
    it('a same-path result re-delivery does not grow results', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockResolvedValueOnce(matching('job-1', [R('/a')]))
        .mockResolvedValueOnce(completed('job-1', [R('/a'), R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.results).toHaveLength(1);

      await advance(POLL);
      expect(result.current.results).toHaveLength(1);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
    });

    it('a later same-path result replaces the earlier one rather than appending', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockResolvedValueOnce(matching('job-1', [{ ...R('/a'), confidence: 'medium', reason: 'first' }]))
        .mockResolvedValueOnce(completed('job-1', [{ ...R('/a'), confidence: 'high', reason: 'second' }]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.results[0]!.reason).toBe('first');

      await advance(POLL);
      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0]!.reason).toBe('second');
      expect(result.current.results[0]!.confidence).toBe('high');
    });

    it('results grow only on a new path, preserving first-observation order', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockResolvedValueOnce(matching('job-1', [R('/a')]))
        .mockResolvedValueOnce(completed('job-1', [R('/a'), R('/b')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => {
        result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
      });
      await advance(POLL);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);

      await advance(POLL);
      expect(result.current.results.map(r => r.path)).toEqual(['/a', '/b']);
    });
  });

  describe('probe table across contexts (F3)', () => {
    // Exhaust 1+3 transport attempts; the queued fifth response is the automatic-entry probe.
    async function reachAutomaticEntryProbe(result: { current: { startMatching: (c: MatchCandidate[]) => void } }) {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(BACKOFF);
      await advance(BACKOFF);
      await advance(BACKOFF);
    }

    describe('automatic-entry probe', () => {
      it('matching → adopts the live job and resumes polling (resets failures)', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(matching('job-1'))
          .mockResolvedValueOnce(completed('job-1', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(false);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      });

      it('completed → ingests and advances to logical completion', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(completed('job-1', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
      });

      it('failed/404 with unspent allowance → consumes it and starts a remainder', async () => {
        // Persistent mock supplies the remainder id after the helper's once-only initial id.
        mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(failed('job-1'))
          .mockResolvedValueOnce(completed('job-2', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });

      it('cancelled → pauses cancelled with NO resurrection', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(cancelled('job-1'));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('cancelled');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      });

      it('transport/5xx inconclusive → pauses unreachable, retaining the job id', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new ApiError(503, { error: 'busy' }));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('unreachable');
        mockGetMatchJob.mockResolvedValueOnce(matching('job-1')).mockResolvedValueOnce(completed('job-1', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      });

      it('other 4xx → pauses request-rejected, retaining the job id', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new ApiError(403, { error: 'no' }));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
      });
    });

    describe('resume-entry probe', () => {
      // A non-404 4xx pauses without clearing the id needed by Resume's probe.
      async function pauseWithRetainedId(result: { current: { startMatching: (c: MatchCandidate[]) => void } }) {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(400, { error: 'bad' }));
        await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
        await advance(POLL);
      }

      it('completed → ingests and finishes without a replacement start', async () => {
        const { result } = renderHook(() => useMatchJob());
        await pauseWithRetainedId(result);
        mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      });

      it('cancelled → starts a fresh human-authorized remainder', async () => {
        mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
        const { result } = renderHook(() => useMatchJob());
        await pauseWithRetainedId(result);
        mockGetMatchJob.mockResolvedValueOnce(cancelled('job-1')).mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });

      it('transport/5xx inconclusive → pauses unreachable, id retained (never replaces)', async () => {
        const { result } = renderHook(() => useMatchJob());
        await pauseWithRetainedId(result);
        mockGetMatchJob.mockRejectedValueOnce(new Error('still down'));
        await act(async () => { result.current.resume(); });
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('unreachable');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1);
      });

      it('other 4xx → pauses request-rejected, id retained', async () => {
        const { result } = renderHook(() => useMatchJob());
        await pauseWithRetainedId(result);
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(422, { error: 'nope' }));
        await act(async () => { result.current.resume(); });
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
      });
    });

    describe('in-attempt (after the allowance is spent) never starts a second remainder', () => {
      // A direct 404 spends the allowance and enters the in-attempt auto-remainder phase.
      async function reachAutoRemainder(result: { current: { startMatching: (c: MatchCandidate[]) => void } }, remainderJob = 'job-2') {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: remainderJob });
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
        await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
        await advance(POLL);
      }

      it('failed/404 → pauses run-expired, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
        await advance(POLL);
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('cancelled → pauses cancelled, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockResolvedValueOnce(cancelled('job-2'));
        await advance(POLL);
        expect(result.current.reason).toBe('cancelled');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('transport exhaustion → in-attempt probe pauses unreachable, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t'));
        await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('unreachable');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('matching → keeps polling the remainder job, no pause, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob
          .mockResolvedValueOnce(matching('job-2'))
          .mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await advance(POLL);
        expect(result.current.paused).toBe(false);
        expect(result.current.isMatching).toBe(true);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('completed → ingests and finishes the logical run, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('direct failed status → pauses run-expired, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockResolvedValueOnce(failed('job-2'));
        await advance(POLL);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('other 4xx → pauses request-rejected, retaining the job id (Resume probes, no blind start)', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(422, { error: 'nope' }));
        await advance(POLL);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

        mockGetMatchJob.mockResolvedValueOnce(matching('job-2')).mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });
    });

    // Unlike the direct-poll cases above, these drive the same outcomes through
    // `applyProbeOutcome` after auto-remainder retry exhaustion (#1864 F11).
    describe('in-attempt PROBE outcomes reached via exhaustion (F11)', () => {
      // Drive initial 404 → auto-remainder → 1+3 failures; the next queued response is its probe.
      async function driveToInAttemptProbe(result: { current: { startMatching: (c: MatchCandidate[]) => void } }) {
        await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
        await advance(POLL);
        await advance(POLL);
        await advance(BACKOFF);
        await advance(BACKOFF);
        await advance(BACKOFF);
      }

      const exhaustionPrefix = () => mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'));

      it('probe matching → adopts the live remainder job, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix()
          .mockResolvedValueOnce(matching('job-2'))
          .mockResolvedValueOnce(completed('job-2', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(false);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('probe completed → ingests and finishes, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(completed('job-2', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('probe failed → pauses run-expired, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(failed('job-2'));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('probe cancelled → pauses cancelled, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(cancelled('job-2'));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('cancelled');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      });

      it('probe other-4xx → pauses request-rejected, retaining the id (Resume probes it, no blind start)', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockRejectedValueOnce(new ApiError(422, { error: 'nope' }));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

        mockGetMatchJob.mockResolvedValueOnce(matching('job-2')).mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });
    });

    it('Restart resets the allowance; Resume never consumes it', async () => {
      // Spend the allowance and pause.
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.reason).toBe('run-expired');

      // Resume gets one human remainder without replenishing the automatic allowance.
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
      await act(async () => { result.current.resume(); });
      await advance(POLL);
      expect(result.current.reason).toBe('run-expired');

      // Restart creates a new logical run with a fresh allowance.
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-4' }).mockResolvedValueOnce({ jobId: 'job-5' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-5', [R('/a')]));
      await act(async () => { result.current.restart([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  describe('retry budget reset after success (F4)', () => {
    it('a fail → success → sustained-fail sequence gets a full fresh 1 + 3 budget before probing', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('t'))
        .mockResolvedValueOnce(matching('job-1'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });

      await advance(POLL);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(false);

      await advance(POLL);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
      // Six polls plus one probe distinguish a reset budget from a carried counter.
      expect(mockGetMatchJob).toHaveBeenCalledTimes(7);
    });

    it('a completed probe that advances into a remainder gives it a fresh 1 + 3 budget (F9)', async () => {
      // A completed exhaustion probe advances to chunk 2, which must receive a fresh 1+3 budget.
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockResolvedValueOnce(completed('job-1', [R('/a')]))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t'));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });

      await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      expect(result.current.paused).toBe(false);

      // The first chunk-2 failure must not immediately probe on chunk 1's stale count.
      await advance(POLL);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
    });
  });

  describe('stale guards across recovery stages (F5)', () => {
    it('cancel during a retry backoff clears the pending timer — no further polls', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockRejectedValueOnce(new Error('down'));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.recovering).toBe(true);

      act(() => { result.current.cancel(); });
      mockGetMatchJob.mockClear();
      await advance(BACKOFF * 2);
      expect(mockGetMatchJob).not.toHaveBeenCalled();
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(false);
    });

    it('supersede during an in-flight probe drops the stale probe outcome', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      let resolveProbe: ((s: MatchJobStatus) => void) | undefined;
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => { resolveProbe = resolve; }))
        .mockImplementation(() => new Promise<MatchJobStatus>(() => {}));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF);

      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); });
      await act(async () => { resolveProbe?.(failed('job-1')); });
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(true);
    });

    it('cancel during an in-flight replacement-start cancels the late job and does not mutate state', async () => {
      let resolveStart: ((v: { jobId: string }) => void) | undefined;
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockImplementationOnce(() => new Promise<{ jobId: string }>((resolve) => { resolveStart = resolve; }));
      mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      act(() => { result.current.cancel(); });
      await act(async () => { resolveStart?.({ jobId: 'job-2' }); });
      expect(mockCancelMatchJob).toHaveBeenCalledWith('job-2');
      expect(result.current.isMatching).toBe(false);
      expect(result.current.paused).toBe(false);
    });

    it('unmount disposes the engine — a late poll resolution is ignored', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      let resolvePoll: ((s: MatchJobStatus) => void) | undefined;
      mockGetMatchJob.mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => { resolvePoll = resolve; }));
      const { result, unmount } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      unmount();
      await act(async () => { resolvePoll?.(completed('job-1', [R('/a')])); });
      expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1');
    });
  });

  describe('packMatchCandidates (#1831)', () => {
    const bigCandidate = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });

    it('splits by byte budget, preserving order', () => {
      const { chunks, oversized } = packMatchCandidates([bigCandidate('/a'), bigCandidate('/b'), bigCandidate('/c')]);
      expect(chunks).toHaveLength(3);
      expect(chunks.flat().map(c => c.path)).toEqual(['/a', '/b', '/c']);
      expect(oversized).toEqual([]);
    });

    it('packs small candidates into a single chunk', () => {
      expect(packMatchCandidates([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]).chunks).toHaveLength(1);
    });

    it('budgets UTF-8 bytes, not characters', () => {
      const mk = (p: string): MatchCandidate => ({ path: p, title: 'あ'.repeat(80 * 1024) });
      expect(packMatchCandidates([mk('/a'), mk('/b')]).chunks).toHaveLength(2);
    });

    it('every emitted { books } body stays within the byte budget', () => {
      const half = MATCH_CHUNK_BYTE_BUDGET / 2;
      const mk = (path: string): MatchCandidate => {
        const overhead = new TextEncoder().encode(JSON.stringify({ path, title: '' })).length;
        return { path, title: 'x'.repeat(half - overhead) };
      };
      const { chunks } = packMatchCandidates([mk('/p0'), mk('/p1')]);
      expect(chunks).toHaveLength(2);
      for (const chunk of chunks) {
        expect(new TextEncoder().encode(JSON.stringify({ books: chunk })).length).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
      }
    });

    describe('1,000-item count limit (F14)', () => {
      const small = (i: number): MatchCandidate => ({ path: `/p${i}`, title: `t${i}` });

      it('packs exactly 1,000 small candidates into a single chunk', () => {
        const items = Array.from({ length: 1000 }, (_, i) => small(i));
        const { chunks, oversized } = packMatchCandidates(items);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toHaveLength(1000);
        expect(oversized).toEqual([]);
      });

      it('splits 1,001 small candidates into 1,000 + 1, preserving order and the exact path union', () => {
        const items = Array.from({ length: 1001 }, (_, i) => small(i));
        const { chunks } = packMatchCandidates(items);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]).toHaveLength(1000);
        expect(chunks[1]).toHaveLength(1);
        expect(chunks.flat().map(c => c.path)).toEqual(items.map(c => c.path));
      });
    });

    describe('individually-oversized candidate (F15)', () => {
      const oversizedCandidate = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(410 * 1024) });

      it('diverts a lone oversized candidate to `oversized` with no emitted chunk', () => {
        const { chunks, oversized } = packMatchCandidates([oversizedCandidate('/big')]);
        expect(chunks).toEqual([]);
        expect(oversized.map(c => c.path)).toEqual(['/big']);
      });

      it('diverts the oversized candidate while still packing the fitting ones within budget', () => {
        const { chunks, oversized } = packMatchCandidates([oversizedCandidate('/big'), { path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
        expect(oversized.map(c => c.path)).toEqual(['/big']);
        expect(chunks.flat().map(c => c.path)).toEqual(['/a', '/b']);
        for (const chunk of chunks) {
          expect(new TextEncoder().encode(JSON.stringify({ books: chunk })).length).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
        }
      });
    });

    it('startMatching([]) is a no-op: no API call, idle state', async () => {
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([]); });
      expect(mockStartMatchJob).not.toHaveBeenCalled();
      expect(result.current.isMatching).toBe(false);
    });

    it('an oversized candidate is surfaced as an unmatchable none result, never sent to the API (F15)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/small')]));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => {
        result.current.startMatching([{ path: '/big', title: 'x'.repeat(410 * 1024) }, { path: '/small', title: 'S' }]);
      });

      const oversizedResult = result.current.results.find(r => r.path === '/big');
      expect(oversizedResult?.confidence).toBe('none');
      const sent = mockStartMatchJob.mock.calls.flatMap(c => (c[0] as MatchCandidate[]).map(x => x.path));
      expect(sent).not.toContain('/big');
      expect(sent).toContain('/small');

      await advance(POLL);
      expect(result.current.results.find(r => r.path === '/small')?.confidence).toBe('high');
      for (const call of mockStartMatchJob.mock.calls) {
        expect(new TextEncoder().encode(JSON.stringify({ books: call[0] })).length).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
      }
    });
  });
});
