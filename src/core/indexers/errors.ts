export class IndexerAuthError extends Error {
  constructor(
    public readonly indexerName: string,
    message?: string,
  ) {
    super(message || `Authentication failed for indexer: ${indexerName}`);
    this.name = 'IndexerAuthError';
  }
}
