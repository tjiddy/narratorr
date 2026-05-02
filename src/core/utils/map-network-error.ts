/**
 * Maps low-level network errors (fetch failures, DNS, timeouts) to
 * actionable user-facing messages.
 *
 * Returns the original error unchanged if it's not a network-level failure.
 */

type CauseMapper = (causeMsg: string) => string;

const CODE_MAP: Record<string, CauseMapper> = {
  ECONNREFUSED: (msg) => {
    const portMatch = msg.match(/:(\d+)$/);
    return `Connection refused on port ${portMatch ? portMatch[1] : 'unknown'}`;
  },
  ENOTFOUND: (msg) => {
    const hostMatch = msg.match(/ENOTFOUND\s+(.+)/);
    return `DNS resolution failed for ${hostMatch ? hostMatch[1] : 'unknown host'}`;
  },
  UND_ERR_CONNECT_TIMEOUT: () => 'Connection timed out',
  ETIMEDOUT: () => 'Connection timed out',
  ECONNRESET: () => 'Connection reset by server',
  UND_ERR_HEADERS_TIMEOUT: () => 'Server stopped responding before sending headers',
  UND_ERR_BODY_TIMEOUT: () => 'Server stopped responding mid-response',
  UND_ERR_RESPONSE_EXCEEDED_SIZE: () => 'Response exceeded size limit',
};

function mapFetchFailedCause(cause: Error & { code?: string }): Error {
  const code = cause.code ?? '';
  const mapper = CODE_MAP[code];
  if (mapper) return new Error(mapper(cause.message ?? ''));
  return new Error(cause.message || 'Network error');
}

export function mapNetworkError(error: unknown): Error {
  // AbortError from manual AbortController.abort()
  // TimeoutError from AbortSignal.timeout() (Node 18+)
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new Error('Request timed out');
  }

  // TypeError: fetch failed — Node wraps network errors as TypeError with a cause
  if (error instanceof TypeError && error.message === 'fetch failed' && error.cause instanceof Error) {
    return mapFetchFailedCause(error.cause as Error & { code?: string });
  }

  // Direct Error with .code — DNS/connection failures that bypass undici (e.g., SSRF DNS preflight
  // throws raw Errno-style Error from node:dns/promises before any fetch wrapping)
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return mapFetchFailedCause(error as Error & { code: string });
  }

  // Not a network error — return as-is
  return error instanceof Error ? error : new Error(String(error));
}
