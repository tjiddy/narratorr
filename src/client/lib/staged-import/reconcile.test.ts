import { describe, it, expect, vi } from 'vitest';
import { ApiError, type SubmissionResponse, type Api } from '@/lib/api';
import { reconcileByClient } from './reconcile.js';

const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };
const summary = (status: 'receiving' | 'processing' | 'complete', id = 7): SubmissionResponse =>
  ({ id, status, itemsIncluded: false } as unknown as SubmissionResponse);

describe('reconcileByClient (F18)', () => {
  it('rejoins on processing', async () => {
    const api = { getSubmissionByClientId: vi.fn(() => Promise.resolve(summary('processing'))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    expect(await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep })).toEqual({ action: 'rejoin', submissionId: 7, status: 'processing' });
  });

  it('rejoins on complete (poll then drives the one-time detail + surface)', async () => {
    const api = { getSubmissionByClientId: vi.fn(() => Promise.resolve(summary('complete'))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    expect(await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep })).toEqual({ action: 'rejoin', submissionId: 7, status: 'complete' });
  });

  it('evicts on a receiving header (inert, safely re-runnable)', async () => {
    const api = { getSubmissionByClientId: vi.fn(() => Promise.resolve(summary('receiving'))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    expect(await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep })).toEqual({ action: 'evict', reason: 'receiving' });
  });

  it('treats a 404 as the never-landed evict arm, NOT a lookup failure', async () => {
    const api = { getSubmissionByClientId: vi.fn(() => Promise.reject(new ApiError(404, { error: 'not-found' }))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    expect(await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep })).toEqual({ action: 'evict', reason: 'never-landed' });
  });

  it('retries a transient failure then succeeds', async () => {
    const getSubmissionByClientId = vi
      .fn<() => Promise<SubmissionResponse>>()
      .mockRejectedValueOnce(new ApiError(503, { error: 'x' }))
      .mockResolvedValueOnce(summary('processing'));
    const api = { getSubmissionByClientId } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    const r = await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep });
    expect(r).toEqual({ action: 'rejoin', submissionId: 7, status: 'processing' });
    expect(getSubmissionByClientId).toHaveBeenCalledTimes(2);
  });

  it('honors a 429 Retry-After then succeeds', async () => {
    const getSubmissionByClientId = vi
      .fn<() => Promise<SubmissionResponse>>()
      .mockRejectedValueOnce(new ApiError(429, { error: 'slow' }, 1_000))
      .mockResolvedValueOnce(summary('complete'));
    const api = { getSubmissionByClientId } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    const r = await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep });
    expect(r.action).toBe('rejoin');
    expect(getSubmissionByClientId).toHaveBeenCalledTimes(2);
  });

  it('exhaustion retains the pointer and reports lookup-failed', async () => {
    const api = { getSubmissionByClientId: vi.fn(() => Promise.reject(new ApiError(503, { error: 'x' }))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    const r = await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep });
    expect(r).toEqual({ action: 'lookup-failed' });
    expect(api.getSubmissionByClientId).toHaveBeenCalledTimes(5);
  });

  it('aborts mid-lookup — discards the result', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = { getSubmissionByClientId: vi.fn(() => Promise.reject(new DOMException('Aborted', 'AbortError'))) } as unknown as Pick<Api, 'getSubmissionByClientId'>;
    expect(await reconcileByClient({ api, clientSubmissionId: 'u', retry: noSleep, signal: controller.signal })).toEqual({ action: 'aborted' });
  });
});
