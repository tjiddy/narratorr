export interface ConnectorRetryConfig {
  maxRetries?: number;
  delayMs?: number;
  shouldRetry: (error: unknown) => boolean;
  /** Terminal shutdown signal: interrupt backoff and start no further attempt. */
  signal?: AbortSignal;
}

// Provider-agnostic retry that preserves the original error on exhaustion. Shutdown
// aborts are terminal and interrupt backoff rather than consuming another attempt.
export async function requestWithRetry<T>(fn: () => Promise<T>, config: ConnectorRetryConfig): Promise<T> {
  const { maxRetries = 1, delayMs = 0, shouldRetry, signal } = config;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < maxRetries && !signal?.aborted && shouldRetry(error)) {
        // Jitter avoids synchronized retries; the unref'd timer cannot pin shutdown.
        if (delayMs > 0) {
          const aborted = await backoffSleep(delayMs + Math.random() * delayMs * 0.3, signal);
          if (aborted) break;
        }
        continue;
      }
      break;
    }
  }

  throw lastError;
}

/** Return true when an abort interrupts the unref'd delay. */
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
