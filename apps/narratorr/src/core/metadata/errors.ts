export class RateLimitError extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly provider: string,
  ) {
    super(`${provider} rate limit exceeded, retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
  }
}
