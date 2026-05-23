export class IndexerAuthError extends Error {
  constructor(
    public readonly indexerName: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message || `Authentication failed for indexer: ${indexerName}`, options);
    this.name = 'IndexerAuthError';
  }
}

/**
 * Thrown for indexer response shape mismatches and other non-auth indexer failures.
 * Distinct from IndexerAuthError (auth-specific) and ProxyError (proxy transport).
 *
 * `wedgeOutcome` is set by adapters (currently MAM) when the error originated
 * from the freeleech-wedge spend path or the subsequent torrent fetch, so the
 * service layer can pick log severity based on whether a wedge was consumed.
 */
export class IndexerError extends Error {
  public wedgeOutcome?: import('./types.js').WedgeOutcome;

  constructor(
    public readonly indexerName: string,
    message?: string,
    options?: ErrorOptions & { wedgeOutcome?: import('./types.js').WedgeOutcome },
  ) {
    super(message || `Indexer error: ${indexerName}`, options);
    this.name = 'IndexerError';
    if (options?.wedgeOutcome) this.wedgeOutcome = options.wedgeOutcome;
  }
}

/**
 * Thrown for proxy transport/handshake failures (connection refused, timeout, proxy HTTP errors).
 * NOT thrown for upstream indexer HTTP errors that happen to travel through a proxy.
 */
export class ProxyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
