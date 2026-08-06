import { serializeError, redactUrlsInText } from './serialize-error.js';

/**
 * Hard ceiling on a formatted error string, ellipsis included. Bulk-job failure rows are read in a
 * dropdown next to a toolbar button, not in a log viewer — a full undici message would blow the
 * layout apart and buries the diagnostic anyway.
 */
const MAX_LENGTH = 200;

/** The last-resort text, matching `getErrorMessage`'s convention for an empty stringification. */
const UNKNOWN = 'Unknown error';

/**
 * Format an unknown caught value as ONE short, redacted, bounded line suitable for a user-facing
 * job record (#2159). This is the single formatter behind every `BulkJobFailure.error` string — no
 * tick site formats its own text, so redaction and the length bound cannot be forgotten at one of
 * the five producer sites.
 *
 * It invents no new display policy; it composes two primitives this repo already ships and adds a
 * bound:
 *
 * 1. **Structure** — `serializeError` supplies a URL-redacted `message`, a verbatim `code`, and a
 *    depth-bounded, cycle-safe cause chain, so there is no traversal here.
 * 2. **Field-wise cause preference, one level** — `code` and `message` are each picked
 *    independently from `[cause, top-level]`. That is the precedence `getErrorMessageWithCause`
 *    already documents (undici surfaces a generic `fetch failed` on top and keeps the actionable
 *    diagnostic on `.cause`); picking per FIELD rather than per frame means a cause carrying only a
 *    `code` still composes against the top-level message instead of discarding it.
 * 3. **Compose** — `"<code>: <message>"`, unless the message already leads with the code (Node's
 *    `fs` errors read `ENOENT: no such file…` already, and `"ENOENT: ENOENT: no such file…"` is
 *    exactly the headline case this issue exists to surface).
 * 4. **Redact, then bound** — redaction runs on the FINAL composed string, not per field:
 *    `serializeError` sanitizes `message` but copies `code` verbatim, so a secret reachable through
 *    any field in any position is scrubbed exactly once, here.
 *
 * `stack` is never read at any step, so no frame text can reach the job record.
 */
export function toShortErrorText(value: unknown): string {
  const s = serializeError(value);
  const code = firstNonEmpty(s.cause?.code, s.code);
  const message = firstNonEmpty(s.cause?.message, s.message);
  return bound(redactUrlsInText(compose(code, message)));
}

/** First value that is non-empty after trimming, returned TRIMMED — or `null` when there is none. */
function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compose(code: string | null, message: string | null): string {
  if (code && message) return leadsWithCode(message, code) ? message : `${code}: ${message}`;
  return code ?? message ?? UNKNOWN;
}

/**
 * Does `message` already open with `code` as a standalone token? Compared by prefix rather than by
 * a regex built from `code` — a code is arbitrary text (it can even be a URL) and must never be
 * interpreted as a pattern.
 */
function leadsWithCode(message: string, code: string): boolean {
  if (!message.startsWith(code)) return false;
  const next = message[code.length];
  return next === undefined || !/[a-zA-Z0-9]/.test(next);
}

function bound(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  return `${text.slice(0, MAX_LENGTH - 1)}…`;
}
