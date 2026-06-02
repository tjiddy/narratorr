import { RateLimitError, TransientError, MetadataError } from '../../core/metadata/errors.js';
import { getErrorMessage } from './error-message.js';

/**
 * Map a Hardcover probe failure to an actionable, user-facing message. Shared by
 * the settings Test button (`POST /api/settings/metadata/hardcover/test`) and the
 * `hardcover` health check so both surfaces give the same guidance.
 */
export function mapHardcoverError(error: unknown): string {
  if (error instanceof RateLimitError) {
    const seconds = Math.ceil(error.retryAfterMs / 1000);
    return `Hardcover is rate-limiting requests. Try again in ${seconds}s.`;
  }
  if (error instanceof TransientError) {
    return "Couldn't reach Hardcover. Check your network and try again.";
  }
  if (error instanceof MetadataError) {
    // Hardcover's GraphQL endpoint typically returns HTTP 200 with the auth
    // failure buried in the response envelope ("Malformed Authorization header",
    // "Could not verify JWT: ..."). The HTTP 401/403 substring branch still
    // covers the network-layer failure mode; the regex covers the GraphQL one.
    // Both branches return the same Bearer-prefix hint — see #1138 Bug 2.
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
