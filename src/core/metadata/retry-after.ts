/**
 * Provider parsing always returns a finite, non-negative backoff window. Keep this
 * separate from the client parser, whose UI-hint contract permits `undefined`.
 */

/** Fallback window when the header is absent, unparseable, negative, or overflows. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;

/** Check finiteness on the converted product; a finite seconds operand can overflow. */
function finiteWindowMs(candidateMs: number): number {
  return Number.isFinite(candidateMs) && candidateMs >= 0 ? candidateMs : DEFAULT_RETRY_AFTER_MS;
}

/**
 * Parses RFC delay-seconds or HTTP-date. Delay-seconds must be an integer token;
 * absent, malformed, negative, past, or overflowing values use the default.
 */
export function parseRetryAfterMs(header: string | null): number {
  const raw = header?.trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  if (/^[+-]?\d+$/.test(raw)) return finiteWindowMs(Number(raw) * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return DEFAULT_RETRY_AFTER_MS;
  return finiteWindowMs(dateMs - Date.now());
}
