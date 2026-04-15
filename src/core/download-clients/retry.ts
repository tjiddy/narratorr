import { DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface RetryConfig {
  clientName: string;
  maxRetries?: number;
  delayMs?: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: () => Promise<void>;
  onExhausted?: (context: { clientName: string; attempts: number; error: unknown }) => void;
}

export async function requestWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  const { clientName, maxRetries = 1, delayMs = 0, shouldRetry, onRetry, onExhausted } = config;
  let lastError: unknown;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      attempts++;
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < maxRetries && shouldRetry(error)) {
        if (onRetry) await onRetry();
        // Jitter prevents synchronized retry storms across concurrent clients
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs + Math.random() * delayMs * 0.3));
        continue;
      }
      break;
    }
  }

  if (onExhausted) {
    try {
      await Promise.resolve(onExhausted({ clientName, attempts, error: lastError }));
    } catch {
      // fire-and-forget — callback errors must not mask the real failure
    }
  }

  if (lastError instanceof DownloadClientError) {
    throw lastError;
  }

  if (isTimeoutError(lastError)) {
    throw new DownloadClientTimeoutError(clientName, (lastError as Error).message, { cause: lastError });
  }

  throw new DownloadClientError(
    clientName,
    getErrorMessage(lastError),
    { cause: lastError },
  );
}
