import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  MAX_ATTEMPTS,
  BASE_DELAY_MS,
  BACKOFF_CAP,
  RETRY_AFTER_CAP,
  isRetryableError,
  retryDelayMs,
  runWithRetry,
  abortableSleep,
} from './retry.js';

describe('staged-import retry constants', () => {
  it('pins the exact #1893 §F60 numeric contract', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(BASE_DELAY_MS).toBe(500);
    expect(BACKOFF_CAP).toBe(15_000);
    expect(RETRY_AFTER_CAP).toBe(60_000);
  });
});

describe('isRetryableError', () => {
  it('retries transport/network failures (non-ApiError)', () => {
    expect(isRetryableError(new Error('network down'))).toBe(true);
    expect(isRetryableError(new TypeError('Failed to fetch'))).toBe(true);
  });
  it('retries 5xx and 429', () => {
    expect(isRetryableError(new ApiError(500, {}))).toBe(true);
    expect(isRetryableError(new ApiError(503, {}))).toBe(true);
    expect(isRetryableError(new ApiError(429, {}))).toBe(true);
  });
  it('does NOT retry other 4xx', () => {
    expect(isRetryableError(new ApiError(400, {}))).toBe(false);
    expect(isRetryableError(new ApiError(404, {}))).toBe(false);
    expect(isRetryableError(new ApiError(409, {}))).toBe(false);
    expect(isRetryableError(new ApiError(413, {}))).toBe(false);
    expect(isRetryableError(new ApiError(422, {}))).toBe(false);
  });
});

describe('retryDelayMs — full-jitter backoff', () => {
  it('caps at 500 / 1000 / 2000 / 4000 for retries n=1..4 (random()=1 ⇒ delay=cap)', () => {
    const err = new ApiError(500, {});
    const one = () => 1;
    expect(retryDelayMs(1, err, one)).toBe(500);
    expect(retryDelayMs(2, err, one)).toBe(1000);
    expect(retryDelayMs(3, err, one)).toBe(2000);
    expect(retryDelayMs(4, err, one)).toBe(4000);
  });
  it('applies full jitter: delay = random() * cap', () => {
    const err = new ApiError(500, {});
    expect(retryDelayMs(3, err, () => 0.5)).toBe(1000); // 0.5 * 2000
    expect(retryDelayMs(1, err, () => 0)).toBe(0);
  });
  it('never exceeds BACKOFF_CAP even for a large retry index', () => {
    const err = new ApiError(500, {});
    expect(retryDelayMs(10, err, () => 1)).toBe(BACKOFF_CAP);
  });
});

describe('retryDelayMs — Retry-After precedence', () => {
  it('honors a valid parsed Retry-After over the jittered backoff', () => {
    const err = new ApiError(429, {}, 5_000);
    expect(retryDelayMs(1, err, () => 1)).toBe(5_000);
  });
  it('clamps a Retry-After above RETRY_AFTER_CAP', () => {
    const err = new ApiError(429, {}, 120_000);
    expect(retryDelayMs(1, err, () => 1)).toBe(RETRY_AFTER_CAP);
  });
  it('falls back to backoff when Retry-After is absent (invalid header parsed to undefined)', () => {
    const err = new ApiError(429, {}); // retryAfterMs undefined
    expect(retryDelayMs(2, err, () => 1)).toBe(1000);
  });
});

describe('runWithRetry', () => {
  it('exhausts after exactly MAX_ATTEMPTS total attempts, sleeping MAX_ATTEMPTS-1 times', async () => {
    const delays: number[] = [];
    const sleep = vi.fn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });
    const fn = vi.fn(() => Promise.reject(new ApiError(500, {})));
    await expect(runWithRetry(fn, { sleep, random: () => 1 })).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(delays).toEqual([500, 1000, 2000, 4000]);
  });

  it('resolves on a transient-then-success sequence', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiError(503, {}))
      .mockResolvedValueOnce('ok');
    const result = await runWithRetry(fn, { sleep: () => Promise.resolve(), random: () => 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a non-retryable 4xx', async () => {
    const fn = vi.fn(() => Promise.reject(new ApiError(400, { error: 'bad' })));
    await expect(runWithRetry(fn, { sleep: () => Promise.resolve() })).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(() => Promise.resolve('x'));
    await expect(runWithRetry(fn, { signal: controller.signal })).rejects.toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });

  it('aborts mid-backoff — a signal fired during the sleep stops further attempts', async () => {
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.reject(new ApiError(500, {})));
    const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
      controller.abort();
      return Promise.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    });
    await expect(runWithRetry(fn, { signal: controller.signal, sleep })).rejects.toBeTruthy();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('abortableSleep', () => {
  it('resolves after the delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = abortableSleep(1000);
      vi.advanceTimersByTime(1000);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it('rejects immediately if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1000, controller.signal)).rejects.toBeTruthy();
  });
  it('rejects if the signal fires mid-wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const controller = new AbortController();
      const p = abortableSleep(1000, controller.signal);
      controller.abort();
      await expect(p).rejects.toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
