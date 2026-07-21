import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, type SubmissionResponse, type Api } from '@/lib/api';
import { createPollController, POLL_INTERVAL_MS } from './poll.js';

const retry = { sleep: () => Promise.resolve(), random: () => 0 };

const summary = (status: 'receiving' | 'processing' | 'complete'): SubmissionResponse =>
  ({ id: 10, status, itemsIncluded: false } as unknown as SubmissionResponse);
const detail = (): SubmissionResponse =>
  ({ id: 10, status: 'complete', itemsIncluded: true, items: [] } as unknown as SubmissionResponse);

beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
afterEach(() => vi.useRealTimers());

function baseDeps() {
  return {
    api: { getSubmission: vi.fn() } as unknown as Pick<Api, 'getSubmission'>,
    submissionId: 10,
    retry,
    onSummary: vi.fn(),
    onComplete: vi.fn(),
    onBanner: vi.fn(),
    onEvictHint: vi.fn(),
  };
}

describe('createPollController — completion', () => {
  it('polls summary until complete, then fetches detail exactly once', async () => {
    const deps = baseDeps();
    let n = 0;
    deps.api.getSubmission = vi.fn((_id: number, includeItems: boolean) =>
      includeItems ? Promise.resolve(detail()) : Promise.resolve(summary(n++ === 0 ? 'processing' : 'complete')),
    ) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1); // immediate poll → processing
    expect(deps.onComplete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // next tick → complete → detail
    expect(deps.onComplete).toHaveBeenCalledTimes(1);
    expect(deps.onComplete).toHaveBeenCalledWith(expect.objectContaining({ itemsIncluded: true }));
    // No further detail fetches after the interval was cleared.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(deps.onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('createPollController — single-flight (F2)', () => {
  it('skips a tick that fires while a summary poll is still in flight', async () => {
    const deps = baseDeps();
    let resolveSummary: (v: SubmissionResponse) => void = () => {};
    deps.api.getSubmission = vi.fn(() => new Promise<SubmissionResponse>((r) => { resolveSummary = r; })) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1); // immediate poll starts, never resolves yet
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); // two ticks fire but are coalesced
    expect(deps.api.getSubmission).toHaveBeenCalledTimes(1); // single-flight
    resolveSummary(summary('processing'));
    await vi.advanceTimersByTimeAsync(0);
    c.stop();
  });
});

describe('createPollController — failure contracts', () => {
  it('processing-poll transport exhaustion → pollLostContact, stop, hint retained', async () => {
    const deps = baseDeps();
    deps.api.getSubmission = vi.fn(() => Promise.reject(new ApiError(503, { error: 'x' }))) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onBanner).toHaveBeenCalledWith('pollLostContact');
    expect(deps.onEvictHint).not.toHaveBeenCalled();
  });

  it('finalized 404 → finalizedMissing invariant + evict hint + stop', async () => {
    const deps = baseDeps();
    deps.api.getSubmission = vi.fn(() => Promise.reject(new ApiError(404, { error: 'not-found' }))) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onBanner).toHaveBeenCalledWith('finalizedMissing');
    expect(deps.onEvictHint).toHaveBeenCalledTimes(1);
  });

  it('terminal-detail exhaustion → detailLoadFailed, no onComplete (hint retained)', async () => {
    const deps = baseDeps();
    deps.api.getSubmission = vi.fn((_id: number, includeItems: boolean) =>
      includeItems ? Promise.reject(new ApiError(503, { error: 'x' })) : Promise.resolve(summary('complete')),
    ) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onComplete).not.toHaveBeenCalled();
    expect(deps.onBanner).toHaveBeenCalledWith('detailLoadFailed');
  });

  it('stop() before a poll resolves discards the late result (no onSummary/onComplete)', async () => {
    const deps = baseDeps();
    let resolveSummary: (v: SubmissionResponse) => void = () => {};
    deps.api.getSubmission = vi.fn(() => new Promise<SubmissionResponse>((r) => { resolveSummary = r; })) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    c.stop();
    resolveSummary(summary('complete'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onSummary).not.toHaveBeenCalled();
    expect(deps.onComplete).not.toHaveBeenCalled();
  });
});
