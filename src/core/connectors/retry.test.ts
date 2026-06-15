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

  // ── shutdown-abort contract (#1512) ──────────────────────────────────────────

  it('does NOT start a second attempt when the signal is already aborted (deadline abort is terminal)', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = new Error('retryable');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      requestWithRetry(fn, { maxRetries: 1, delayMs: 10, shouldRetry: () => true, signal: controller.signal }),
    ).rejects.toBe(err);
    // First attempt ran (it was in flight); the abort prevents the retry.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('interrupts a pending backoff sleep and skips the retry when the signal aborts mid-backoff', async () => {
    const controller = new AbortController();
    const err = new Error('retryable');
    const fn = vi.fn().mockRejectedValue(err);

    // A long backoff: if the abort did not interrupt the sleep, this test would
    // hang well past its timeout instead of resolving promptly.
    const promise = requestWithRetry(fn, { maxRetries: 1, delayMs: 10_000, shouldRetry: () => true, signal: controller.signal });
    // Let the first attempt reject and the backoff sleep register its abort listener.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1); // no second attempt after the mid-backoff abort
  });

  it('no-signal behavior is unchanged — retryable errors still retry once', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValueOnce('ok');

    const result = await requestWithRetry(fn, { maxRetries: 1, delayMs: 0, shouldRetry: () => true });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
