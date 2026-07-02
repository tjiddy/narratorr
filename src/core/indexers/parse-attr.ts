/**
 * Parse an indexer attr that should be a finite number; absent/garbage → undefined.
 *
 * Uses `Number.isFinite` (not `!Number.isNaN`) so non-finite values also map to
 * absent — e.g. `Number('1e999') === Infinity` — mirroring the reasoning in
 * `src/client/components/manual-import/BookEditModal.tsx`.
 *
 * Blank/whitespace-only strings are treated as absent (`undefined`) rather than
 * `0`, since `Number('')`/`Number('   ')` would otherwise coerce to `0`.
 */
export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
