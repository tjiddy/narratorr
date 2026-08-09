import type { ConnectorFieldErrors } from './types.js';

// HTTP/transport failure from listTargets or refreshImport. retryable drives service
// retries; routes and test() translate fieldErrors into results.
export class ConnectorRequestError extends Error {
  readonly retryable: boolean;
  readonly fieldErrors?: ConnectorFieldErrors;

  constructor(message: string, opts: { retryable: boolean; fieldErrors?: ConnectorFieldErrors }) {
    super(message);
    this.name = 'ConnectorRequestError';
    this.retryable = opts.retryable;
    if (opts.fieldErrors) this.fieldErrors = opts.fieldErrors;
  }
}
