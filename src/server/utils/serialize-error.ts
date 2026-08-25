import { sanitizeLogUrl } from './sanitize-log-url.js';
import { describeDbError } from '@shared/db-error.js';

export interface SerializedError {
  message: string;
  stack?: string | undefined;
  type: string;
  code?: string | undefined;
  cause?: SerializedError | undefined;
}

const MAX_CAUSE_DEPTH = 5;

// Transport errors embed URLs verbatim; stop before whitespace/quotes so surrounding prose survives.
// The `data:` arm is #2604: a base64 torrent URI decodes to an announce URL carrying the tracker
// passkey, and `sanitizeLogUrl` already knows how to collapse one — this regex just never fed it any.
const URL_IN_MESSAGE_RE =
  /(https?:\/\/[^\s'"<>`)]+|magnet:\?[^\s'"<>`)]+|data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+)/g;

/** Scrubs embedded web and magnet URLs after callers compose display text. */
export function redactUrlsInText(message: string): string {
  return message.replace(URL_IN_MESSAGE_RE, (match) => sanitizeLogUrl(match));
}

// Error.stack repeats the message and may contain module URLs, so scrub the whole stack.
function redactUrlsInStack(stack: string | undefined): string | undefined {
  if (!stack) return stack;
  return stack.replace(URL_IN_MESSAGE_RE, (match) => sanitizeLogUrl(match));
}

/** Keeps the frames, drops the message header the original stack opens with. */
function rebuildStack(sanitizedMessage: string, stack: string | undefined): string | undefined {
  if (!stack) return stack;
  const frames = stack.split('\n').filter((line) => /^\s+at /.test(line));
  return [sanitizedMessage, ...frames.map((frame) => redactUrlsInStack(frame) ?? frame)].join('\n');
}

/** Structures unknown catches for Pino and recursively redacts embedded URLs. */
export function serializeError(err: unknown): SerializedError {
  try {
    return serialize(err, new Set([err]), 0);
  } catch {
    // Serialization must never make logging throw.
    return { message: redactUrlsInText(String(err)), type: typeof err };
  }
}

function serialize(err: unknown, seen: Set<unknown>, depth: number): SerializedError {
  if (!(err instanceof Error)) {
    return { message: redactUrlsInText(String(err)), type: typeof err };
  }

  // The structured-log chokepoint (#2604 AC5). A driver query error's message is
  // `Failed query: <sql>\nparams: <bound values>`, and `Error.captureStackTrace` copies that whole
  // text into the stack's first line — so the stack has to be rebuilt, not merely redacted.
  const dbSummary = describeDbError(err);
  const result: SerializedError = dbSummary
    ? { message: dbSummary, stack: rebuildStack(dbSummary, err.stack), type: err.constructor.name }
    : {
        message: redactUrlsInText(err.message),
        stack: redactUrlsInStack(err.stack),
        type: err.constructor.name,
      };

  // Node/Undici diagnostics live in code; scrub it because code is not guaranteed symbolic.
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    result.code = redactUrlsInText(code);
  }

  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH && !seen.has(err.cause)) {
    seen.add(err.cause);
    result.cause = serialize(err.cause, seen, depth + 1);
  }

  return result;
}
