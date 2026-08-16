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

/**
 * The non-OK throw every fetching adapter raises, with the numeric status attached as an own
 * property. The message is operator text — `indexer-failure-state.ts` renders it on the health
 * card — so it stays byte-identical and the status travels beside it rather than inside it.
 * A classifier that parsed the message would rot on the first rewording, which is the same
 * identity loss `mapNetworkError` was fixed for in #2312.
 */
export function httpStatusError(status: number, statusText: string): Error {
  return Object.assign(new Error(`HTTP ${status}: ${statusText}`), { httpStatus: status });
}

function ownHttpStatus(value: unknown): number | undefined {
  if (!(value instanceof Error)) return undefined;
  const status = (value as Error & { httpStatus?: unknown }).httpStatus;
  return typeof status === 'number' ? status : undefined;
}

/** Own property first, then `.cause` — adapters wrap a transport throw in their own class. */
export function httpStatusOf(error: unknown): number | undefined {
  const own = ownHttpStatus(error);
  if (own !== undefined) return own;
  return error instanceof Error ? ownHttpStatus((error as Error & { cause?: unknown }).cause) : undefined;
}

/** Match typed proxy failures and legacy FlareSolverr-prefixed errors. */
export function isProxyRelatedError(error: unknown): boolean {
  if (error instanceof ProxyError) return true;
  if (error instanceof Error && error.message.startsWith('FlareSolverr')) return true;
  return false;
}
