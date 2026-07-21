import { ApiError } from '@/lib/api';

/**
 * Shared client retry contract for the staged-import transport (#1902, F40/F43/F60).
 *
 * ONE home for the numeric retry policy — every staged request site (chunk PUT,
 * create, finalize, by-client lookup, summary poll, terminal detail) imports these
 * constants and {@link runWithRetry}; there is no second copy. The values are carried
 * forward verbatim from #1893's Transport error contract (§F60).
 */

/** Total attempts = 1 initial request + 4 retries. */
export const MAX_ATTEMPTS = 5;
/** Base backoff delay; the retry-`n` cap is `min(BACKOFF_CAP, BASE_DELAY_MS * 2^(n-1))`. */
export const BASE_DELAY_MS = 500;
/** Ceiling on the exponential backoff cap. */
export const BACKOFF_CAP = 15_000;
/** Ceiling applied to a server-provided `Retry-After` before it is honored. */
export const RETRY_AFTER_CAP = 60_000;

/**
 * A request is retryable on a transport/network failure (anything that is not an
 * {@link ApiError} — the request never produced an HTTP response), a 5xx, or a 429.
 * Every other 4xx is a permanent, non-retryable client error.
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // transport / network — no HTTP response
  return error.status === 429 || error.status >= 500;
}

/**
 * Delay before retry `n` (one-based, `n = 1..4` — the retries AFTER the initial
 * request). A parsed `Retry-After` (surfaced as {@link ApiError.retryAfterMs}) takes
 * precedence, clamped to {@link RETRY_AFTER_CAP}; otherwise full-jitter exponential
 * backoff: `random() * min(BACKOFF_CAP, BASE_DELAY_MS * 2^(n-1))`. The four backoff
 * caps are therefore 500 / 1000 / 2000 / 4000 ms.
 */
export function retryDelayMs(retryIndex: number, error: unknown, random: () => number = Math.random): number {
  if (error instanceof ApiError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, RETRY_AFTER_CAP);
  }
  const cap = Math.min(BACKOFF_CAP, BASE_DELAY_MS * 2 ** (retryIndex - 1));
  return random() * cap;
}

export interface RetryOptions {
  /** Aborts an in-flight backoff sleep and stops further attempts. */
  signal?: AbortSignal;
  /** Injectable jitter source (deterministic in tests). */
  random?: () => number;
  /** Injectable abortable sleep (deterministic in tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Abortable sleep — rejects with the signal's abort reason if aborted mid-wait. */
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

/**
 * Run `fn` with the shared retry policy: up to {@link MAX_ATTEMPTS} total attempts,
 * retrying only {@link isRetryableError} failures with {@link retryDelayMs} backoff.
 * A non-retryable error, an exhausted retry budget, or an aborted signal rethrows the
 * last error (or the abort reason). `fn` receives the one-based attempt number.
 */
export async function runWithRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, random = Math.random, sleep = abortableSleep } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      return await fn(attempt);
    } catch (error: unknown) {
      lastError = error;
      // Non-retryable, or no retries left → surface immediately.
      if (!isRetryableError(error) || attempt >= MAX_ATTEMPTS) throw error;
      // `attempt` is one-based; the delay for the *next* retry uses the same index.
      await sleep(retryDelayMs(attempt, error, random), signal);
    }
  }
  throw lastError;
}
