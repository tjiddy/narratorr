export class IndexerAuthError extends Error {
  constructor(
    public readonly indexerName: string,
    message?: string,
  ) {
    super(message || `Authentication failed for indexer: ${indexerName}`);
    this.name = 'IndexerAuthError';
  }
}

/**
 * Thrown for proxy transport/handshake failures (connection refused, timeout, proxy HTTP errors).
 * NOT thrown for upstream indexer HTTP errors that happen to travel through a proxy.
 */
export class ProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

/**
 * Centralized check for proxy-related errors — covers both standard ProxyError
 * and FlareSolverr errors (which prefix messages with "FlareSolverr").
 */
export function isProxyRelatedError(error: unknown): boolean {
  if (error instanceof ProxyError) return true;
  if (error instanceof Error && error.message.startsWith('FlareSolverr')) return true;
  return false;
}
