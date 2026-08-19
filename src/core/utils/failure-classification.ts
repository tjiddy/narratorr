/**
 * The single home for "is this delivery failure terminal or transient" (#2312).
 *
 * Terminal means no retry schedule can succeed and only the operator can fix it; transient
 * means retrying will probably work. The two demand opposite responses — backing off a
 * terminal failure hides it, surfacing a transient one is a false alarm — so the decision
 * lives here once and is consumed by the media-server connectors and every notifier
 * transport. Consumers keep their own message strings; only the verdict is shared.
 */

/** Independent, all-optional discriminants. Absence of every one of them is legal. */
export interface FailureDescriptor {
  /** `response.status` from a fetch-based adapter or connector. */
  httpStatus?: number | undefined;
  /** Nodemailer's `err.responseCode`, parsed from the SMTP reply. */
  smtpReplyCode?: number | undefined;
  /** Nodemailer's `err.code`, or a Node/undici transport code (see map-network-error.ts). */
  errorCode?: string | undefined;
  /** The `script` adapter's `execFile` outcome. */
  exitCode?: number | null | undefined;
  killed?: boolean | undefined;
}

export interface FailureVerdict {
  terminal: boolean;
  /** Operator language, safe to render on a health card — never a raw code. */
  reason: string;
}

const AUTH_REJECTED = 'authentication rejected — check credentials';
const SMTP_ADDRESS_REJECTED = 'the mail server rejected the recipient or sender address';
const SMTP_MESSAGE_REJECTED = 'the mail server permanently rejected the message';
const TLS_REJECTED = "TLS/certificate rejected — check the TLS setting and the server's certificate";
const ENVELOPE_REJECTED = 'sender or recipient address rejected';
const MESSAGE_REJECTED = 'the server rejected the message itself';
const MISCONFIGURED = 'misconfiguration — check the notifier settings';
const REQUEST_REJECTED = 'the server rejected the request';
const DESTINATION_NOT_FOUND = 'the destination was not found';

// Domain-neutral: this vocabulary is now shared by notifier delivery and indexer search (#2376),
// so the generic fallback names the destination rather than one of its consumers.
const TRANSIENT_UNREACHABLE = 'the server could not be reached';
const TRANSIENT_SERVER = 'the server reported a temporary error';
const TRANSIENT_TIMEOUT = 'the request timed out';
const TRANSIENT_RATE_LIMIT = 'the server is rate-limiting requests';
const TRANSIENT_MAIL = 'the mail server reported a temporary problem';

// Nodemailer publishes a closed catalogue in lib/errors.js. Only the permanent half is
// enumerated: anything absent falls through to transient, so one flaky DNS lookup or a
// future code we have never seen cannot stop a channel.
const TERMINAL_ERROR_CODES: Record<string, string> = {
  EAUTH: AUTH_REJECTED,
  ENOAUTH: AUTH_REJECTED,
  EOAUTH2: AUTH_REJECTED,
  ETLS: TLS_REJECTED,
  EREQUIRETLS: TLS_REJECTED,
  EENVELOPE: ENVELOPE_REJECTED,
  // Terminal rather than per-message: notification bodies are small and near-identical
  // every time, so a server that rejects one rejects them all.
  EMESSAGE: MESSAGE_REJECTED,
  ECONFIG: MISCONFIGURED,
  EFILEACCESS: MISCONFIGURED,
  EURLACCESS: MISCONFIGURED,
};

// Transient codes worth naming precisely. A socket-level timeout is the same story to an
// operator as an HTTP 408, so it gets the same reason rather than the generic fallback —
// which also means losing the descriptor visibly degrades the message, not just the field.
const TRANSIENT_ERROR_REASONS: Record<string, string> = {
  ETIMEDOUT: TRANSIENT_TIMEOUT,
  UND_ERR_CONNECT_TIMEOUT: TRANSIENT_TIMEOUT,
  UND_ERR_HEADERS_TIMEOUT: TRANSIENT_TIMEOUT,
  UND_ERR_BODY_TIMEOUT: TRANSIENT_TIMEOUT,
};

