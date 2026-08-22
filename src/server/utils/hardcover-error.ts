import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import { scopeGuidanceSentence } from '@core/utils/hardcover-http.js';
import { getErrorMessage } from './error-message.js';

/**
 * Reads one entry back out of the suffix `describeHardcoverErrorBody` rendered. Matching a whole
 * `<key>: ` entry at a `; ` boundary — rather than searching the message for the key anywhere — is
 * what keeps prose in a sibling field (`error_description: "retry with scope: admin"`) from being
 * mistaken for the dedicated field. The renderer neutralizes `;` inside values so the boundary
 * cannot be forged from upstream text.
 */
function renderedDetail(message: string, key: string): string | null {
  const prefix = `${key}: `;
  const entry = message.split('; ').find((part) => part.startsWith(prefix));
  if (entry === undefined) return null;
  return entry.slice(prefix.length).replace(/\)$/, '').trim() || null;
}

/**
 * Names a scope only when the body supplied the dedicated top-level field. The sentence itself is
 * the shared `scopeGuidanceSentence` (#2554) so this surface, the health check, and the
 * import-list Test button cannot drift apart; only the scope EXTRACTION differs here, because a
 * MetadataError carries the value in its rendered message rather than structurally.
 */
function scopeGuidance(message: string): string {
  return scopeGuidanceSentence(renderedDetail(message, 'scope'));
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
