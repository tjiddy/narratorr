import type { ConnectorFieldErrors } from './types.js';

/**
 * Thrown by `listTargets()` and `refreshImport()` on any HTTP/transport failure.
 *
 * The service classifies retry on `retryable` (transport/DNS/timeout/5xx => true;
 * 4xx/auth/bad-id => false); routes translate it into the field-scoped envelope;
 * `test()` catches it internally and folds it into `ConnectorTestResult`.
 */
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
