/**
 * Maps low-level network errors (fetch failures, DNS, timeouts) to
 * actionable user-facing messages.
 *
 * Returns the original error unchanged if it's not a network-level failure.
 */
export function mapNetworkError(error: unknown): Error {
  // AbortError from AbortSignal.timeout()
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new Error('Request timed out');
  }

  // TypeError: fetch failed — Node wraps network errors as TypeError with a cause
  if (error instanceof TypeError && error.message === 'fetch failed' && error.cause instanceof Error) {
    const cause = error.cause as Error & { code?: string };
    const code = cause.code ?? '';
    const causeMsg = cause.message ?? '';

    switch (code) {
      case 'ECONNREFUSED': {
        // Extract port from message like "connect ECONNREFUSED 127.0.0.1:9999"
        const portMatch = causeMsg.match(/:(\d+)$/);
        const port = portMatch ? portMatch[1] : 'unknown';
        return new Error(`Connection refused on port ${port}`);
      }
      case 'ENOTFOUND': {
        // Extract hostname from message like "getaddrinfo ENOTFOUND badhost.example"
        const hostMatch = causeMsg.match(/ENOTFOUND\s+(.+)/);
        const host = hostMatch ? hostMatch[1] : 'unknown host';
        return new Error(`DNS resolution failed for ${host}`);
      }
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'ETIMEDOUT':
        return new Error('Connection timed out');
      case 'ECONNRESET':
        return new Error('Connection reset by server');
      default:
        // Unknown cause code — surface the cause message
        return new Error(causeMsg || 'Network error');
    }
  }

  // Not a network error — return as-is
  return error instanceof Error ? error : new Error(String(error));
}
