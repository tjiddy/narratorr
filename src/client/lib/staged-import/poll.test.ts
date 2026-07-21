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
    api: { getImportSubmission: vi.fn() } as unknown as Pick<Api, 'getImportSubmission'>,
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
    deps.api.getImportSubmission = vi.fn((_id: number, includeItems: boolean) =>
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
    deps.api.getImportSubmission = vi.fn(() => new Promise<SubmissionResponse>((r) => { resolveSummary = r; })) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1); // immediate poll starts, never resolves yet
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); // two ticks fire but are coalesced
    expect(deps.api.getImportSubmission).toHaveBeenCalledTimes(1); // single-flight
    resolveSummary(summary('processing'));
    await vi.advanceTimersByTimeAsync(0);
    c.stop();
  });
});

describe('createPollController — failure contracts', () => {
  it('processing-poll transport exhaustion → pollLostContact, stop, hint retained', async () => {
    const deps = baseDeps();
    deps.api.getImportSubmission = vi.fn(() => Promise.reject(new ApiError(503, { error: 'x' }))) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onBanner).toHaveBeenCalledWith('pollLostContact');
    expect(deps.onEvictHint).not.toHaveBeenCalled();
  });

  it('finalized 404 → finalizedMissing invariant + evict hint + stop', async () => {
    const deps = baseDeps();
    deps.api.getImportSubmission = vi.fn(() => Promise.reject(new ApiError(404, { error: 'not-found' }))) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onBanner).toHaveBeenCalledWith('finalizedMissing');
    expect(deps.onEvictHint).toHaveBeenCalledTimes(1);
  });

  it('terminal-detail transport exhaustion → detailLoadFailed, no onComplete (hint retained)', async () => {
    const deps = baseDeps();
    deps.api.getImportSubmission = vi.fn((_id: number, includeItems: boolean) =>
      includeItems ? Promise.reject(new ApiError(503, { error: 'x' })) : Promise.resolve(summary('complete')),
    ) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onComplete).not.toHaveBeenCalled();
    expect(deps.onBanner).toHaveBeenCalledWith('detailLoadFailed');
    expect(deps.onEvictHint).not.toHaveBeenCalled();
  });

  it('terminal-detail 404 is finalized data loss → finalizedMissing + evict (NOT detailLoadFailed) (F3)', async () => {
    // Summary is `complete`, but the one-time detail fetch 404s. A finalized header can never
    // be GC'd, so this is the SAME invariant/data-loss signal as a summary 404 — surface
    // `finalizedMissing` once and evict the dead hint, rather than a retryable results-load failure.
    const deps = baseDeps();
    deps.api.getImportSubmission = vi.fn((_id: number, includeItems: boolean) =>
      includeItems ? Promise.reject(new ApiError(404, { error: 'not-found' })) : Promise.resolve(summary('complete')),
    ) as never;
    const c = createPollController(deps);
    c.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.onComplete).not.toHaveBeenCalled();
    expect(deps.onBanner).toHaveBeenCalledWith('finalizedMissing');
    expect(deps.onBanner).not.toHaveBeenCalledWith('detailLoadFailed');
    expect(deps.onEvictHint).toHaveBeenCalledTimes(1);
  });

  it('stop() before a poll resolves discards the late result (no onSummary/onComplete)', async () => {
    const deps = baseDeps();
    let resolveSummary: (v: SubmissionResponse) => void = () => {};
    deps.api.getImportSubmission = vi.fn(() => new Promise<SubmissionResponse>((r) => { resolveSummary = r; })) as never;
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
