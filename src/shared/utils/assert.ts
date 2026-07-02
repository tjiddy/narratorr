// Use at: §3.4 modulo, §3.6 registry fallback, §4.2 WHERE-bound .returning()
// (developer-convention sites where a runtime check is cheap insurance against
// assumption drift). NOT for §3.1 regex captures, §3.2/§3.3 length-checked
// access, §3.5 for-loop bounded index, or §3.8 pre-pushed accumulator — those
// are structurally safe and the bang carries no risk.

/**
 * Assert a value is neither null nor undefined. Replaces `value!` at sites
 * where the value comes from a fallible lookup (Record fallback, optional
 * config, etc.).
 */
export function requireDefined<T>(value: T | undefined | null, msg: string): T {
  if (value === undefined || value === null) throw new Error(msg);
  return value;
}
