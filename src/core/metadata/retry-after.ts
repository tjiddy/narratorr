/**
 * The single home for `Retry-After` interpretation on the metadata-provider side
 * (#1944 fixed Audnexus, #1948 brought Audible onto the same normalizer).
 *
 * Why one home: `MetadataService`'s backoff gate fails OPEN on a non-finite
 * window. `isRateLimited` starts with `if (!until) return false`, and `NaN` is
 * falsy — so a `NaN` window doesn't mis-time the gate, it kills it, and a
 * rate-limited provider keeps being hammered. The mirror failure is `Infinity`,
 * a deadline that never expires, which suppresses the provider for the life of
 * the process. Two adapters interpreting the same header two ways is exactly how
 * one of them ends up with the `parseInt`-only reading that produces both.
 *
 * Deliberately NOT shared with `src/client/lib/api/client.ts`'s
 * `parseRetryAfterMs`: that one answers a different question at a different
 * boundary — "may the UI show a retry hint?" (`number | undefined`, no fallback)
 * versus this side's "close the gate with a window the service can always
 * honor" (always finite, always non-negative). Coupling them would force one
 * contract to lie for the other.
 */

/** Fallback window when the header is absent, unparseable, negative, or overflows. */
export const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * A backoff window is only usable if it is finite and non-negative — every arm of
 * `parseRetryAfterMs` funnels its arithmetic RESULT through here so no branch can
 * return a window the caller cannot honor.
 *
 * The finiteness check must be on the product, not the operand: `1e306` written
 * out in digits is a perfectly finite Number, but `× 1000` overflows to
 * `Infinity`, and `setRateLimited(Date.now() + Infinity)` is a deadline that never
 * expires — a malformed-but-numeric upstream header would then suppress every
 * lookup against that provider for the life of the process.
 */
function finiteWindowMs(candidateMs: number): number {
  return Number.isFinite(candidateMs) && candidateMs >= 0 ? candidateMs : DEFAULT_RETRY_AFTER_MS;
}

/**
 * Normalize a `Retry-After` header to a FINITE, non-negative millisecond window.
 *
 * RFC 9110 permits both delay-seconds and an HTTP-date, and real servers send
 * either; a naive seconds-only read of the date form produces `NaN`. The
 * delay-seconds arm requires an all-digit token — `parseInt` tolerated trailing
 * garbage (`'120abc'` → 120000), and that stricter reading is intended, not a
 * regression. Absent, unparseable, negative, and overflowing values all fall back
 * to the same 60s default the absent-header case has always used.
 */
export function parseRetryAfterMs(header: string | null): number {
  const raw = header?.trim();
  if (!raw) return DEFAULT_RETRY_AFTER_MS;
  if (/^[+-]?\d+$/.test(raw)) return finiteWindowMs(Number(raw) * 1000);
  const dateMs = Date.parse(raw);
  if (Number.isNaN(dateMs)) return DEFAULT_RETRY_AFTER_MS;
  return finiteWindowMs(dateMs - Date.now());
}
