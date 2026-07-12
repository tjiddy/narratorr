import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMatchJob, packMatchCandidates, MATCH_CHUNK_BYTE_BUDGET } from './useMatchJob';
import { ApiError } from '@/lib/api';
import type { MatchCandidate, MatchJobStatus, MatchResult } from '@/lib/api';

const mockStartMatchJob = vi.fn();
const mockGetMatchJob = vi.fn();
const mockCancelMatchJob = vi.fn();

// Preserve the real barrel exports — `ApiError` is imported at RUNTIME by the
// recovery classifier (`classifyPollError`). A no-`importOriginal` factory would
// drop it and make `instanceof ApiError` throw (vimock-barrel-replace-drops-named-exports).
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

/** Advance fake timers and flush the microtasks the poll/probe awaits resolve on. */
async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('useMatchJob', () => {
  beforeEach(() => {
    // `*Once()` queues are used heavily below — reset (not clear) so queued
    // responses never leak across tests (vitest-clearallmocks-once-queue).
    vi.resetAllMocks();
    // The serialized poll/retry/probe loop is setTimeout-driven (#1864 §0).
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

  // #1864 §1 — bounded silent retry, precise classification.
  describe('poll retry classification (#1864 §1)', () => {
    it('one transient rejection then success is invisible — no pause, run completes', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce(completed('job-1', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);      // first poll rejects (transport) → bounded backoff
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);   // retry succeeds

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(false);
    });

    it('bounded 1 + 3 retries on sustained transport failure, then probe → pause unreachable', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockRejectedValue(new Error('down'));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);           // initial poll fails (1)
      await advance(BACKOFF);        // retry 1 (2)
      await advance(BACKOFF);        // retry 2 (3)
      await advance(BACKOFF);        // retry 3 (4) → exhausted → probe (also fails)

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
      // 4 polls (1 initial + 3 retries) + 1 probe.
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
      expect(mockGetMatchJob).toHaveBeenCalledTimes(1); // no retry
    });
  });

  // #1864 §2/§3 — 404/terminal auto-resume via the one automatic allowance.
  describe('automatic allowance + rechunked remainder (#1864 §2)', () => {
    it('404 on the initial poll consumes the allowance and matches the remainder to completion', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);        // job-1 poll 404 → allowance → rechunked remainder (job-2)
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      expect(result.current.paused).toBe(false);
      await advance(POLL);        // job-2 completes

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.isMatching).toBe(false);
      expect(result.current.paused).toBe(false);
    });

    it('allowance is once-only: the auto-remainder run 404ing again pauses run-expired (F13)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))   // job-1 → allowance
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));  // job-2 → in-attempt
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);   // job-1 404 → auto-remainder job-2
      await advance(POLL);   // job-2 404 → in-attempt → pause run-expired (allowance NOT re-consumed)

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
    });

    it('multi-chunk remainder (F1): failure in chunk 1 re-packs ALL result-less candidates, each within budget', async () => {
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))    // job-1 (chunk 1) gone, no results
        .mockResolvedValueOnce(completed('job-2', [R('/a')]))
        .mockResolvedValueOnce(completed('job-3', [R('/b')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });
      await advance(POLL);   // job-1 404 → remainder re-packs [/a, /b] → job-2 (/a)
      await advance(POLL);   // job-2 completes → job-3 (/b)
      await advance(POLL);   // job-3 completes → logical run done

      // Union of the remainder request payloads = exactly the result-less paths, none dropped/duplicated.
      const remainderCalls = mockStartMatchJob.mock.calls.slice(1).map(c => c[0] as MatchCandidate[]);
      const paths = remainderCalls.flat().map(c => c.path).sort();
      expect(paths).toEqual(['/a', '/b']);
      // No single all-candidate POST — each request stays within budget.
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
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // never starts an empty remainder
    });
  });

  // #1864 §4 — no retry on chunk-start POSTs; start-failure carve-out.
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

      await act(async () => { result.current.resume(); }); // no job id → direct remainder start
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  // #1864 §3 — Resume-entry probe outcomes.
  describe('Resume-remaining probe (#1864 §3)', () => {
    it('Resume after pause probes the retained job; a probe 404 starts a fresh remainder', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      // First poll: non-404 4xx → pause request-rejected, job id retained.
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))   // resume-entry probe → terminal-gone
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      expect(result.current.reason).toBe('request-rejected');

      await act(async () => { result.current.resume(); }); // resume-entry probe → 404 → fresh remainder (job-2)
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
      await advance(POLL);

      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });

    it('Resume adopts a still-alive job when the probe returns matching', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(400, { error: 'bad' }))   // pause request-rejected (id retained)
        .mockResolvedValueOnce(matching('job-1'))                     // resume-entry probe: alive
        .mockResolvedValueOnce(completed('job-1', [R('/a')]));        // adopted poll completes
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await act(async () => { result.current.resume(); }); // probe adopts the live job
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // no replacement started
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  // #1864 §0/§1833 — single-flight polling + stale supersession guards.
  describe('single-flight + stale guards (#1864 §0, #1833)', () => {
    it('keeps at most one status request in flight (single-flight)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      let resolvePoll: ((s: MatchJobStatus) => void) | undefined;
      mockGetMatchJob.mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => { resolvePoll = resolve; }));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);   // one poll fires, stays pending
      await advance(POLL);   // no overlapping poll may start while one is in flight
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
        .mockImplementation(() => new Promise<MatchJobStatus>(() => {})); // job-2 poll never resolves
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); // job-1 poll in flight
      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); }); // supersede → job-2
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

      act(() => { result.current.startMatching([{ path: '/a', title: 'A' }]); }); // start pending
      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); }); // supersede
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
      expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // chunk 2 never launches
      expect(result.current.results.map(r => r.path)).toEqual(['/a']); // partials retained
    });

    it('a direct failed status consumes the allowance and resumes the remainder', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(failed('job-1'))
        .mockResolvedValueOnce(completed('job-2', [R('/a')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); // job-1 failed → allowance → job-2
      await advance(POLL); // job-2 completes

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

  // #1831 — byte-budgeted packing (unchanged by the recovery rewrite).
  describe('packMatchCandidates (#1831)', () => {
    const bigCandidate = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });

    it('splits by byte budget, preserving order', () => {
      const chunks = packMatchCandidates([bigCandidate('/a'), bigCandidate('/b'), bigCandidate('/c')]);
      expect(chunks).toHaveLength(3);
      expect(chunks.flat().map(c => c.path)).toEqual(['/a', '/b', '/c']);
    });

    it('packs small candidates into a single chunk', () => {
      expect(packMatchCandidates([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }])).toHaveLength(1);
    });

    it('budgets UTF-8 bytes, not characters', () => {
      const mk = (p: string): MatchCandidate => ({ path: p, title: 'あ'.repeat(80 * 1024) });
      expect(packMatchCandidates([mk('/a'), mk('/b')])).toHaveLength(2);
    });

    it('every emitted { books } body stays within the byte budget', () => {
      const half = MATCH_CHUNK_BYTE_BUDGET / 2;
      const mk = (path: string): MatchCandidate => {
        const overhead = new TextEncoder().encode(JSON.stringify({ path, title: '' })).length;
        return { path, title: 'x'.repeat(half - overhead) };
      };
      const chunks = packMatchCandidates([mk('/p0'), mk('/p1')]);
      expect(chunks).toHaveLength(2);
      for (const chunk of chunks) {
        expect(new TextEncoder().encode(JSON.stringify({ books: chunk })).length).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
      }
    });

    it('startMatching([]) is a no-op: no API call, idle state', async () => {
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([]); });
      expect(mockStartMatchJob).not.toHaveBeenCalled();
      expect(result.current.isMatching).toBe(false);
    });
  });
});
