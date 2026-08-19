import type { ConnectorFieldErrors } from './types.js';
import { classifyFailure } from '../utils/failure-classification.js';
import { getErrorMessage } from '@shared/error-message.js';

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

/** The message strings and fieldErrors keys each connector owns for itself. */
export interface ConnectorStatusPresentation {
  authField: string;
  authFieldError: string;
  authMessage: (status: number) => string;
  notFoundMessage: (status: number) => string;
  notFoundFieldError: string;
}

/**
 * Build the connector's status error from the shared terminal/transient verdict (#2312).
 * The verdict is single-homed in `classifyFailure`; only presentation is per-connector.
 */
export function connectorStatusError(
  status: number,
  notFoundField: string | null,
  presentation: ConnectorStatusPresentation,
): ConnectorRequestError {
  const retryable = !classifyFailure({ httpStatus: status }).terminal;

  if (status === 401 || status === 403) {
    return new ConnectorRequestError(presentation.authMessage(status), {
      retryable,
      fieldErrors: { [presentation.authField]: presentation.authFieldError },
    });
  }
  if (status === 404 && notFoundField) {
    return new ConnectorRequestError(presentation.notFoundMessage(status), {
      retryable,
      fieldErrors: { [notFoundField]: presentation.notFoundFieldError },
    });
  }
  return new ConnectorRequestError(
    status >= 500 ? `Server error (HTTP ${status})` : `Request failed (HTTP ${status})`,
    { retryable },
  );
}

/**
 * The connector's verdict for a request that never completed (#2317). Deliberately NOT routed
 * through `classifyFailure`: a transport error carrying a terminal code (EAUTH, ETLS) would
 * then be reported non-retryable, and a connector that could not reach the server has learned
 * nothing about whether retrying will help. `retryable` stays unconditionally true.
 */
export function connectorConnectionError(error: unknown): ConnectorRequestError {
  return new ConnectorRequestError(`Connection failed: ${getErrorMessage(error)}`, {
    retryable: true,
    fieldErrors: { baseUrl: 'Could not connect to server' },
  });
}
