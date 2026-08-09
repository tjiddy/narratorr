import { ApiError } from '@/lib/api';

// Shared retry policy for every staged-import transport call.

/** Total attempts = 1 initial request + 4 retries. */
export const MAX_ATTEMPTS = 5;
/** Base backoff delay; the retry-`n` cap is `min(BACKOFF_CAP, BASE_DELAY_MS * 2^(n-1))`. */
export const BASE_DELAY_MS = 500;
export const BACKOFF_CAP = 15_000;
export const RETRY_AFTER_CAP = 60_000;

// Retry network failures, 429, and 5xx; other 4xx are permanent.
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 429 || error.status >= 500;
}

// Retry-After wins when present; otherwise use full-jitter exponential backoff.
export function retryDelayMs(retryIndex: number, error: unknown, random: () => number = Math.random): number {
  if (error instanceof ApiError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, RETRY_AFTER_CAP);
  }
  const cap = Math.min(BACKOFF_CAP, BASE_DELAY_MS * 2 ** (retryIndex - 1));
  return random() * cap;
}

export function withSignal(options: RetryOptions | undefined, signal: AbortSignal | undefined): RetryOptions {
  return { ...options, ...(signal ? { signal } : {}) };
}

export interface RetryOptions {
  /** Aborts an in-flight backoff sleep and stops further attempts. */
  signal?: AbortSignal;
  /** Injectable jitter source (deterministic in tests). */
  random?: () => number;
  /** Injectable abortable sleep (deterministic in tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Abort, permanent failure, and exhaustion rethrow; eligible failures retry up to MAX_ATTEMPTS.
export async function runWithRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, random = Math.random, sleep = abortableSleep } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(retryDelayMs(attempt, error, random), signal);
    }
  }
  throw lastError;
}
