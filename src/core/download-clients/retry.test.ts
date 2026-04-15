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

  describe('.cause preservation', () => {
    it('timeout wrapping path preserves original error as .cause', async () => {
      const originalError = new Error('Request timed out');
      const fn = vi.fn().mockRejectedValue(originalError);
      try {
        await requestWithRetry(fn, { clientName: 'TestClient', shouldRetry: () => false });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DownloadClientTimeoutError);
        expect((error as DownloadClientTimeoutError).cause).toBe(originalError);
      }
    });

    it('generic DownloadClientError wrapping path preserves original error as .cause', async () => {
      const originalError = new Error('Connection refused on port 8080');
      const fn = vi.fn().mockRejectedValue(originalError);
      try {
        await requestWithRetry(fn, { clientName: 'TestClient', shouldRetry: () => false });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).cause).toBe(originalError);
      }
    });

    it('passthrough DownloadClientError is NOT re-wrapped — no .cause added by helper', async () => {
      const typed = new DownloadClientError('TestClient', 'already typed');
      const fn = vi.fn().mockRejectedValue(typed);
      try {
        await requestWithRetry(fn, { clientName: 'TestClient', shouldRetry: () => false });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBe(typed);
        expect((error as DownloadClientError).cause).toBeUndefined();
      }
    });

    it('non-Error rejection (string) sets .cause to the raw value', async () => {
      const fn = vi.fn().mockRejectedValue('string error');
      try {
        await requestWithRetry(fn, { clientName: 'TestClient', shouldRetry: () => false });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).cause).toBe('string error');
      }
    });
  });

  describe('delayMs / jitter', () => {
    it('delayMs omitted (default 0) — retries fire immediately', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('retry'))
        .mockResolvedValueOnce('ok');
      const result = await requestWithRetry(fn, {
        clientName: 'TestClient',
        shouldRetry: () => true,
      });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('delayMs > 0 — delay is within jitter range (delayMs to delayMs * 1.3)', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);

      const fnCall = vi.fn()
        .mockRejectedValueOnce(new Error('retry'))
        .mockResolvedValueOnce('ok');
      await requestWithRetry(fnCall, {
        clientName: 'TestClient',
        delayMs: 100,
        shouldRetry: () => true,
      });
      expect(delays.length).toBe(1);
      expect(delays[0]).toBeGreaterThanOrEqual(100);
      expect(delays[0]).toBeLessThanOrEqual(130);
      vi.restoreAllMocks();
    });

    it('maxRetries=0 — no delay scheduled regardless of delayMs', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);

      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(
        requestWithRetry(fn, {
          clientName: 'TestClient',
          maxRetries: 0,
          delayMs: 100,
          shouldRetry: () => true,
        }),
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(delays.length).toBe(0);
      vi.restoreAllMocks();
    });

    it('delayMs > 0 with maxRetries=1 — delay occurs once between attempts', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);

      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('retry'))
        .mockResolvedValueOnce('ok');
      await requestWithRetry(fn, {
        clientName: 'TestClient',
        maxRetries: 1,
        delayMs: 200,
        shouldRetry: () => true,
      });
      expect(delays.length).toBe(1);
      expect(delays[0]).toBeGreaterThanOrEqual(200);
      expect(delays[0]).toBeLessThanOrEqual(260);
      vi.restoreAllMocks();
    });
  });

  describe('onExhausted callback', () => {
    it('fires on retry exhaustion with { clientName, attempts, error }', async () => {
      const onExhausted = vi.fn();
      const failError = new Error('always fails');
      const fn = vi.fn().mockRejectedValue(failError);
      await expect(
        requestWithRetry(fn, {
          clientName: 'TestClient',
          maxRetries: 2,
          shouldRetry: () => true,
          onExhausted,
        }),
      ).rejects.toThrow();
      expect(onExhausted).toHaveBeenCalledOnce();
      expect(onExhausted).toHaveBeenCalledWith({
        clientName: 'TestClient',
        attempts: 3,
        error: failError,
      });
    });

    it('omitting onExhausted does not throw on exhaustion', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(
        requestWithRetry(fn, {
          clientName: 'TestClient',
          shouldRetry: () => true,
        }),
      ).rejects.toThrow(DownloadClientError);
    });

    it('onExhausted throwing is swallowed — real error still thrown', async () => {
      const onExhausted = vi.fn().mockImplementation(() => { throw new Error('callback boom'); });
      const fn = vi.fn().mockRejectedValue(new Error('real error'));
      try {
        await requestWithRetry(fn, {
          clientName: 'TestClient',
          shouldRetry: () => true,
          onExhausted,
        });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).message).toBe('real error');
      }
      expect(onExhausted).toHaveBeenCalledOnce();
    });

    it('fires with attempts=1 when maxRetries=0', async () => {
      const onExhausted = vi.fn();
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      await expect(
        requestWithRetry(fn, {
          clientName: 'TestClient',
          maxRetries: 0,
          shouldRetry: () => true,
          onExhausted,
        }),
      ).rejects.toThrow();
      expect(onExhausted).toHaveBeenCalledWith(
        expect.objectContaining({ attempts: 1 }),
      );
    });
  });

  describe('end-to-end', () => {
    it('full retry→delay→exhaust→callback→throw flow with .cause chain', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return originalSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout);

      const onExhausted = vi.fn();
      const rootError = new Error('Connection refused on port 8080');
      const fn = vi.fn().mockRejectedValue(rootError);

      try {
        await requestWithRetry(fn, {
          clientName: 'TestClient',
          maxRetries: 2,
          delayMs: 100,
          shouldRetry: () => true,
          onExhausted,
        });
        expect.fail('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DownloadClientError);
        expect((error as DownloadClientError).cause).toBe(rootError);
      }

      expect(fn).toHaveBeenCalledTimes(3);
      expect(delays.length).toBe(2);
      expect(onExhausted).toHaveBeenCalledWith({
        clientName: 'TestClient',
        attempts: 3,
        error: rootError,
      });
      vi.restoreAllMocks();
    });
  });
});
