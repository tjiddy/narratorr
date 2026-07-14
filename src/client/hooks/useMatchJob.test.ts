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

  // #1870 — no-progress guard against a partial `completed` response that omits a candidate.
  // The rechunked remainder must not re-run the same result-less candidates forever: a run that
  // drains all its chunks without shrinking the ORIGINAL-set remainder pauses `run-expired`.
  describe('no-progress remainder guard (#1870)', () => {
    // Explicit-total partial completion: `total` stays the SUBMITTED candidate count while
    // `results` reflects the omission (the engine reads only status.status / status.results,
    // so this keeps the fixture contract-honest without changing engine behavior).
    const partial = (id: string, total: number, results: MatchResult[]): MatchJobStatus =>
      ({ id, status: 'completed', total, matched: results.length, results });
    // A single-item body above the 400 KiB budget — the packer diverts it to a `none` result.
    const oversized = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(450 * 1024) });

    it('a no-progress remainder pauses run-expired instead of re-running the same candidates', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 2, [R('/a')])) // omits /b → remainder shrinks 2→1
        .mockResolvedValueOnce(partial('job-2', 1, []));        // omits /b again → no progress
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]); });
      await advance(POLL); // job-1 completed (/a) → remainder [/b] → job-2
      await advance(POLL); // job-2 completed omits /b → guard pauses

      expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // never a third
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
    });

    it('an off-domain result does NOT count as progress (F2 discriminator — remaining, not observed.size)', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      // A completed response carrying a path outside `original` while omitting /a: it grows
      // observed.size but does not shrink the original-set remainder, so the guard must pause.
      mockGetMatchJob.mockResolvedValueOnce(partial('job-1', 1, [R('/unexpected')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);

      expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // guard pauses, no remainder started
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
    });

    it('an oversized ejection counts as progress and buys one remainder attempt (F4 discriminator — pre-ingestion baseline)', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 1, [])) // the sendable /b omitted
        .mockResolvedValueOnce(partial('job-2', 1, [])); // omitted again
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([oversized('/big'), { path: '/b', title: 'B' }]); });
      await advance(POLL); // /big ejected (2→1) is progress → remainder [/b] → job-2
      await advance(POLL); // job-2 completed omits /b → no progress → pause

      const bigResult = result.current.results.find(r => r.path === '/big');
      expect(bigResult?.confidence).toBe('none');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // the ejection earned one legitimate remainder
      expect(result.current.reason).toBe('run-expired');
    });

    it('a progress-making remainder still proceeds — the guard does not fire (regression)', async () => {
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })) // job-1 (chunk 1) gone → remainder
        .mockResolvedValueOnce(completed('job-2', [R('/a')]))
        .mockResolvedValueOnce(completed('job-3', [R('/b')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });
      await advance(POLL); // job-1 404 → remainder re-packs [/a, /b] → job-2 (/a)
      await advance(POLL); // job-2 completes → job-3 (/b)
      await advance(POLL); // job-3 completes → logical run done

      expect(result.current.results.map(r => r.path).sort()).toEqual(['/a', '/b']);
      expect(result.current.paused).toBe(false);
    });

    it('the probe-completed drain path triggers the guard when a book is omitted', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })) // job-1 → allowance → auto-remainder job-2
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t')) // job-2 exhausted → probe
        .mockResolvedValueOnce(partial('job-2', 1, [])); // probe completed omits /a → no progress
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);    // job-1 404 → auto-remainder job-2
      await advance(POLL);    // job-2 poll fail (1)
      await advance(BACKOFF); // fail (2)
      await advance(BACKOFF); // fail (3)
      await advance(BACKOFF); // fail (4) → in-attempt probe → completed omits /a → guard pauses

      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('run-expired');
      expect(result.current.remaining).toBe(1);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
    });

    it('Resume after the guard makes exactly one more bounded attempt, then re-pauses run-expired', async () => {
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockResolvedValueOnce({ jobId: 'job-2' })
        .mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockResolvedValueOnce(partial('job-1', 2, [R('/a')])) // omits /b
        .mockResolvedValueOnce(partial('job-2', 1, []));        // omits /b → pause
      const { result } = renderHook(() => useMatchJob());

      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }, { path: '/b', title: 'B' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.reason).toBe('run-expired');
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

      // Resume: jobId is null at the guard → start-failure carve-out starts a human remainder.
      mockGetMatchJob.mockResolvedValueOnce(partial('job-3', 1, [])); // still omits /b
      await act(async () => { result.current.resume(); });
      await advance(POLL); // job-3 completed omits /b → guard re-pauses

      expect(mockStartMatchJob).toHaveBeenCalledTimes(3); // exactly one more, no runaway loop
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

  // #1864 F1 — automatic recovery activates the fail-closed `recovering` gate.
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
      await advance(POLL);   // poll fails → backoff scheduled
      expect(result.current.recovering).toBe(true);
      await advance(BACKOFF); // retry succeeds
      expect(result.current.recovering).toBe(false);
    });

    it('is true throughout the automatic allowance remainder run', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })) // job-1 → allowance remainder
        .mockResolvedValueOnce(matching('job-2'));                   // job-2 still matching
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);   // 404 → auto-remainder (job-2)
      await advance(POLL);   // job-2 matching
      expect(result.current.isMatching).toBe(true);
      expect(result.current.recovering).toBe(true);
    });
  });

  // #1864 F2 — duplicate candidate paths collapse to a defined, consistent shape.
  describe('duplicate candidate paths (F2)', () => {
    it('collapses duplicate paths first-occurrence-wins: total is unique, one request, consistent completion', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockResolvedValueOnce(completed('job-1', [R('/dup')]));
      const { result } = renderHook(() => useMatchJob());

      await act(async () => {
        result.current.startMatching([{ path: '/dup', title: 'First' }, { path: '/dup', title: 'Second' }]);
      });
      // Total reflects the unique path, not the raw candidate count.
      expect(result.current.total).toBe(1);
      const sent = mockStartMatchJob.mock.calls[0]![0] as MatchCandidate[];
      expect(sent.map(c => c.path)).toEqual(['/dup']); // only the first occurrence is sent

      await advance(POLL);
      // One result satisfies the single logical candidate — matched === total, clean finish.
      expect(result.current.progress).toEqual({ matched: 1, total: 1 });
      expect(result.current.remaining).toBe(0);
      expect(result.current.isMatching).toBe(false);
      expect(result.current.paused).toBe(false);
    });
  });

  // #1864 F3 — the three-context probe/allowance table (§3).
  describe('probe table across contexts (F3)', () => {
    // Reaches an automatic-entry PROBE: transport exhaustion (1 + 3) in the still-automatic
    // initial run, then the 5th getMatchJob IS the probe whose outcome the caller queued.
    async function reachAutomaticEntryProbe(result: { current: { startMatching: (c: MatchCandidate[]) => void } }) {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);       // poll1 fail (1)
      await advance(BACKOFF);    // retry1 fail (2)
      await advance(BACKOFF);    // retry2 fail (3)
      await advance(BACKOFF);    // retry3 fail (4) → probe fires synchronously
    }

    describe('automatic-entry probe', () => {
      it('matching → adopts the live job and resumes polling (resets failures)', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(matching('job-1'))               // probe: alive
          .mockResolvedValueOnce(completed('job-1', [R('/a')]));  // adopted poll completes
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(false);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // no replacement
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
        // Persistent remainder job id; the initial once-`job-1` is queued in the helper.
        mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' });
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockResolvedValueOnce(failed('job-1'))                 // probe: terminal-gone
          .mockResolvedValueOnce(completed('job-2', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // remainder started
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
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // no replacement
      });

      it('transport/5xx inconclusive → pauses unreachable, retaining the job id', async () => {
        mockGetMatchJob
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
          .mockRejectedValueOnce(new ApiError(503, { error: 'busy' })); // probe: inconclusive
        const { result } = renderHook(() => useMatchJob());
        await reachAutomaticEntryProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('unreachable');
        // id retained → a subsequent Resume probes it rather than blind-starting.
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
      // Pause via a non-404 4xx poll so the job id is retained, then Resume → resume-entry probe.
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
        mockStartMatchJob.mockResolvedValue({ jobId: 'job-2' }); // remainder (persistent); initial once-job-1 in helper
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
        expect(mockStartMatchJob).toHaveBeenCalledTimes(1); // no replacement
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
      // Consume the allowance with a direct 404, landing in the auto-remainder run whose
      // polls are in-attempt context.
      async function reachAutoRemainder(result: { current: { startMatching: (c: MatchCandidate[]) => void } }, remainderJob = 'job-2') {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: remainderJob });
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' })); // job-1 → allowance
        await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
        await advance(POLL);
      }

      it('failed/404 → pauses run-expired, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' }));
        await advance(POLL); // job-2 poll 404 → in-attempt
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
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
          .mockRejectedValueOnce(new Error('t')); // in-attempt probe also inconclusive
        await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('unreachable');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // never a job-3
      });

      it('matching → keeps polling the remainder job, no pause, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob
          .mockResolvedValueOnce(matching('job-2'))              // in-attempt matching → continue
          .mockResolvedValueOnce(completed('job-2', [R('/a')])); // then completes
        await advance(POLL); // job-2 matching
        expect(result.current.paused).toBe(false);
        expect(result.current.isMatching).toBe(true);
        await advance(POLL); // job-2 completes
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('completed → ingests and finishes the logical run, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('direct failed status → pauses run-expired, no third job', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockResolvedValueOnce(failed('job-2')); // direct terminal `failed` status
        await advance(POLL);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('other 4xx → pauses request-rejected, retaining the job id (Resume probes, no blind start)', async () => {
        const { result } = renderHook(() => useMatchJob());
        await reachAutoRemainder(result);
        mockGetMatchJob.mockRejectedValueOnce(new ApiError(422, { error: 'nope' }));
        await advance(POLL);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

        // The retained id 'job-2' is probed by Resume — no blind replacement start.
        mockGetMatchJob.mockResolvedValueOnce(matching('job-2')).mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // probed the retained id, adopted it
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });
    });

    // #1864 F11 — the same outcomes reached through the in-attempt PROBE branch
    // (applyProbeOutcome / terminalGone / terminalCancelled with in-attempt context),
    // i.e. after the auto-remainder run exhausts its own 1 + 3 retry budget. The direct-poll
    // cases above exercise handleStatus/handlePollError; these exercise the probe path.
    describe('in-attempt PROBE outcomes reached via exhaustion (F11)', () => {
      // Queue [startMatchJob: job-1, job-2] and [getMatchJob: 404, t, t, t, t, <probe outcome…>]
      // then drive to the in-attempt probe: job-1 404 → auto-remainder job-2 → its 1 + 3 exhausts.
      async function driveToInAttemptProbe(result: { current: { startMatching: (c: MatchCandidate[]) => void } }) {
        await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
        await advance(POLL);    // job-1 404 → auto-remainder job-2
        await advance(POLL);    // job-2 poll fail (1)
        await advance(BACKOFF); // fail (2)
        await advance(BACKOFF); // fail (3)
        await advance(BACKOFF); // fail (4) → in-attempt probe fires
      }

      const exhaustionPrefix = () => mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })) // job-1 → allowance → auto-remainder
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t')); // job-2 1 + 3 exhausted

      it('probe matching → adopts the live remainder job, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix()
          .mockResolvedValueOnce(matching('job-2'))              // in-attempt probe: alive → adopt
          .mockResolvedValueOnce(completed('job-2', [R('/a')])); // adopted poll completes
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(false);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('probe completed → ingests and finishes, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(completed('job-2', [R('/a')]));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.isMatching).toBe(false);
        expect(result.current.paused).toBe(false);
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('probe failed → pauses run-expired, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(failed('job-2'));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('run-expired');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('probe cancelled → pauses cancelled, no third job', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockResolvedValueOnce(cancelled('job-2'));
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('cancelled');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // no job-3
      });

      it('probe other-4xx → pauses request-rejected, retaining the id (Resume probes it, no blind start)', async () => {
        mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
        exhaustionPrefix().mockRejectedValueOnce(new ApiError(422, { error: 'nope' })); // in-attempt probe rejects other-4xx
        const { result } = renderHook(() => useMatchJob());
        await driveToInAttemptProbe(result);
        expect(result.current.paused).toBe(true);
        expect(result.current.reason).toBe('request-rejected');
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);

        // The id 'job-2' is retained → Resume probes it rather than blind-starting a replacement.
        mockGetMatchJob.mockResolvedValueOnce(matching('job-2')).mockResolvedValueOnce(completed('job-2', [R('/a')]));
        await act(async () => { result.current.resume(); });
        expect(mockStartMatchJob).toHaveBeenCalledTimes(2);
        await advance(POLL);
        expect(result.current.results.map(r => r.path)).toEqual(['/a']);
        expect(result.current.paused).toBe(false);
      });
    });

    it('Restart resets the allowance; Resume never consumes it', async () => {
      // Spend the allowance and pause run-expired.
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))  // job-1 → allowance
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })); // job-2 → in-attempt → run-expired
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL);
      await advance(POLL);
      expect(result.current.reason).toBe('run-expired');

      // Resume authorizes ONE attempt via the allowance-independent human path — a resume
      // remainder that 404s pauses again (never silently auto-loops on the spent allowance).
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-3' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))  // resume-entry probe on job-2 → fresh remainder
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })); // job-3 remainder poll → in-attempt
      await act(async () => { result.current.resume(); });
      await advance(POLL); // job-3 remainder 404 → in-attempt → pause
      expect(result.current.reason).toBe('run-expired');

      // Restart begins a NEW logical run and RESETS the allowance: a fresh 404 auto-resumes again.
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-4' }).mockResolvedValueOnce({ jobId: 'job-5' });
      mockGetMatchJob
        .mockRejectedValueOnce(new ApiError(404, { error: 'gone' })) // job-4 → allowance (reset)
        .mockResolvedValueOnce(completed('job-5', [R('/a')]));
      await act(async () => { result.current.restart([{ path: '/a', title: 'A' }]); });
      await advance(POLL); // job-4 404 → allowance consumed again → job-5
      await advance(POLL); // job-5 completes
      expect(result.current.results.map(r => r.path)).toEqual(['/a']);
      expect(result.current.paused).toBe(false);
    });
  });

  // #1864 F4 — the 1 + 3 retry budget is freshly reset after a successful poll.
  describe('retry budget reset after success (F4)', () => {
    it('a fail → success → sustained-fail sequence gets a full fresh 1 + 3 budget before probing', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('t'))          // 1st series: fail (count 1)
        .mockResolvedValueOnce(matching('job-1'))        // success → resets failureCount to 0
        .mockRejectedValueOnce(new Error('t'))          // 2nd series: fail (count 1)
        .mockRejectedValueOnce(new Error('t'))          // fail (count 2)
        .mockRejectedValueOnce(new Error('t'))          // fail (count 3)
        .mockRejectedValueOnce(new Error('t'))          // fail (count 4) → exhausted → probe
        .mockRejectedValueOnce(new Error('t'));         // probe inconclusive → pause
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });

      await advance(POLL);     // fail (1)
      await advance(BACKOFF);  // success — resets the counter
      expect(result.current.paused).toBe(false);

      await advance(POLL);     // 2nd series fail (1) — proves the counter was reset (else this is the 2nd of the old series)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);  // fail (2)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);  // fail (3)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF);  // fail (4) → probe → inconclusive → pause
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
      // 6 polls (1 + 1 + 4) + 1 probe = 7. If the reset were deleted, the 2nd series would
      // pause after fewer polls (the old counter would already be near the limit).
      expect(mockGetMatchJob).toHaveBeenCalledTimes(7);
    });

    it('a completed probe that advances into a remainder gives it a fresh 1 + 3 budget (F9)', async () => {
      // Two chunks: chunk 1 (job-1) exhausts its retries → automatic-entry PROBE returns
      // `completed`, ingesting /a and advancing to the remainder chunk (job-2). The remainder
      // must NOT inherit chunk 1's exhausted counter — it needs a full fresh 1 + 3 before probing.
      const big = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(300 * 1024) });
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValueOnce({ jobId: 'job-2' });
      mockGetMatchJob
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t'))
        .mockRejectedValueOnce(new Error('t')).mockRejectedValueOnce(new Error('t')) // chunk 1: 1 + 3 exhausted
        .mockResolvedValueOnce(completed('job-1', [R('/a')]))  // probe: completed → ingest /a, start remainder job-2
        .mockRejectedValueOnce(new Error('t'))  // job-2 fail (fresh count 1)
        .mockRejectedValueOnce(new Error('t'))  // job-2 fail (2)
        .mockRejectedValueOnce(new Error('t'))  // job-2 fail (3)
        .mockRejectedValueOnce(new Error('t'))  // job-2 fail (4) → probe
        .mockRejectedValueOnce(new Error('t')); // job-2 probe inconclusive → pause
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([big('/a'), big('/b')]); });

      // Drive chunk 1 to exhaustion → probe completes → remainder job-2 begins.
      await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF);
      expect(mockStartMatchJob).toHaveBeenCalledTimes(2); // remainder started
      expect(result.current.paused).toBe(false);

      // The remainder's FIRST transient failure must NOT immediately probe/pause — proves the
      // reset. Without it, the stale count (4) would probe on this very first blip.
      await advance(POLL);    // job-2 fail (1)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF); // fail (2)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF); // fail (3)
      expect(result.current.paused).toBe(false);
      await advance(BACKOFF); // fail (4) → probe → inconclusive → pause
      expect(result.current.paused).toBe(true);
      expect(result.current.reason).toBe('unreachable');
    });
  });

  // #1864 F5 / AC11 — epoch guards hold across backoff, probe, and replacement-start stages.
  describe('stale guards across recovery stages (F5)', () => {
    it('cancel during a retry backoff clears the pending timer — no further polls', async () => {
      mockStartMatchJob.mockResolvedValueOnce({ jobId: 'job-1' });
      mockGetMatchJob.mockRejectedValueOnce(new Error('down'));
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); // fail → backoff scheduled
      expect(result.current.recovering).toBe(true);

      act(() => { result.current.cancel(); });
      mockGetMatchJob.mockClear();
      await advance(BACKOFF * 2); // the backoff timer must have been cleared
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
        .mockImplementationOnce(() => new Promise<MatchJobStatus>((resolve) => { resolveProbe = resolve; })) // probe in flight
        .mockImplementation(() => new Promise<MatchJobStatus>(() => {})); // job-2 poll never resolves
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); await advance(BACKOFF); await advance(BACKOFF); await advance(BACKOFF); // probe now pending

      // Supersede while the probe is in flight.
      await act(async () => { result.current.startMatching([{ path: '/b', title: 'B' }]); });
      // The stale probe resolves terminal-gone — it must not pause or mutate the new run.
      await act(async () => { resolveProbe?.(failed('job-1')); });
      expect(result.current.paused).toBe(false);
      expect(result.current.isMatching).toBe(true);
    });

    it('cancel during an in-flight replacement-start cancels the late job and does not mutate state', async () => {
      let resolveStart: ((v: { jobId: string }) => void) | undefined;
      mockStartMatchJob
        .mockResolvedValueOnce({ jobId: 'job-1' })
        .mockImplementationOnce(() => new Promise<{ jobId: string }>((resolve) => { resolveStart = resolve; })); // remainder start in flight
      mockGetMatchJob.mockRejectedValueOnce(new ApiError(404, { error: 'gone' })); // job-1 → allowance → replacement start
      const { result } = renderHook(() => useMatchJob());
      await act(async () => { result.current.startMatching([{ path: '/a', title: 'A' }]); });
      await advance(POLL); // 404 → beginRun(auto-remainder) → startMatchJob pending

      act(() => { result.current.cancel(); });
      // The replacement start resolves late — its job must be cancelled and ignored.
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
      await advance(POLL); // poll in flight

      unmount();
      // Late resolution after unmount must not throw or attempt a state update.
      await act(async () => { resolvePoll?.(completed('job-1', [R('/a')])); });
      expect(mockCancelMatchJob).toHaveBeenCalledWith('job-1'); // dispose abandoned the active job
    });
  });

  // #1831 — byte-budgeted packing (unchanged by the recovery rewrite).
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

    // #1864 F14 — the secondary 1,000-item count bound at its inclusive/exclusive boundary.
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
        // Order preserved and the union is exactly the input paths (none dropped/duplicated).
        expect(chunks.flat().map(c => c.path)).toEqual(items.map(c => c.path));
      });
    });

    // #1864 F15 — an individually-oversized candidate is diverted, never emitted over budget.
    describe('individually-oversized candidate (F15)', () => {
      const oversizedCandidate = (path: string): MatchCandidate => ({ path, title: 'x'.repeat(410 * 1024) }); // > 400 KiB

      it('diverts a lone oversized candidate to `oversized` with no emitted chunk', () => {
        const { chunks, oversized } = packMatchCandidates([oversizedCandidate('/big')]);
        expect(chunks).toEqual([]);
        expect(oversized.map(c => c.path)).toEqual(['/big']);
      });

      it('diverts the oversized candidate while still packing the fitting ones within budget', () => {
        const { chunks, oversized } = packMatchCandidates([oversizedCandidate('/big'), { path: '/a', title: 'A' }, { path: '/b', title: 'B' }]);
        expect(oversized.map(c => c.path)).toEqual(['/big']);
        expect(chunks.flat().map(c => c.path)).toEqual(['/a', '/b']);
        // No emitted { books } body exceeds the budget.
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

      // The oversized candidate is surfaced immediately as a `none` result and is NOT in any request.
      const oversizedResult = result.current.results.find(r => r.path === '/big');
      expect(oversizedResult?.confidence).toBe('none');
      const sent = mockStartMatchJob.mock.calls.flatMap(c => (c[0] as MatchCandidate[]).map(x => x.path));
      expect(sent).not.toContain('/big');
      expect(sent).toContain('/small');

      await advance(POLL); // the fitting candidate completes normally
      expect(result.current.results.find(r => r.path === '/small')?.confidence).toBe('high');
      // Every emitted body stayed within budget (only the small candidate was sent).
      for (const call of mockStartMatchJob.mock.calls) {
        expect(new TextEncoder().encode(JSON.stringify({ books: call[0] })).length).toBeLessThanOrEqual(MATCH_CHUNK_BYTE_BUDGET);
      }
    });
  });
});
