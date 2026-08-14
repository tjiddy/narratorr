/**
 * Maps fetch, DNS, and timeout failures to actionable messages; unrelated errors pass through.
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

// Carry the transport code onto the mapped error: it is the only structural identity a
// caller has left once the cause is dropped, and failure classification keys on it (#2312).
function withCode(error: Error, code: string | undefined): Error {
  return code ? Object.assign(error, { code }) : error;
}

function mapFetchFailedCause(cause: Error & { code?: string }): Error {
  const code = cause.code ?? '';
  const mapper = CODE_MAP[code];
  if (mapper) return withCode(new Error(mapper(cause.message ?? '')), code);
  return withCode(new Error(cause.message || 'Network error'), cause.code);
}

/**
 * Redacts HTTP URLs before user-facing errors or logs can expose credential query parameters.
 * Torrent and Blackhole paths share this regex.
 */
export function redactUrlsFromMessage(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, '[redacted-url]');
}

export function mapNetworkError(error: unknown): Error {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return withCode(new Error('Request timed out'), 'ETIMEDOUT');
  }

  // Node fetch wraps network failures in `TypeError: fetch failed` with the real cause.
  if (error instanceof TypeError && error.message === 'fetch failed' && error.cause instanceof Error) {
    return mapFetchFailedCause(error.cause as Error & { code?: string });
  }

  // DNS preflight can throw a raw Errno-style error before undici wraps it.
  if (error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string') {
    return mapFetchFailedCause(error as Error & { code: string });
  }

  return error instanceof Error ? error : new Error(String(error));
}
