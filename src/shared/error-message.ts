import { describeDbError } from './db-error.js';

/**
 * The repo's untyped-error→text chokepoint: every operator- and client-facing string — response
 * bodies, SSE payloads, durable `book_events.reason` / `downloads.error_message`, notifier bodies,
 * service result-unions — is rendered here.
 *
 * The DB arm is the #2604 passkey fix (AC6). A `DrizzleQueryError`'s own message embeds every bound
 * param, including the `data:` torrent URI whose decoded announce URL carries the tracker passkey,
 * so it can never be published raw. Guarded because this runs inside other people's catch blocks:
 * a describer fault must fall through to the ordinary rendering, not replace someone's failure with
 * an error-handler failure.
 */
export function getErrorMessage(error: unknown): string {
  try {
    const dbSummary = describeDbError(error);
    if (dbSummary !== null) return dbSummary;
  } catch {
    // Fall through to the pre-#2604 behaviour.
  }
  if (error instanceof Error) return error.message;
  const str = String(error);
  return str || 'Unknown error';
}

/**
 * Undici wraps useful network diagnostics in Error.cause.
 *
 * The DB arm is here for the same reason it is on `getErrorMessage`: this is the file's OTHER
 * untyped-error→text renderer, and its `error.message` tail is reached whenever the cause carries
 * neither `message` nor `code` — which for a driver error would publish the bound params.
 */
export function getErrorMessageWithCause(error: unknown): string {
  try {
    const dbSummary = describeDbError(error);
    if (dbSummary !== null) return dbSummary;
  } catch {
    // Fall through to the pre-#2604 behaviour.
  }
  if (error instanceof Error) {
    const cause = error.cause as { message?: string; code?: string } | undefined;
    return cause?.message ?? cause?.code ?? error.message;
  }
  const str = String(error);
  return str || 'Unknown error';
}

// Drizzle/libSQL may nest SQLite diagnostics in cause.message. Test cause and
// top-level independently instead of choosing one.
export function isUniqueViolation(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof Error)) return false;
  const causeMsg = (error as Error & { cause?: { message?: string } }).cause?.message ?? '';
  if (pattern.test(causeMsg)) return true;
  return pattern.test(error.message ?? '');
}
