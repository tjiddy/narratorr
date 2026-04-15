import { describe, expect, it, vi } from 'vitest';
import { DownloadClientAuthError, DownloadClientError, DownloadClientTimeoutError } from './errors.js';
import { requestWithRetry } from './retry.js';

describe('requestWithRetry', () => {
  it('succeeds on first attempt — returns result without retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await requestWithRetry(fn, {
      clientName: 'TestClient',
      shouldRetry: () => true,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on matching condition — calls fn twice, returns second result', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('retryable'))
      .mockResolvedValueOnce('recovered');
    const result = await requestWithRetry(fn, {
      clientName: 'TestClient',
      shouldRetry: (e) => e instanceof Error && e.message === 'retryable',
      onRetry,
    });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries limit — stops after N attempts, throws last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        maxRetries: 3,
        shouldRetry: () => true,
      }),
    ).rejects.toThrow(DownloadClientError);
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('does NOT retry when condition does not match — throws immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('non-retryable'));
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => false,
      }),
    ).rejects.toThrow(DownloadClientError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes through DownloadClientAuthError when retries exhausted', async () => {
    const authError = new DownloadClientAuthError('TestClient', 'bad creds');
    const fn = vi.fn().mockRejectedValue(authError);
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: (e) => e instanceof DownloadClientAuthError,
      }),
    ).rejects.toThrow(authError);
  });

  it('wraps timeout errors as DownloadClientTimeoutError via isTimeoutError guard', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Request timed out'));
    try {
      await requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => false,
      });
      expect.fail('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DownloadClientTimeoutError);
      expect((error as DownloadClientTimeoutError).clientName).toBe('TestClient');
      expect((error as DownloadClientTimeoutError).message).toBe('Request timed out');
    }
  });

  it('wraps "Connection timed out" as DownloadClientTimeoutError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Connection timed out'));
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => false,
      }),
    ).rejects.toBeInstanceOf(DownloadClientTimeoutError);
  });

  it('wraps non-timeout network errors as DownloadClientError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Connection refused on port 8080'));
    try {
      await requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => false,
      });
      expect.fail('should have thrown');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DownloadClientError);
      expect(error).not.toBeInstanceOf(DownloadClientTimeoutError);
      expect((error as DownloadClientError).clientName).toBe('TestClient');
      expect((error as DownloadClientError).message).toBe('Connection refused on port 8080');
    }
  });

  it('passes through existing DownloadClientError subclasses', async () => {
    const typed = new DownloadClientError('TestClient', 'already typed');
    const fn = vi.fn().mockRejectedValue(typed);
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => false,
      }),
    ).rejects.toBe(typed);
  });

  it('concurrent calls do not interfere — no shared mutable state', async () => {
    const fn1 = vi.fn()
      .mockRejectedValueOnce(new Error('retry1'))
      .mockResolvedValueOnce('result1');
    const fn2 = vi.fn()
      .mockRejectedValueOnce(new Error('retry2'))
      .mockResolvedValueOnce('result2');

    const [r1, r2] = await Promise.all([
      requestWithRetry(fn1, { clientName: 'Client1', shouldRetry: () => true }),
      requestWithRetry(fn2, { clientName: 'Client2', shouldRetry: () => true }),
    ]);

    expect(r1).toBe('result1');
    expect(r2).toBe('result2');
    expect(fn1).toHaveBeenCalledTimes(2);
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  it('defaults maxRetries to 1 when not specified', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(
      requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => true,
      }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(2); // 1 initial + 1 retry (default)
  });
});
