export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly provider: string,
  ) {
    super(`${provider} rate limit exceeded, retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
  }
}

export class TransientError extends Error {
  constructor(
    public readonly provider: string,
    context: string,
  ) {
    super(`${provider} transient failure: ${context}`);
    this.name = 'TransientError';
  }
}

/**
 * Thrown when a metadata provider returns a response whose shape does not match the
 * expected schema (HTML interstitial, rate-limit page, upstream API change, etc.).
 * Not retryable — distinct from TransientError/RateLimitError.
 */
export class MetadataError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MetadataError';
  }
}
