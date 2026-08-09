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

/** Non-auth indexer failure, including response validation. */
export class IndexerError extends Error {
  constructor(
    public readonly indexerName: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message || `Indexer error: ${indexerName}`, options);
    this.name = 'IndexerError';
  }
}

/** Proxy transport or handshake failure, never an upstream indexer HTTP error. */
export class ProxyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProxyError';
  }
}

/** Match typed proxy failures and legacy FlareSolverr-prefixed errors. */
export function isProxyRelatedError(error: unknown): boolean {
  if (error instanceof ProxyError) return true;
  if (error instanceof Error && error.message.startsWith('FlareSolverr')) return true;
  return false;
}
