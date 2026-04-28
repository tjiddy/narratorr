/**
 * Thrown when an import-list provider returns a response whose shape does not match the
 * expected schema (HTML interstitial, rate-limit page, upstream API change, etc.).
 */
export class ImportListError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ImportListError';
  }
}
