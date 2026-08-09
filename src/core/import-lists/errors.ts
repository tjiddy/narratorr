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
