export interface ConnectorRetryConfig {
  maxRetries?: number;
  delayMs?: number;
  shouldRetry: (error: unknown) => boolean;
}

/**
 * Provider-agnostic single-retry helper (mirrors `download-clients/retry.ts` but
 * decoupled from any concrete error type). Runs `fn`; on a thrown error that
 * `shouldRetry` accepts, retries once with optional jittered backoff. The
 * original error is rethrown unchanged on exhaustion so callers can inspect its
 * concrete type (e.g. `ConnectorRequestError.retryable`/`fieldErrors`).
 */
export async function requestWithRetry<T>(fn: () => Promise<T>, config: ConnectorRetryConfig): Promise<T> {
  const { maxRetries = 1, delayMs = 0, shouldRetry } = config;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < maxRetries && shouldRetry(error)) {
        // Jitter prevents synchronized retry storms across concurrent flushes.
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs + Math.random() * delayMs * 0.3));
        continue;
      }
      break;
    }
  }

  throw lastError;
}
