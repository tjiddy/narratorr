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
