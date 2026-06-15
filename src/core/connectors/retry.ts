export interface ConnectorRetryConfig {
  maxRetries?: number;
  delayMs?: number;
  shouldRetry: (error: unknown) => boolean;
  /**
   * Shutdown-drain abort. When aborted, the retry short-circuits: no second
   * attempt is started and any pending backoff sleep is interrupted immediately.
   * A deadline abort is therefore terminal — distinct from a normal retryable
   * timeout — so `stop()` can bound how long an in-flight flush keeps running.
   */
  signal?: AbortSignal;
}

/**
 * Provider-agnostic single-retry helper (mirrors `download-clients/retry.ts` but
 * decoupled from any concrete error type). Runs `fn`; on a thrown error that
 * `shouldRetry` accepts, retries once with optional jittered backoff. The
 * original error is rethrown unchanged on exhaustion so callers can inspect its
 * concrete type (e.g. `ConnectorRequestError.retryable`/`fieldErrors`).
 *
 * An optional `signal` makes the retry abort-aware: an aborted signal (e.g. the
 * shutdown drain deadline) prevents a second attempt and interrupts a pending
 * backoff sleep, so a deadline abort never burns the retry it just cancelled.
 */
export async function requestWithRetry<T>(fn: () => Promise<T>, config: ConnectorRetryConfig): Promise<T> {
  const { maxRetries = 1, delayMs = 0, shouldRetry, signal } = config;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      // A shutdown-deadline abort is terminal: don't retry (and don't sleep) once
      // the signal is aborted, even if the error itself is otherwise retryable.
      if (attempt < maxRetries && !signal?.aborted && shouldRetry(error)) {
        // Jitter prevents synchronized retry storms across concurrent flushes.
        // unref() the backoff timer so a shutdown landing mid-backoff isn't held
        // open by this sleep — the in-flight retry is still awaited by the caller
        // (ConnectorService's `draining` chain), it just no longer pins the loop.
        if (delayMs > 0) {
          const aborted = await backoffSleep(delayMs + Math.random() * delayMs * 0.3, signal);
          // Aborted mid-backoff → the deadline fired; stop without a retry.
          if (aborted) break;
        }
        continue;
      }
      break;
    }
  }

  throw lastError;
}

/**
 * Sleep `ms`, resolving early (with `true`) if `signal` aborts during the wait so
 * a shutdown deadline doesn't have to wait out the full backoff. Resolves `false`
 * when the delay elapses normally. The timer is `unref()`'d so it never pins the
 * event loop past shutdown.
 */
function backoffSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onAbort = () => { clearTimeout(t); resolve(true); };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    t.unref();
    if (signal) {
      if (signal.aborted) { clearTimeout(t); resolve(true); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
