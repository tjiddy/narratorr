import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import { getErrorMessage } from './error-message.js';

// Keep settings-test and health-check guidance identical.
export function mapHardcoverError(error: unknown): string {
  if (error instanceof RateLimitError) {
    const seconds = Math.ceil(error.retryAfterMs / 1000);
    return `Hardcover is rate-limiting requests. Try again in ${seconds}s.`;
  }
  if (error instanceof TransientError) {
    return "Couldn't reach Hardcover. Check your network and try again.";
  }
  if (error instanceof MetadataError) {
    // Hardcover may bury auth failures in a 200 GraphQL envelope; also recognize transport 401/403.
    if (
      error.message.includes('401') ||
      error.message.includes('403') ||
      /malformed authorization|could not verify jwt|invalid.+token|unauthorized/i.test(error.message)
    ) {
      return 'Invalid Hardcover API key. (If you copied from the Hardcover docs, drop the "Bearer " prefix.)';
    }
    return error.message;
  }
  return getErrorMessage(error);
}