// RFC 5321's own permanent/transient split, plus the reply codes worth naming precisely.
const SMTP_PERMANENT_REASONS: Record<number, string> = {
  530: AUTH_REJECTED,
  535: AUTH_REJECTED,
  550: SMTP_ADDRESS_REJECTED,
  551: SMTP_ADDRESS_REJECTED,
  553: SMTP_ADDRESS_REJECTED,
  554: SMTP_ADDRESS_REJECTED,
};

function transient(reason: string): FailureVerdict {
  return { terminal: false, reason };
}

function terminal(reason: string): FailureVerdict {
  return { terminal: true, reason };
}

function classifySmtpReply(code: number): FailureVerdict {
  if (code >= 500 && code < 600) return terminal(SMTP_PERMANENT_REASONS[code] ?? SMTP_MESSAGE_REJECTED);
  if (code >= 400 && code < 500) return transient(TRANSIENT_MAIL);
  // A reply code outside both ranges is not a verdict we can read; do not guess terminal.
  return transient(TRANSIENT_UNREACHABLE);
}

function classifyHttpStatus(status: number): FailureVerdict {
  if (status === 401 || status === 403) return terminal(AUTH_REJECTED);
  if (status === 404) return terminal(DESTINATION_NOT_FOUND);
  if (status === 408) return transient(TRANSIENT_TIMEOUT);
  if (status === 429) return transient(TRANSIENT_RATE_LIMIT);
  if (status >= 500) return transient(TRANSIENT_SERVER);
  if (status >= 400) return terminal(REQUEST_REJECTED);
  return transient(TRANSIENT_UNREACHABLE);
}

/**
 * Precedence — first present wins: `smtpReplyCode` → `httpStatus` → `errorCode` → transient.
 * Nodemailer often sets both a reply code and a structural code; the reply code is the
 * server's own verdict and is authoritative.
 */
export function classifyFailure(descriptor?: FailureDescriptor | null): FailureVerdict {
  if (!descriptor || typeof descriptor !== 'object') return transient(TRANSIENT_UNREACHABLE);
  if (typeof descriptor.smtpReplyCode === 'number') return classifySmtpReply(descriptor.smtpReplyCode);
  if (typeof descriptor.httpStatus === 'number') return classifyHttpStatus(descriptor.httpStatus);
  if (typeof descriptor.errorCode === 'string') {
    const reason = TERMINAL_ERROR_CODES[descriptor.errorCode];
    if (reason) return terminal(reason);
    return transient(TRANSIENT_ERROR_REASONS[descriptor.errorCode] ?? TRANSIENT_UNREACHABLE);
  }
  return transient(TRANSIENT_UNREACHABLE);
}

function structuralCode(error: unknown): string | undefined {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'ETIMEDOUT';
  }
  if (!(error instanceof Error)) return undefined;
  const own = (error as Error & { code?: unknown }).code;
  if (typeof own === 'string') return own;
  // Node fetch wraps network failures in `TypeError: fetch failed` with the real cause.
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && typeof (cause as Error & { code?: unknown }).code === 'string') {
    return (cause as Error & { code: string }).code;
  }
  return undefined;
}

/** Structural identity for a fetch/transport throw. Empty when the error carries none. */
export function describeTransportError(error: unknown): FailureDescriptor {
  const errorCode = structuralCode(error);
  return errorCode === undefined ? {} : { errorCode };
}

/** Structural identity for a Nodemailer throw: the reply code plus its own error code. */
export function describeSmtpError(error: unknown): FailureDescriptor {
  const descriptor: FailureDescriptor = {};
  if (error instanceof Error) {
    const replyCode = (error as Error & { responseCode?: unknown }).responseCode;
    if (typeof replyCode === 'number') descriptor.smtpReplyCode = replyCode;
  }
  const errorCode = structuralCode(error);
  if (errorCode !== undefined) descriptor.errorCode = errorCode;
  return descriptor;
}
