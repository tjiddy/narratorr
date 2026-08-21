import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import { getErrorMessage } from './error-message.js';

/** Reads back the scope the adapter rendered into the message, when the body supplied one. */
function scopeGuidance(message: string): string {
  const scope = /\bscope:\s*([^;)]+)/.exec(message)?.[1]?.trim();
  return scope
    ? `Your Hardcover API key is missing a required scope (${scope}). Regenerate the token with that scope enabled.`
    : 'Your Hardcover API key is missing a required scope. Regenerate the token with the scopes this feature needs.';
}

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
    // Ordered before the 401/403 arm, which would otherwise shadow it: an under-scoped token is
    // correctly typed, so telling the operator to re-paste their key is wrong guidance.
    if (error.message.includes('insufficient_scope')) {
      return scopeGuidance(error.message);
    }
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
