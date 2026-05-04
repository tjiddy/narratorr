import { sanitizeLogUrl } from './sanitize-log-url.js';

/** Serialized error shape safe for Pino JSON logging. */
export interface SerializedError {
  message: string;
  stack?: string | undefined;
  type: string;
  code?: string | undefined;
  cause?: SerializedError | undefined;
}

const MAX_CAUSE_DEPTH = 5;

// Match http(s) URLs and magnet URIs embedded in messages. Undici and other
// transport libraries write the failing URL into err.message verbatim; without
// redaction the AC7 URL-secrecy rule is violated by every caller that logs
// serializeError(error). The character class deliberately excludes whitespace
// and quotes so we don't gobble surrounding prose.
const URL_IN_MESSAGE_RE = /(https?:\/\/[^\s'"<>`)]+|magnet:\?[^\s'"<>`)]+)/g;

function redactUrlsInMessage(message: string): string {
  return message.replace(URL_IN_MESSAGE_RE, (match) => sanitizeLogUrl(match));
}

/**
 * Redact URLs in a stack trace. JavaScript's `Error.stack` always includes the
 * original message as its first line, so an undici-style fetch failure carries
 * the secret-bearing URL into the stack even after we redact `.message`. AC7
 * forbids that surface, so we apply the same scrubber to stack contents
 * (call-site frames also occasionally contain URLs in `at` lines, e.g. from
 * dynamic-import paths in module URLs — covered by the same pattern).
 */
function redactUrlsInStack(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  return stack.replace(URL_IN_MESSAGE_RE, (match) => sanitizeLogUrl(match));
}

/**
 * Serializes an unknown caught value into a Pino-safe object.
 *
 * Pino's built-in serializers only handle the `err` key with actual Error instances.
 * TypeScript `catch (error: unknown)` bindings logged as `{ error }` produce `"error":{}`
 * in JSON output. This helper extracts message, stack, type, and cause chain so the
 * information is preserved in structured logs.
 *
 * Also redacts URLs embedded in the message and recursively in cause messages —
 * so callers can log `serializeError(error)` without leaking apikey, session,
 * mam_id, or other secret-shaped query params from undici-wrapped failures.
 */
export function serializeError(err: unknown): SerializedError {
  try {
    return serialize(err, new Set([err]), 0);
  } catch {
    // Never-throw guarantee: if serialization itself fails, return a minimal result
    return { message: redactUrlsInMessage(String(err)), type: typeof err };
  }
}

function serialize(err: unknown, seen: Set<unknown>, depth: number): SerializedError {
  if (!(err instanceof Error)) {
    return { message: redactUrlsInMessage(String(err)), type: typeof err };
  }

  const result: SerializedError = {
    message: redactUrlsInMessage(err.message),
    stack: redactUrlsInStack(err.stack),
    type: err.constructor.name,
  };

  // Surface .code (undici/Node errors carry the diagnostic here:
  // UND_ERR_INVALID_ARG, ENOTFOUND, ECONNREFUSED). Without this, log readers
  // saw `fetch failed` with no actionable hint.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    result.code = code;
  }

  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH && !seen.has(err.cause)) {
    seen.add(err.cause);
    result.cause = serialize(err.cause, seen, depth + 1);
  }

  return result;
}
