/**
 * Normalize an unknown caught value into a real `Error` instance.
 *
 * Symmetric counterpart to `serializeError`: that helper exits at log sites,
 * this one normalizes at catch sites so downstream consumers can rely on
 * `Error`-shaped values (real stack, real message, throwability).
 *
 * For non-Error values we coerce via `String(value)` — matching the long-standing
 * `serializeError`/`String(...)` convention. Plain objects therefore yield
 * `'[object Object]'`; richer field extraction is intentionally out of scope.
 */
export function ensureError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}
