export class DownloadClientError extends Error {
  constructor(
    public readonly clientName: string,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message || `Download client error: ${clientName}`, options);
    this.name = 'DownloadClientError';
  }
}

export class DownloadClientAuthError extends DownloadClientError {
  constructor(clientName: string, message?: string, options?: ErrorOptions) {
    super(clientName, message || `Authentication failed for download client: ${clientName}`, options);
    this.name = 'DownloadClientAuthError';
  }
}

export class DownloadClientTimeoutError extends DownloadClientError {
  constructor(clientName: string, message?: string, options?: ErrorOptions) {
    super(clientName, message || `Request timed out for download client: ${clientName}`, options);
    this.name = 'DownloadClientTimeoutError';
  }
}

export function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'Request timed out' || error.message === 'Connection timed out';
}
