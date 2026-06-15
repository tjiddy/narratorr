import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestWithRetry } from './retry.js';

describe('requestWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unref()s the backoff delay timer so a shutdown mid-backoff is not pinned by the sleep (#1498)', async () => {
    const unref = vi.fn();
    // Fire the callback synchronously so the backoff resolves immediately, then
    // hand back a fake handle whose unref() we can assert on.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return { unref } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValueOnce('ok');

    const result = await requestWithRetry(fn, { maxRetries: 1, delayMs: 10, shouldRetry: () => true });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1); // exactly the backoff sleep
    expect(unref).toHaveBeenCalledTimes(1);         // and it was unref()'d
  });

  it('does not arm a backoff timer when delayMs is 0', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValueOnce('ok');

    await requestWithRetry(fn, { maxRetries: 1, delayMs: 0, shouldRetry: () => true });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('rethrows the original error when retries are exhausted', async () => {
    const err = new Error('still failing');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(requestWithRetry(fn, { maxRetries: 1, delayMs: 0, shouldRetry: () => true })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
