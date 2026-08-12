import { serializeError, redactUrlsInText } from './serialize-error.js';

// Bulk-job errors render in a compact dropdown; this ceiling includes the ellipsis.
const MAX_LENGTH = 200;

const UNKNOWN = 'Unknown error';

/**
 * Format bulk-job failures as one bounded, redacted line. Prefer cause code and message
 * independently, avoid duplicate code prefixes, then redact the composed string before
 * truncating. Never read stack text.
 */
export function toShortErrorText(value: unknown): string {
  const s = serializeError(value);
  const code = firstNonEmpty(s.cause?.code, s.code);
  const message = firstNonEmpty(s.cause?.message, s.message);
  return bound(redactUrlsInText(compose(code, message)));
}

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

// Error codes are arbitrary text, so never interpolate one into a regular expression.
function leadsWithCode(message: string, code: string): boolean {
  if (!message.startsWith(code)) return false;
  const next = message[code.length];
  return next === undefined || !/[a-zA-Z0-9]/.test(next);
}

function bound(text: string): string {
  if (text.length <= MAX_LENGTH) return text;
  return `${text.slice(0, MAX_LENGTH - 1)}…`;
}
