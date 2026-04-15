import { DownloadClientError, DownloadClientTimeoutError, isTimeoutError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface RetryConfig {
  clientName: string;
  maxRetries?: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: () => Promise<void>;
}

export async function requestWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
): Promise<T> {
  const { clientName, maxRetries = 1, shouldRetry, onRetry } = config;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      if (attempt < maxRetries && shouldRetry(error)) {
        if (onRetry) await onRetry();
        continue;
      }
      break;
    }
  }

  if (lastError instanceof DownloadClientError) {
    throw lastError;
  }

  if (isTimeoutError(lastError)) {
    throw new DownloadClientTimeoutError(clientName, (lastError as Error).message);
  }

  throw new DownloadClientError(
    clientName,
    getErrorMessage(lastError),
  );
}
